import { strict as assert } from "node:assert";
import { join } from "node:path";
import { runOwnedProcess } from "../../src/runner/process.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(path: string) {
  for (let n = 0; n < 300; n++) {
    try {
      if ((await Deno.stat(path)).size > 0) return;
    } catch { /* ещё нет */ }
    await pause(10);
  }
  throw new Error(`Нет readiness: ${path}`);
}
Deno.test("owned process streams early output, preserves numeric 7 and unavailable resources", async () => {
  const root = await Deno.makeTempDir();
  try {
    const forwarded: string[] = [], errors: string[] = [];
    const run = runOwnedProcess({
      executable: Deno.execPath(),
      args: [
        "eval",
        "console.log('early');console.error('error');await new Promise(r=>setTimeout(r,500));Deno.exit(7)",
      ],
      cwd: root,
      env: Deno.env.toObject(),
      stdoutPath: join(root, "out"),
      stderrPath: join(root, "err"),
      timeExecutable: join(root, "missing-gnu-time"),
      stdout: new WritableStream({
        write(chunk) {
          forwarded.push(new TextDecoder().decode(chunk));
        },
      }),
      stderr: new WritableStream({
        write(chunk) {
          errors.push(new TextDecoder().decode(chunk));
        },
      }),
    });
    await waitFor(join(root, "out"));
    assert.match(await Deno.readTextFile(join(root, "out")), /early/);
    const result = await run;
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal(result.cpuUserSeconds, null);
    assert.equal(result.cpuSystemSeconds, null);
    assert.equal(result.peakRssKiB, null);
    assert.match(await Deno.readTextFile(join(root, "err")), /error/);
    assert.equal(forwarded.join(""), "early\n");
    assert.equal(errors.join(""), "error\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("owned process captures large output without truncation and measures GNU time", async () => {
  const root = await Deno.makeTempDir();
  try {
    const result = await runOwnedProcess({
      executable: Deno.execPath(),
      args: ["eval", "await Deno.stdout.write(new Uint8Array(2_000_000).fill(120))"],
      cwd: root,
      env: Deno.env.toObject(),
      stdoutPath: join(root, "out"),
      stderrPath: join(root, "err"),
      stdout: new WritableStream({ write() {} }),
    });
    assert.equal(result.code, 0);
    assert.equal((await Deno.stat(join(root, "out"))).size, 2_000_000);
    assert.equal(typeof result.cpuUserSeconds, "number");
    assert(result.peakRssKiB! > 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  Deno.test(`owned group ${signal} stops grandchild heartbeat while neighbor survives`, async () => {
    const root = await Deno.makeTempDir();
    const heartbeat = join(root, "beat"), neighbor = join(root, "neighbor");
    const source = (path: string) =>
      `setInterval(()=>Deno.writeTextFileSync(${JSON.stringify(path)},'x',{append:true}),15)`;
    const other = new Deno.Command(Deno.execPath(), {
      args: ["eval", source(neighbor)],
      stdout: "null",
      stderr: "null",
    }).spawn();
    const abort = new AbortController();
    try {
      const result = runOwnedProcess({
        executable: Deno.execPath(),
        args: [
          "eval",
          `new Deno.Command(Deno.execPath(),{args:['eval',${
            JSON.stringify(source(heartbeat))
          }],stdout:'inherit',stderr:'inherit'}).spawn();await new Promise(()=>{});`,
        ],
        cwd: root,
        env: Deno.env.toObject(),
        stdoutPath: join(root, "out"),
        stderrPath: join(root, "err"),
        abortSignal: abort.signal,
      });
      await waitFor(heartbeat);
      await waitFor(neighbor);
      abort.abort(signal);
      const outcome = await result;
      assert.equal(outcome.signal, signal);
      assert.equal(outcome.escalated, false);
      const before = (await Deno.stat(heartbeat)).size, adjacent = (await Deno.stat(neighbor)).size;
      await pause(100);
      assert.equal((await Deno.stat(heartbeat)).size, before);
      assert((await Deno.stat(neighbor)).size > adjacent);
    } finally {
      other.kill("SIGKILL");
      await other.status;
      await Deno.remove(root, { recursive: true });
    }
  });
}
Deno.test("early abort queues until owned group readiness; stubborn tree escalation is recorded", async () => {
  const root = await Deno.makeTempDir();
  try {
    const controller = new AbortController();
    controller.abort("SIGTERM");
    const result = await runOwnedProcess({
      executable: Deno.execPath(),
      args: ["eval", "setInterval(()=>{},100)"],
      cwd: root,
      env: Deno.env.toObject(),
      stdoutPath: join(root, "out"),
      stderrPath: join(root, "err"),
      abortSignal: controller.signal,
    });
    assert.equal(result.signal, "SIGTERM");
    const ready = join(root, "ready"), abort = new AbortController();
    const run = runOwnedProcess({
      executable: Deno.execPath(),
      args: [
        "eval",
        `Deno.addSignalListener('SIGTERM',()=>{});Deno.writeTextFileSync(${
          JSON.stringify(ready)
        },'yes');setInterval(()=>{},100);`,
      ],
      cwd: root,
      env: Deno.env.toObject(),
      stdoutPath: join(root, "out2"),
      stderrPath: join(root, "err2"),
      abortSignal: abort.signal,
      graceMilliseconds: 150,
    });
    await waitFor(ready);
    abort.abort("SIGTERM");
    const outcome = await run;
    assert.equal(outcome.escalated, true);
    assert.equal(outcome.signal, "SIGKILL");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("redirected stdin and PTY interaction preserve terminal output journals", async () => {
  const root = await Deno.makeTempDir();
  const module = new URL("../../src/runner/process.ts", import.meta.url).href;
  try {
    const entry = join(root, "runner.ts");
    const payload =
      `const line = new Uint8Array(64);console.log('prompt:'+Deno.stdin.isTerminal()+':'+Deno.stdout.isTerminal());const n=await Deno.stdin.read(line);console.log('answer:'+new TextDecoder().decode(line.subarray(0,n??0)).trim());console.error('terminal-error');`;
    await Deno.writeTextFile(
      entry,
      `import {runOwnedProcess} from ${
        JSON.stringify(module)
      };await runOwnedProcess({executable:Deno.execPath(),args:['eval',${
        JSON.stringify(payload)
      }],cwd:${JSON.stringify(root)},env:Deno.env.toObject(),stdoutPath:${
        JSON.stringify(join(root, "out"))
      },stderrPath:${JSON.stringify(join(root, "err"))}});`,
    );
    for (const terminal of [false, true]) {
      const argv = [Deno.execPath(), "run", "-A", entry];
      const child = new Deno.Command(terminal ? "script" : argv[0], {
        args: terminal
          ? [
            "-qefc",
            argv.map((s) => "'" + s.replaceAll("'", "'\\''") + "'").join(" "),
            "/dev/null",
          ]
          : argv.slice(1),
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode("hello\n"));
      await writer.close();
      const out = await child.output();
      assert(out.success, new TextDecoder().decode(out.stderr));
      const log = await Deno.readTextFile(join(root, "out"));
      assert.match(log, new RegExp(`prompt:${terminal}:${terminal}`));
      assert.match(log, /answer:hello/);
      assert.match(await Deno.readTextFile(join(root, terminal ? "out" : "err")), /terminal-error/);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("mixed terminal redirects retain each fd type and separate journals", async () => {
  const root = await Deno.makeTempDir();
  const module = new URL("../../src/runner/process.ts", import.meta.url).href;
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  try {
    const entry = join(root, "mixed.ts"), redirect = join(root, "redirect");
    await Deno.writeTextFile(
      entry,
      `import {runOwnedProcess} from ${
        JSON.stringify(module)
      };await runOwnedProcess({executable:Deno.execPath(),args:['eval',"console.log('OUT:'+Deno.stdout.isTerminal());console.error('ERR:'+Deno.stderr.isTerminal())"],cwd:${
        JSON.stringify(root)
      },env:{...Deno.env.toObject(),SHELL:"/nonexistent/shell"},stdoutPath:${
        JSON.stringify(join(root, "out"))
      },stderrPath:${JSON.stringify(join(root, "err"))}});`,
    );
    for (const fd of [1, 2]) {
      const command = [Deno.execPath(), "run", "-A", entry].map(quote).join(" ") +
        ` ${fd}>${quote(redirect)}`;
      const output = await new Deno.Command("script", {
        args: ["-qefc", command, "/dev/null"],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(output.success, new TextDecoder().decode(output.stderr));
      const stdout = await Deno.readTextFile(join(root, "out")),
        stderr = await Deno.readTextFile(join(root, "err"));
      assert.match(stdout, new RegExp(`OUT:${fd !== 1}`));
      assert.doesNotMatch(stdout, /ERR:/);
      assert.match(stderr, new RegExp(`ERR:${fd !== 2}`));
      assert.doesNotMatch(stderr, /OUT:/);
      assert.match(await Deno.readTextFile(redirect), fd === 1 ? /OUT:false/ : /ERR:false/);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.test(`supervisor receives external ${signal} and waits for native outcome`, async () => {
    const root = await Deno.makeTempDir();
    const entry = join(root, "supervisor.ts"),
      ready = join(root, "ready"),
      outcome = join(root, "outcome");
    const module = new URL("../../src/runner/process.ts", import.meta.url).href;
    try {
      const source = `Deno.writeTextFileSync(${
        JSON.stringify(ready)
      },'ready');setInterval(()=>{},100);`;
      await Deno.writeTextFile(
        entry,
        `import {runOwnedProcess} from ${
          JSON.stringify(module)
        };const result=await runOwnedProcess({executable:Deno.execPath(),args:['eval',${
          JSON.stringify(source)
        }],cwd:${JSON.stringify(root)},env:Deno.env.toObject(),stdoutPath:${
          JSON.stringify(join(root, "out"))
        },stderrPath:${JSON.stringify(join(root, "err"))}});await Deno.writeTextFile(${
          JSON.stringify(outcome)
        },JSON.stringify(result));`,
      );
      const supervisor = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", entry],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      await waitFor(ready);
      supervisor.kill(signal);
      const output = await supervisor.output();
      assert(output.success, new TextDecoder().decode(output.stderr));
      const result = JSON.parse(await Deno.readTextFile(outcome));
      assert.equal(result.signal, signal);
      assert.equal(result.escalated, false);
      assert.equal(new TextDecoder().decode(output.stdout), "");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}
Deno.test("normal parent exit waits for all live group descendants before finalization", async () => {
  const root = await Deno.makeTempDir();
  try {
    const done = join(root, "done");
    const descendant = `setTimeout(()=>Deno.writeTextFileSync(${
      JSON.stringify(done)
    },'done'),200);`;
    const result = await runOwnedProcess({
      executable: Deno.execPath(),
      args: [
        "eval",
        `new Deno.Command(Deno.execPath(),{args:['eval',${
          JSON.stringify(descendant)
        }],stdout:'inherit',stderr:'inherit'}).spawn();Deno.exit(7);`,
      ],
      cwd: root,
      env: Deno.env.toObject(),
      stdoutPath: join(root, "out"),
      stderrPath: join(root, "err"),
    });
    assert.equal(result.code, 7);
    assert.equal(result.signal, null);
    assert.equal(await Deno.readTextFile(done), "done");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("PTY output preserves redirected stdin type and current file offset", async () => {
  const root = await Deno.makeTempDir();
  const module = new URL("../../src/runner/process.ts", import.meta.url).href;
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  try {
    const entry = join(root, "stdin.ts"), input = join(root, "input");
    await Deno.writeTextFile(input, "consumed\nremaining\n");
    const payload =
      "console.log('STDIN:'+Deno.stdin.isTerminal());const b=new Uint8Array(64);const n=await Deno.stdin.read(b);console.log('READ:'+new TextDecoder().decode(b.subarray(0,n??0)).trim());";
    await Deno.writeTextFile(
      entry,
      `import {runOwnedProcess} from ${
        JSON.stringify(module)
      };await runOwnedProcess({executable:Deno.execPath(),args:['eval',${
        JSON.stringify(payload)
      }],cwd:${JSON.stringify(root)},env:Deno.env.toObject(),stdoutPath:${
        JSON.stringify(join(root, "out"))
      },stderrPath:${JSON.stringify(join(root, "err"))}});`,
    );
    const command = `exec 0<${quote(input)}; IFS= read -r first; exec ` +
      [Deno.execPath(), "run", "-A", entry].map(quote).join(" ");
    const output = await new Deno.Command("script", {
      args: ["-qefc", command, "/dev/null"],
      env: { SHELL: "/bin/sh" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(output.success, new TextDecoder().decode(output.stderr));
    const log = await Deno.readTextFile(join(root, "out"));
    assert.match(log, /STDIN:false/);
    assert.match(log, /READ:remaining/);
    assert.doesNotMatch(log, /READ:consumed/);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function bounded<T>(operation: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture timeout")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function cleanupFixture(root: string, supervisor?: Deno.ChildProcess) {
  for await (const entry of Deno.readDir(root)) {
    if (!entry.name.endsWith(".ready")) continue;
    try {
      const { group } = JSON.parse(await Deno.readTextFile(join(root, entry.name)));
      if (Number.isSafeInteger(group) && group > 1) Deno.kill(-group, "SIGKILL");
    } catch { /* Только собственные receipts fixture; group могла уже остановиться. */ }
  }
  try {
    supervisor?.kill("SIGKILL");
  } catch { /* Уже завершён. */ }
  if (supervisor) await supervisor.status;
}
Deno.test("a rejected downstream stops and awaits its tree while preserving available logs", async () => {
  const root = await Deno.makeTempDir();
  const module = new URL("../../src/runner/process.ts", import.meta.url).href;
  let supervisor: Deno.ChildProcess | undefined;
  try {
    const beat = join(root, "beat"), caught = join(root, "caught");
    const native = `console.error('available-stderr');Deno.writeTextFileSync(${
      JSON.stringify(beat)
    },'x');console.log('first');setInterval(()=>Deno.writeTextFileSync(${
      JSON.stringify(beat)
    },'x',{append:true}),20);`;
    const source = `import {runOwnedProcess} from ${
      JSON.stringify(module)
    };try {await runOwnedProcess({executable:Deno.execPath(),args:['eval',${
      JSON.stringify(native)
    }],cwd:${JSON.stringify(root)},env:Deno.env.toObject(),stdoutPath:${
      JSON.stringify(join(root, "out"))
    },stderrPath:${
      JSON.stringify(join(root, "err"))
    },timeExecutable:null,graceMilliseconds:150,stdout:new WritableStream({write(){throw new Error('downstream closed')}}),stderr:new WritableStream({write(){}})});}catch(e){await Deno.writeTextFile(${
      JSON.stringify(caught)
    },String(e));}`;
    supervisor = new Deno.Command(Deno.execPath(), {
      args: ["eval", source],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = await bounded(supervisor.output());
    assert(output.success, new TextDecoder().decode(output.stderr));
    assert.match(await Deno.readTextFile(caught), /downstream closed/);
    assert.match(await Deno.readTextFile(join(root, "out")), /first/);
    assert.match(await Deno.readTextFile(join(root, "err")), /available-stderr/);
    const size = (await Deno.stat(beat)).size;
    await pause(100);
    assert.equal((await Deno.stat(beat)).size, size);
  } finally {
    await cleanupFixture(root, supervisor);
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("keyboard Ctrl-C is observed once and escalates a stubborn PTY child", async () => {
  const root = await Deno.makeTempDir();
  const module = new URL("../../src/runner/process.ts", import.meta.url).href;
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  let outer: Deno.ChildProcess | undefined;
  let completion: Promise<Deno.CommandOutput> | undefined;
  try {
    const ready = join(root, "ready"),
      beat = join(root, "beat"),
      signals = join(root, "signals"),
      outcome = join(root, "outcome");
    const native = `Deno.addSignalListener('SIGINT',()=>Deno.writeTextFileSync(${
      JSON.stringify(signals)
    },'I',{append:true}));Deno.writeTextFileSync(${
      JSON.stringify(ready)
    },'ready');setInterval(()=>Deno.writeTextFileSync(${
      JSON.stringify(beat)
    },'x',{append:true}),20);`;
    const source = `import {runOwnedProcess} from ${
      JSON.stringify(module)
    };Deno.writeTextFileSync(${
      JSON.stringify(join(root, "supervisor"))
    },String(Deno.pid));const result=await runOwnedProcess({executable:Deno.execPath(),args:['eval',${
      JSON.stringify(native)
    }],cwd:${JSON.stringify(root)},env:Deno.env.toObject(),stdoutPath:${
      JSON.stringify(join(root, "out"))
    },stderrPath:${
      JSON.stringify(join(root, "err"))
    },timeExecutable:null,graceMilliseconds:150});Deno.writeTextFileSync(${
      JSON.stringify(outcome)
    },JSON.stringify(result));`;
    outer = new Deno.Command("script", {
      args: ["-qefc", [Deno.execPath(), "eval", source].map(quote).join(" "), "/dev/null"],
      env: { SHELL: "/bin/sh" },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const input = outer.stdin.getWriter();
    completion = outer.output();
    await waitFor(ready);
    await waitFor(beat);
    await input.write(new Uint8Array([3]));
    input.releaseLock();
    await bounded(waitFor(outcome), 1500);
    const result = JSON.parse(await Deno.readTextFile(outcome));
    assert.equal(result.escalated, true);
    assert.equal(result.signal, "SIGKILL");
    assert.equal(await Deno.readTextFile(signals), "I");
    const size = (await Deno.stat(beat)).size;
    await pause(100);
    assert.equal((await Deno.stat(beat)).size, size);
    const output = await bounded(completion);
    assert(output.success, new TextDecoder().decode(output.stderr));
  } finally {
    await cleanupFixture(root);
    try {
      Deno.kill(Number(await Deno.readTextFile(join(root, "supervisor"))), "SIGKILL");
    } catch { /* Собственный supervisor уже завершён. */ }
    try {
      outer?.kill("SIGKILL");
    } catch { /* Уже завершён. */ }
    try {
      await outer?.stdin.close();
    } catch { /* stdin уже закрыт. */ }
    if (outer) await outer.status;
    if (completion) await completion;
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("readiness is atomically published after delayed write and validates positive integer PGID", async () => {
  const root = await Deno.makeTempDir();
  try {
    const helper = await import("../../src/runner/resource-child.ts") as Record<string, unknown>;
    const process = await import("../../src/runner/process.ts") as Record<string, unknown>;
    const publish = helper.publishReceipt as (
      path: string,
      value: unknown,
      write?: (path: string, data: string) => Promise<void>,
    ) => Promise<void>;
    const read = process.readOwnedGroup as (path: string) => Promise<number>;
    assert.equal(typeof publish, "function");
    assert.equal(typeof read, "function");
    const path = join(root, "ready");
    let written!: () => void, release!: () => void;
    const started = new Promise<void>((r) => written = r),
      gate = new Promise<void>((r) => release = r);
    const pending = publish(path, { group: 123 }, async (temporary, data) => {
      await Deno.writeTextFile(temporary, "");
      written();
      await gate;
      await Deno.writeTextFile(temporary, data);
    });
    await started;
    await assert.rejects(() => read(path), Deno.errors.NotFound);
    release();
    await pending;
    assert.equal(await read(path), 123);
    for (const group of [0, 1, -1, 1.5, NaN, "123", null]) {
      await Deno.writeTextFile(path, JSON.stringify({ group }));
      await assert.rejects(() => read(path), /PGID/);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("invalid readiness stops only the proven owned descendants before reporting protocol error", async () => {
  const root = await Deno.makeTempDir();
  const module = new URL("../../src/runner/process.ts", import.meta.url).href;
  const beat = join(root, "beat"), neighbor = join(root, "neighbor");
  const other = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `setInterval(()=>Deno.writeTextFileSync(${JSON.stringify(neighbor)},'n',{append:true}),15)`,
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  let supervisor: Deno.ChildProcess | undefined;
  try {
    const stat = await Deno.readTextFile(`/proc/${other.pid}/stat`);
    const neighborGroup = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
    for (const invalid of [0, Number.MAX_SAFE_INTEGER, neighborGroup]) {
      try {
        await Deno.remove(beat);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      const native = `Deno.writeTextFileSync(${
        JSON.stringify(beat)
      },'x');setInterval(()=>Deno.writeTextFileSync(${
        JSON.stringify(beat)
      },'x',{append:true}),15);`;
      const source = `import {runOwnedProcess} from ${
        JSON.stringify(module)
      };const original=Deno.readTextFile;Deno.readTextFile=(async(path,...args)=>{const text=await original(path,...args);if(String(path).endsWith('.ready')){return JSON.stringify({group:${
        JSON.stringify(invalid)
      }});}return text;}) as typeof Deno.readTextFile;try{await runOwnedProcess({executable:Deno.execPath(),args:['eval',${
        JSON.stringify(native)
      }],cwd:${JSON.stringify(root)},env:Deno.env.toObject(),stdoutPath:${
        JSON.stringify(join(root, "out"))
      },stderrPath:${
        JSON.stringify(join(root, "err"))
      },timeExecutable:null,graceMilliseconds:150});}catch(e){Deno.writeTextFileSync(${
        JSON.stringify(join(root, "caught"))
      },String(e));}`;
      supervisor = new Deno.Command(Deno.execPath(), {
        args: ["eval", source],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const output = await bounded(supervisor.output());
      assert(output.success, new TextDecoder().decode(output.stderr));
      assert.match(await Deno.readTextFile(join(root, "caught")), /PGID/);
      await assert.rejects(() => Deno.stat(beat), Deno.errors.NotFound);
      await waitFor(neighbor);
      const otherSize = (await Deno.stat(neighbor)).size;
      await pause(100);
      await assert.rejects(() => Deno.stat(beat), Deno.errors.NotFound);
      for await (const entry of Deno.readDir(root)) {
        if (!entry.name.endsWith(".ready")) continue;
        const { group } = JSON.parse(await Deno.readTextFile(join(root, entry.name)));
        await assert.rejects(
          () => Deno.stat(join(root, entry.name.replace(/\.ready$/, ".registered"))),
          Deno.errors.NotFound,
        );
        let inspected = 0;
        for await (const process of Deno.readDir("/proc")) {
          if (!/^\d+$/.test(process.name)) continue;
          inspected++;
          try {
            const stat = await Deno.readTextFile(`/proc/${process.name}/stat`);
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            assert(!(Number(fields[2]) === group && fields[0] !== "Z"));
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
        assert(inspected > 0);
      }
      assert((await Deno.stat(neighbor)).size > otherSize);
    }
  } finally {
    await cleanupFixture(root, supervisor);
    other.kill("SIGKILL");
    await other.status;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("registered PTY group waits for orphan descendant after fast native exit 7", async () => {
  const root = await Deno.makeTempDir();
  const module = new URL("../../src/runner/process.ts", import.meta.url).href;
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  let outer: Deno.ChildProcess | undefined;
  try {
    const native =
      'trap \'\' HUP; (printf descendant-start\\n >> "$1/lifecycle"; sleep 0.7; printf done > "$1/done"; printf descendant-done\\n >> "$1/lifecycle") & printf \'parent=%s child=%s\\n\' "$$" "$!" >> "$1/lifecycle"; exit 7';
    const source = `import {runOwnedProcess} from ${
      JSON.stringify(module)
    };try{const result=await runOwnedProcess({executable:'/bin/sh',args:['-c',${
      JSON.stringify(native)
    },'sh',${JSON.stringify(root)}],cwd:${
      JSON.stringify(root)
    },env:Deno.env.toObject(),stdoutPath:${JSON.stringify(join(root, "out"))},stderrPath:${
      JSON.stringify(join(root, "err"))
    },timeExecutable:null});Deno.writeTextFileSync(${
      JSON.stringify(join(root, "outcome"))
    },JSON.stringify(result));Deno.writeTextFileSync(${
      JSON.stringify(join(root, "done-at-return"))
    },String((await Deno.stat(${
      JSON.stringify(join(root, "done"))
    })).isFile));}catch(e){Deno.writeTextFileSync(${
      JSON.stringify(join(root, "error"))
    },String(e));}`;
    outer = new Deno.Command("script", {
      args: ["-qefc", [Deno.execPath(), "eval", source].map(quote).join(" "), "/dev/null"],
      env: { SHELL: "/bin/sh" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = await bounded(outer.output());
    assert(output.success, new TextDecoder().decode(output.stderr));
    let error = "";
    try {
      error = await Deno.readTextFile(join(root, "error"));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    if (error) {
      const snapshot: Record<string, unknown> = {
        root,
        error,
        output: {
          code: output.code,
          stdout: new TextDecoder().decode(output.stdout),
          stderr: new TextDecoder().decode(output.stderr),
        },
      };
      const groups = new Set<number>(), materials: Record<string, string> = {};
      for await (const entry of Deno.readDir(root)) {
        if (!entry.isFile) continue;
        materials[entry.name] = await Deno.readTextFile(join(root, entry.name));
        if (entry.name.endsWith(".ready")) groups.add(JSON.parse(materials[entry.name]).group);
      }
      const processes: string[] = [];
      for await (const entry of Deno.readDir("/proc")) {
        if (!/^\d+$/.test(entry.name)) continue;
        try {
          const stat = await Deno.readTextFile(`/proc/${entry.name}/stat`),
            fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (groups.has(Number(fields[2])) || groups.has(Number(fields[3]))) {
            processes.push(stat + " wait=" + await Deno.readTextFile(`/proc/${entry.name}/wchan`));
          }
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      }
      snapshot.materials = materials;
      snapshot.processes = processes;
      const path = root + "-failure.json";
      await Deno.writeTextFile(path, JSON.stringify(snapshot, null, 2));
      throw new Error(`${error}; snapshot=${path}`);
    }
    assert.equal(error, "");
    const outcome = JSON.parse(await Deno.readTextFile(join(root, "outcome")));
    assert.equal(outcome.code, 7);
    assert.equal(outcome.signal, null);
    assert.equal(outcome.escalated, false);
    assert.equal(await Deno.readTextFile(join(root, "done-at-return")), "true");
    assert.equal(await Deno.readTextFile(join(root, "done")), "done");
  } finally {
    await cleanupFixture(root, outer);
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("registered PTY ownership remains available for cleanup after native parent exits", async () => {
  const root = await Deno.makeTempDir();
  const module = new URL("../../src/runner/process.ts", import.meta.url).href;
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  let outer: Deno.ChildProcess | undefined;
  try {
    const native =
      'trap \'\' HUP; (sleep 0.15; printf x > "$1/beat"; printf first; while :; do printf x >> "$1/beat"; sleep 0.02; done) & exit 7';
    const source = `import {runOwnedProcess} from ${
      JSON.stringify(module)
    };Deno.writeTextFileSync(${
      JSON.stringify(join(root, "supervisor"))
    },String(Deno.pid));const kill=Deno.kill;Deno.kill=((pid,signal)=>{Deno.writeTextFileSync(${
      JSON.stringify(join(root, "signals"))
    },JSON.stringify({pid,signal})+'\\n',{append:true});return kill(pid,signal);}) as typeof Deno.kill;try{await runOwnedProcess({executable:'/bin/sh',args:['-c',${
      JSON.stringify(native)
    },'sh',${JSON.stringify(root)}],cwd:${
      JSON.stringify(root)
    },env:Deno.env.toObject(),stdoutPath:${JSON.stringify(join(root, "out"))},stderrPath:${
      JSON.stringify(join(root, "err"))
    },timeExecutable:null,graceMilliseconds:150,stdout:new WritableStream({write(){throw new Error('late downstream closed')}})});}catch(e){Deno.writeTextFileSync(${
      JSON.stringify(join(root, "caught"))
    },String(e));}`;
    outer = new Deno.Command("script", {
      args: ["-qefc", [Deno.execPath(), "eval", source].map(quote).join(" "), "/dev/null"],
      env: { SHELL: "/bin/sh" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = await bounded(outer.output()).catch(async (error) => {
      const snapshot: Record<string, unknown> = {};
      const groups = new Set<number>();
      for await (const entry of Deno.readDir(root)) {
        if (!entry.isFile || entry.name === "beat") continue;
        const text = await Deno.readTextFile(join(root, entry.name));
        snapshot[entry.name] = text;
        if (entry.name.endsWith(".ready")) groups.add(JSON.parse(text).group);
      }
      const processes: string[] = [];
      for await (const entry of Deno.readDir("/proc")) {
        if (!/^\d+$/.test(entry.name)) continue;
        try {
          const text = await Deno.readTextFile(`/proc/${entry.name}/stat`);
          const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
          if (groups.has(Number(fields[2])) || groups.has(Number(fields[3]))) {
            processes.push(text + " wait=" + await Deno.readTextFile(`/proc/${entry.name}/wchan`));
          }
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        }
      }
      throw new Error(String(error) + "\n" + JSON.stringify({ snapshot, processes }));
    });
    assert(output.success, new TextDecoder().decode(output.stderr));
    assert.match(await Deno.readTextFile(join(root, "caught")), /late downstream closed/);
    assert.match(await Deno.readTextFile(join(root, "out")), /first/);
    const size = (await Deno.stat(join(root, "beat"))).size;
    await pause(100);
    assert.equal((await Deno.stat(join(root, "beat"))).size, size);
  } finally {
    await cleanupFixture(root, outer);
    try {
      Deno.kill(Number(await Deno.readTextFile(join(root, "supervisor"))), "SIGKILL");
    } catch { /* Только собственный supervisor fixture. */ }
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("queued abort prevents native spawn through GNU time bootstrap", async () => {
  const root = await Deno.makeTempDir();
  try {
    const wrapper = join(root, "time"), trap = join(root, "bootstrap-signal");
    await Deno.writeTextFile(
      wrapper,
      `#!/bin/sh\ntrap 'printf T >> ${
        "'" + trap.replaceAll("'", "'\\''") + "'"
      }' TERM\nsleep 0.1\nexec /usr/bin/time "$@"\n`,
    );
    await Deno.chmod(wrapper, 0o755);
    const abort = new AbortController();
    abort.abort("SIGTERM");
    const result = await runOwnedProcess({
      executable: Deno.execPath(),
      args: [
        "eval",
        `Deno.writeTextFileSync(${
          JSON.stringify(join(root, "native"))
        },"started");setInterval(()=>{},100)`,
      ],
      cwd: root,
      env: Deno.env.toObject(),
      stdoutPath: join(root, "out"),
      stderrPath: join(root, "err"),
      timeExecutable: wrapper,
      abortSignal: abort.signal,
      graceMilliseconds: 200,
    });
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.escalated, false);
    await assert.rejects(() => Deno.stat(join(root, "native")), Deno.errors.NotFound);
    await assert.rejects(() => Deno.stat(trap), Deno.errors.NotFound);
  } finally {
    await cleanupFixture(root);
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("external cancellation bounds stopped registered bootstrap before native spawn", async () => {
  const root = await Deno.makeTempDir();
  const module = new URL("../../src/runner/process.ts", import.meta.url).href;
  let supervisor: Deno.ChildProcess | undefined;
  try {
    for (const held of [false, true]) {
      const directory = join(root, held ? "held" : "plain");
      await Deno.mkdir(directory);
      const wrapper = join(directory, "time"),
        pidfile = join(directory, "bootstrap-pid"),
        native = join(directory, "native");
      await Deno.writeTextFile(
        wrapper,
        `#!/bin/sh\n${
          held
            ? 'while [ -d "$COURSE_PERF_SPAWN_LOCK" ]; do sleep 0.005; done\nmkdir "$COURSE_PERF_SPAWN_LOCK"\n'
            : ""
        }printf '%s' "$$" > '${pidfile}'\nkill -STOP $$\nexec /usr/bin/time "$@"\n`,
      );
      await Deno.chmod(wrapper, 0o755);
      const source = `import {runOwnedProcess} from ${
        JSON.stringify(module)
      };const kill=Deno.kill;Deno.kill=((pid,signal)=>{Deno.writeTextFileSync(${
        JSON.stringify(join(directory, "signal-trace"))
      },JSON.stringify({pid,signal})+'\\n',{append:true});return kill(pid,signal);}) as typeof Deno.kill;const result=await runOwnedProcess({executable:Deno.execPath(),args:['eval',${
        JSON.stringify(
          `Deno.writeTextFileSync(${JSON.stringify(native)},'started');setInterval(()=>{},100)`,
        )
      }],cwd:${JSON.stringify(directory)},env:Deno.env.toObject(),stdoutPath:${
        JSON.stringify(join(directory, "out"))
      },stderrPath:${JSON.stringify(join(directory, "err"))},timeExecutable:${
        JSON.stringify(wrapper)
      },graceMilliseconds:150});Deno.writeTextFileSync(${
        JSON.stringify(join(directory, "outcome"))
      },JSON.stringify(result));`;
      supervisor = new Deno.Command(Deno.execPath(), {
        args: ["eval", source],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const completion = supervisor.output();
      await waitFor(pidfile);
      supervisor.kill("SIGTERM");
      const output = await bounded(completion, 2000);
      assert(output.success, new TextDecoder().decode(output.stderr));
      const outcome = JSON.parse(await Deno.readTextFile(join(directory, "outcome")));
      assert.equal(outcome.signal, "SIGKILL");
      assert.equal(outcome.escalated, true);
      await assert.rejects(() => Deno.stat(native), Deno.errors.NotFound);
      await pause(100);
      await assert.rejects(() => Deno.stat(native), Deno.errors.NotFound);
      let groupsChecked = 0;
      for await (const entry of Deno.readDir(directory)) {
        if (!entry.name.endsWith(".ready")) continue;
        groupsChecked++;
        const { group } = JSON.parse(await Deno.readTextFile(join(directory, entry.name)));
        const prefix = join(directory, entry.name.slice(0, -".ready".length));
        assert.equal(JSON.parse(await Deno.readTextFile(prefix + ".cancel")).signal, "SIGTERM");
        await assert.rejects(() => Deno.stat(prefix + ".native.started"), Deno.errors.NotFound);
        const trace = (await Deno.readTextFile(join(directory, "signal-trace"))).trim().split("\n")
          .map((line) => JSON.parse(line));
        assert(trace.every((call) => call.pid === -group));
        assert.deepEqual(
          trace.filter((call) => call.signal !== 0).map((call) => call.signal),
          held ? ["SIGKILL"] : ["SIGTERM", "SIGKILL"],
        );
        for await (const process of Deno.readDir("/proc")) {
          if (!/^\d+$/.test(process.name)) continue;
          try {
            const stat = await Deno.readTextFile(`/proc/${process.name}/stat`);
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            assert(!(Number(fields[2]) === group && fields[0] !== "Z"));
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
      }
      assert(groupsChecked > 0);
      supervisor = undefined;
    }
  } finally {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory) await cleanupFixture(join(root, entry.name));
    }
    try {
      supervisor?.kill("SIGKILL");
    } catch { /* Уже завершён. */ }
    if (supervisor) await supervisor.status;
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("known native outcome accompanies downstream failure but pre-spawn failure does not invent one", async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const code of [0, 7]) {
      let caught: unknown;
      try {
        await runOwnedProcess({
          executable: "/bin/sh",
          args: ["-c", `(sleep 0.15; echo delayed) & exit ${code}`],
          cwd: root,
          env: Deno.env.toObject(),
          stdoutPath: join(root, `out-${code}`),
          stderrPath: join(root, `err-${code}`),
          timeExecutable: null,
          stdout: new WritableStream({
            write() {
              throw new Error("known downstream failure");
            },
          }),
          stderr: new WritableStream({ write() {} }),
        });
      } catch (error) {
        caught = error;
      }
      assert(caught instanceof Error);
      assert.match(caught.message, /known downstream failure/);
      assert.equal((caught as Error & { outcome?: { code: number } }).outcome?.code, code);
    }
    let caught: unknown;
    const sink = new WritableStream<Uint8Array>();
    Object.defineProperty(sink, "getWriter", {
      value: () => {
        throw new Error("pre-spawn sink failure");
      },
    });
    try {
      await runOwnedProcess({
        executable: "/bin/sh",
        args: ["-c", `echo spawned > '${root}/unexpected-native'`],
        cwd: root,
        env: Deno.env.toObject(),
        stdoutPath: join(root, "out-prespawn"),
        stderrPath: join(root, "err-prespawn"),
        timeExecutable: null,
        stdout: sink,
        stderr: new WritableStream({ write() {} }),
      });
    } catch (error) {
      caught = error;
    }
    assert(caught instanceof Error);
    assert.match(caught.message, /pre-spawn sink failure/);
    assert.equal((caught as Error & { outcome?: unknown }).outcome, undefined);
    await assert.rejects(() => Deno.stat(join(root, "unexpected-native")), Deno.errors.NotFound);
  } finally {
    await cleanupFixture(root);
    await Deno.remove(root, { recursive: true });
  }
});
Deno.test("a stale proc directory snapshot cannot hide a new live member of the registered group", async () => {
  for (const mode of ["normal", "double-empty"]) {
    const root = await Deno.makeTempDir();
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    let outer: Deno.ChildProcess | undefined;
    try {
      const fixture = new URL("./fixtures/orphan-stale-scan.ts", import.meta.url).pathname;
      outer = new Deno.Command("script", {
        args: [
          "-qefc",
          [Deno.execPath(), "run", "-A", fixture, root, mode].map(quote).join(" "),
          "/dev/null",
        ],
        env: { SHELL: "/bin/sh" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const output = await bounded(outer.output());
      assert(output.success, new TextDecoder().decode(output.stderr));
      const flight = JSON.parse(await Deno.readTextFile(join(root, "flight.json")));
      assert.equal(flight.kernelExists, true);
      assert(
        flight.processes.some((p: { state: string; presentInSnapshot: boolean }) =>
          p.state !== "Z" && !p.presentInSnapshot
        ),
      );
      const result = JSON.parse(await Deno.readTextFile(join(root, "result.json")));
      assert.equal(result.outcome.code, 7);
      assert.equal(result.injectedSnapshots, mode === "double-empty" ? 2 : 1);
      const evidenceDirectory = Deno.env.get("PERF_TEST_EVIDENCE_DIRECTORY");
      if (evidenceDirectory) {
        await Deno.mkdir(evidenceDirectory, { recursive: true });
        await Deno.writeTextFile(
          join(evidenceDirectory, `stale-${mode}.json`),
          JSON.stringify(result, null, 2),
        );
      }
      assert.equal(
        result.doneAtReturn,
        true,
        "a real live descendant absent from an earlier /proc enumeration must still finish before return",
      );
    } finally {
      await cleanupFixture(root, outer);
      await Deno.remove(root, { recursive: true });
    }
  }
});
Deno.test("zombie-only group returns while a real live member beside a zombie still finishes", async () => {
  for (const withLive of [false, true]) {
    const root = await Deno.makeTempDir();
    let holder: number | undefined;
    let running: Promise<unknown> | undefined;
    try {
      let doneAtReturn = false;
      running = runOwnedProcess({
        executable: "python3",
        args: [
          new URL("./fixtures/zombie-group.py", import.meta.url).pathname,
          root,
          withLive ? "live" : "zombie",
        ],
        cwd: root,
        env: Deno.env.toObject(),
        stdoutPath: join(root, "out"),
        stderrPath: join(root, "err"),
        timeExecutable: null,
        stdout: new WritableStream({ write() {} }),
        stderr: new WritableStream({ write() {} }),
      }).then((outcome) => {
        try {
          doneAtReturn = Deno.statSync(join(root, "live-done")).isFile;
        } catch { /* No live completion yet. */ }
        return outcome;
      });
      await waitFor(join(root, "state.json"));
      const state = JSON.parse(await Deno.readTextFile(join(root, "state.json")));
      holder = state.holder;
      const fields = async (pid: number) =>
        (await Deno.readTextFile(`/proc/${pid}/stat`)).split(") ")[1].split(" ");
      const zombie = await fields(state.zombie), holderStat = await fields(state.holder);
      assert.equal(zombie[0], "Z");
      assert.equal(Number(zombie[2]), state.group);
      assert.equal(Number(zombie[3]), state.session);
      assert.notEqual(holderStat[0], "Z");
      assert.equal(Number(holderStat[2]), state.holderGroup);
      assert.notEqual(state.holderGroup, state.group);
      if (withLive) {
        await waitFor(join(root, "live-ready"));
        const live = await fields(state.live);
        assert.notEqual(live[0], "Z");
        assert.equal(Number(live[2]), state.group);
        await Deno.writeTextFile(join(root, "finish-live"), "");
      }
      const result = await bounded(running) as { code: number };
      assert.equal(result.code, 7);
      Deno.kill(-state.group, 0); // The unreaped zombie is still visible to the kernel.
      const evidenceDirectory = Deno.env.get("PERF_TEST_EVIDENCE_DIRECTORY");
      if (evidenceDirectory) {
        await Deno.mkdir(evidenceDirectory, { recursive: true });
        await Deno.writeTextFile(
          join(evidenceDirectory, withLive ? "zombie-live.json" : "zombie-only.json"),
          JSON.stringify({ state, zombie, holderStat, result, doneAtReturn }, null, 2),
        );
      }
      if (withLive) assert.equal(doneAtReturn, true);
      else {assert.notEqual(
          (await fields(state.holder))[0],
          "Z",
          "unreaped zombies must not wait for a live holder in another process group",
        );}
    } finally {
      await Deno.writeTextFile(join(root, "finish-live"), "");
      await Deno.writeTextFile(join(root, "release-holder"), "");
      if (holder) {
        try {
          await waitFor(join(root, "holder-done"));
        } catch {
          try {
            Deno.kill(holder, "SIGKILL");
          } catch { /* Own fixture holder already exited. */ }
        }
      }
      await cleanupFixture(root);
      if (running) await running.catch(() => {});
      await Deno.remove(root, { recursive: true });
    }
  }
});
Deno.test("known registered group survives a stale error-path proc snapshot until controlled stop", async () => {
  const root = await Deno.makeTempDir();
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  let outer: Deno.ChildProcess | undefined;
  try {
    const fixture = new URL("./fixtures/orphan-stale-scan.ts", import.meta.url).pathname;
    outer = new Deno.Command("script", {
      args: [
        "-qefc",
        [Deno.execPath(), "run", "-A", fixture, root, "failure"].map(quote).join(" "),
        "/dev/null",
      ],
      env: { SHELL: "/bin/sh" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = await bounded(outer.output()).catch(async (error) => {
      const path = root + "-failure.json";
      await Deno.copyFile(join(root, "flight.json"), path);
      throw new Error(`${error}; snapshot=${path}`);
    });
    assert(output.success, new TextDecoder().decode(output.stderr));
    const flight = JSON.parse(await Deno.readTextFile(join(root, "flight.json")));
    assert(flight.kernelExists);
    assert(
      flight.processes.some((p: { state: string; presentInSnapshot: boolean }) =>
        p.state !== "Z" && !p.presentInSnapshot
      ),
    );
    const result = JSON.parse(await Deno.readTextFile(join(root, "result.json")));
    assert.equal(result.outcome.code, 7);
    assert.equal(result.outcome.escalated, true);
    assert.match(result.error, /stale error-path downstream/);
    for await (const entry of Deno.readDir("/proc")) {
      if (!/^\d+$/.test(entry.name)) continue;
      try {
        const stat = await Deno.readTextFile(`/proc/${entry.name}/stat`),
          f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(f[2]) === flight.group) assert.equal(f[0], "Z");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  } finally {
    await cleanupFixture(root, outer);
    await Deno.remove(root, { recursive: true });
  }
});
