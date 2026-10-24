import json
import os
from pathlib import Path
import signal
import sys
import time

root = Path(sys.argv[1])
with_live = sys.argv[2] == "live"
original_group = os.getpgrp()
reader, writer = os.pipe()
holder = os.fork()
if holder:
    os.close(writer)
    if os.read(reader, 1) != b"r":
        os._exit(3)
    os._exit(7)

os.close(reader)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
zombie = os.fork()
if not zombie:
    os._exit(0)
os.waitid(os.P_PID, zombie, os.WEXITED | os.WNOWAIT)
live = None
if with_live:
    live = os.fork()
    if not live:
        deadline = time.monotonic() + 15
        (root / "live-ready").write_text("ready")
        while not (root / "finish-live").exists():
            if time.monotonic() > deadline:
                os._exit(8)
            time.sleep(0.005)
        (root / "live-done").write_text("done")
        os._exit(0)

os.setpgid(0, 0)
# The holder is deliberately outside the measured group and must not retain its streams.
null = os.open(os.devnull, os.O_RDWR)
for descriptor in (0, 1, 2):
    os.dup2(null, descriptor)
if null > 2:
    os.close(null)
(root / "state.json").write_text(json.dumps({
    "holder": os.getpid(), "zombie": zombie, "live": live,
    "group": original_group, "holderGroup": os.getpgrp(), "session": os.getsid(0),
}))
os.write(writer, b"r")
os.close(writer)
deadline = time.monotonic() + 15
while not (root / "release-holder").exists():
    if time.monotonic() > deadline:
        break
    time.sleep(0.005)
if live:
    (root / "finish-live").touch()
    os.waitpid(live, 0)
os.waitpid(zombie, 0)
(root / "holder-done").write_text("done")
os._exit(0)
