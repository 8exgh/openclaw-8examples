"""Private JSON/stdio bridge. Executed as node inside the selected container."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def emit(value):
    print(json.dumps(value), flush=True)


pid, master = pty.fork()
if pid == 0:
    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor",
               HISTFILE="/dev/null", HISTSIZE="0", HISTFILESIZE="0",
               PS1=r"\u@\h:\w\$ ")
    # Respect the owner's interactive shell configuration. We do not enable
    # history or recording; any logging in their .bashrc remains their choice.
    env.pop("PROMPT_COMMAND", None)
    env.pop("BASH_ENV", None)
    if os.getuid() == 0:
        # Keep OpenClaw's plugin/config writes owned by its runtime user even
        # when the human uses root for apt, system files, or process recovery.
        env["BASH_FUNC_openclaw%%"] = '() { runuser -u node -- openclaw "$@"; }'
        env["OPENCLAW_STATE_DIR"] = "/home/node/.openclaw"
        env["OPENCLAW_CONFIG_PATH"] = "/home/node/.openclaw/openclaw.json"
    os.execve("/bin/bash", ["bash", "-i"], env)

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
os.set_blocking(master, False)
pending = []
incoming = b""
emit({"event": "ready"})
try:
    while True:
        reads, writes, _ = select.select([0, master], [master] if pending else [], [], 0.2)
        if master in reads:
            try:
                data = os.read(master, 32768)
            except OSError:
                data = b""
            if not data:
                break
            emit({"event": "output", "data": base64.b64encode(data).decode("ascii")})
        if master in writes and pending:
            command, data = pending[0]
            try:
                count = os.write(master, data)
                if count == len(data):
                    pending.pop(0)
                    emit({"reply": command, "ok": True})
                else:
                    pending[0] = (command, data[count:])
            except BlockingIOError:
                pass
        if 0 in reads:
            data = os.read(0, 32768)
            if not data:
                break
            incoming += data
            if len(incoming) > 65536:
                raise ValueError("input limit")
            while b"\n" in incoming:
                line, incoming = incoming.split(b"\n", 1)
                command = json.loads(line)
                action = command.get("action")
                if action == "close":
                    raise EOFError()
                if action == "input":
                    payload = base64.b64decode(command["data"], validate=True)
                    if not 0 < len(payload) <= 4096 or len(pending) >= 16:
                        raise ValueError("input limit")
                    pending.append((command["id"], payload))
                elif action == "resize":
                    cols, rows = command["cols"], command["rows"]
                    if not (2 <= cols <= 500 and 2 <= rows <= 200):
                        raise ValueError("size limit")
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                    emit({"reply": command["id"], "ok": True})
                else:
                    raise ValueError("unsupported action")
except (EOFError, BrokenPipeError):
    pass
finally:
    # Also runs on loss of Docker exec's stdin. Never leave a detached login shell.
    try:
        os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    os.close(master)
    deadline = time.monotonic() + 0.5
    status = None
    while time.monotonic() < deadline:
        done, value = os.waitpid(pid, os.WNOHANG)
        if done:
            status = value
            break
        time.sleep(0.02)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if status is None:
        _, status = os.waitpid(pid, 0)
    try:
        emit({"event": "exit", "code": os.waitstatus_to_exitcode(status)})
    except BrokenPipeError:
        pass
