# Runs a command in a pseudo-terminal and drives it with a list of steps read from a JSON spec.
# Steps: {"expect": text} waits for text after the previous expect; {"send": hex} writes bytes;
# {"pause": ms} sleeps. The plain output (ANSI sequences removed) is printed as JSON with the
# index of the failing step, or -1 when every step completed.
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

spec = json.load(open(sys.argv[1]))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", spec["rows"], spec["cols"], 0, 0))
# The command gets the pseudo-terminal as its controlling terminal and leads its own process group,
# so Ctrl-C reaches its foreground group, as in a real terminal.
def make_controlling():
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
child = subprocess.Popen(spec["cmd"], stdin=slave, stdout=slave, stderr=slave, env=spec["env"], cwd=spec.get("cwd"), start_new_session=True, preexec_fn=make_controlling)
os.close(slave)
os.set_blocking(master, False)
ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][0-9A-Za-z]|\x1b[=>78]")
output = bytearray()
mark = 0
failed = -1
def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                output.extend(os.read(master, 65536))
            except BlockingIOError:
                pass
            except OSError:
                return
        if child.poll() is not None and not ready:
            return
def plain():
    return ANSI.sub(b"", bytes(output)).decode("utf-8", "replace")
for index, step in enumerate(spec["steps"]):
    if "expect" in step:
        deadline = time.monotonic() + step.get("timeout", spec.get("timeoutS", 20))
        needle = step["expect"]
        while True:
            text = plain()
            if needle in text[mark:]:
                mark = text.index(needle, mark) + len(needle)
                break
            if time.monotonic() > deadline or child.poll() is not None:
                failed = index
                break
            pump(0.05)
        if failed != -1:
            break
    elif "send" in step:
        os.write(master, bytes.fromhex(step["send"]))
        pump(step.get("settle", 300) / 1000)
    elif "pause" in step:
        pump(step["pause"] / 1000)
# The command leads its own process group; its helpers (proxy, attach stand-in) belong to it too.
try:
    os.killpg(child.pid, signal.SIGKILL)
except ProcessLookupError:
    pass
child.wait()
print(json.dumps({"failed": failed, "exit": child.returncode, "output": plain()}))
