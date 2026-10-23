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
      args: ["eval", "await new Promise(()=>{})"],
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
    for (const invalid of [0, neighborGroup]) {
      try {
        await Deno.remove(beat);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      const native = `setInterval(()=>Deno.writeTextFileSync(${
        JSON.stringify(beat)
      },'x',{append:true}),15);`;
      const source = `import {runOwnedProcess} from ${
        JSON.stringify(module)
      };const original=Deno.readTextFile;Deno.readTextFile=(async(path,...args)=>{const text=await original(path,...args);if(String(path).endsWith('.ready')){while(true){try{await Deno.stat(${
        JSON.stringify(beat)
      });break;}catch{await new Promise(r=>setTimeout(r,10));}}return JSON.stringify({group:${
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
      const size = (await Deno.stat(beat)).size;
      await waitFor(neighbor);
      const otherSize = (await Deno.stat(neighbor)).size;
      await pause(100);
      assert.equal((await Deno.stat(beat)).size, size);
      assert((await Deno.stat(neighbor)).size > otherSize);
    }
  } finally {
    await cleanupFixture(root, supervisor);
    other.kill("SIGKILL");
    await other.status;
    await Deno.remove(root, { recursive: true });
  }
});
