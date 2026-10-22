# Runs a command in a pseudo-terminal and drives it with a list of steps read from a JSON spec.
# Steps: {"expect": text, "timeout": seconds} waits for text after the previous expect, for at most the step's timeout and
# the run's timeoutS; {"send": hex} writes bytes;
# {"clear": true} makes later expectations match only output printed after it; {"pause": ms} sleeps;
# {"resize": [rows, cols]} sets the terminal size, which signals the command's foreground group with SIGWINCH.
# The plain output (ANSI sequences removed) is printed as JSON with the index of the failing step, or -1 when every step completed.
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
# A terminated driver ends the command's whole process group, so no child survives it, even one that ignores SIGHUP.
def end_on_signal(signum, frame):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os._exit(128 + signum)
signal.signal(signal.SIGTERM, end_on_signal)
os.set_blocking(master, False)
ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][0-9A-Za-z]|\x1b[=>78]")
output = bytearray()
mark = 0
failed = -1
# No step outlives the run: a step that never matches ends the run with its frame, before the test runner kills the driver.
run_deadline = time.monotonic() + spec.get("timeoutS", 20)
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
        deadline = min(time.monotonic() + step.get("timeout", spec.get("timeoutS", 20)), run_deadline)
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
    elif "absent" in step:
        # Waits, then fails the run if the text was printed after the last clear.
        pump(step.get("pause", 300) / 1000)
        if step["absent"] in plain()[mark:]:
            failed = index
            break
    elif "pause" in step:
        pump(step["pause"] / 1000)
    elif "resize" in step:
        rows, cols = step["resize"]
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        pump(0.3)
    elif "clear" in step:
        # Later expectations match only output printed after this point.
        mark = len(plain())
# The command leads its own process group; its helpers (proxy, attach stand-in) belong to it too.
try:
    os.killpg(child.pid, signal.SIGKILL)
except ProcessLookupError:
    pass
child.wait()
print(json.dumps({"failed": failed, "exit": child.returncode, "output": plain()}))
