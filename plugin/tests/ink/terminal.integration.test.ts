import { afterEach, expect, test } from "bun:test";
import { startSdkStandIn } from "../helpers/sdk-stand-in.ts";
import { daemonLocalSocket, DAEMON_STOP_HOOK_TIMEOUT_MS, startCoreDaemon } from "../helpers/core-daemon.ts";
import { REAL_SCENARIO_TIMEOUT_MS } from "./support/scenario.ts";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PYTHON_PTY = String.raw`
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
output = bytearray()
sent = False
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        output.extend(chunk)
        if not sent and sys.argv[3].encode() in output:
            os.write(master, bytes.fromhex(sys.argv[4]))
            sent = True
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
try:
    while True:
        ready, _, _ = select.select([master], [], [], 0)
        if not ready:
            break
        output.extend(os.read(master, 65536))
except OSError:
    pass
os.close(master)
print(json.dumps({"exit": child.returncode, "sent": sent, "alternate": b"\x1b[?1049h" in output, "restored": b"\x1b[?1049l" in output, "screen": sys.argv[3].encode() in output}))
`;

const PYTHON_MOUSE_PTY = String.raw`
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
output = bytearray()
step = "click"
clicked = False
switched = False
right_switched = False
left_switched = False
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    # Sessions takes the arrow keys as section jumps, so the tab switch by arrow is made from Hosts and Activity.
    if step == "click" and b"\x1b[?1006h" in output:
        os.write(master, b"\x1b[<0;17;2M")
        clicked = True
        step = "sessions"
        output.clear()
    elif step == "sessions" and b"No sessions" in output:
        switched = True
        os.write(master, b"\t")
        step = "hosts"
        output.clear()
    elif step == "hosts" and b"HOSTS" in output:
        os.write(master, b"\x1b[C")
        step = "activity"
        output.clear()
    elif step == "activity" and b"Scope: Recent" in output:
        right_switched = True
        os.write(master, b"\x1b[D")
        step = "back"
        output.clear()
    elif step == "back" and b"HOSTS" in output:
        left_switched = True
        os.write(master, b"q")
        step = "quit"
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
try:
    while True:
        ready, _, _ = select.select([master], [], [], 0)
        if not ready:
            break
        output.extend(os.read(master, 65536))
except OSError:
    pass
os.close(master)
print(json.dumps({"exit": child.returncode, "clicked": clicked, "switched": switched, "right_switched": right_switched, "left_switched": left_switched, "mouse_off": b"\x1b[?1006l" in output}))
`;

const PYTHON_FORM_MOUSE_PTY = String.raw`
import fcntl, json, os, pty, re, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
output = bytearray()
clicked = False
edited = False
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    # The unreachable binary adds the status and warning lines above the form, which puts Name on row 10.
    if not clicked and b"\x1b[?1006h" in output and b"host list: cannot start" in output:
        os.write(master, b"\x1b[<0;10;10Mmouse-name")
        clicked = True
    plain = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", output)
    if clicked and not edited and re.search(rb"Name\s+mouse-name_", plain):
        edited = True
        os.write(master, b"\x1b")
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
os.close(master)
print(json.dumps({"exit": child.returncode, "clicked": clicked, "edited": edited}))
`;


const PYTHON_TWO_FORMS_PTY = String.raw`
import fcntl, json, os, pty, re, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
output = bytearray()
step = 0
paused = False
next_input = 0
deadline = time.monotonic() + 20
def calls():
    if not os.path.exists(sys.argv[3]): return []
    return [json.loads(line) for line in open(sys.argv[3]) if line.strip()]
def press(data, times):
    for _ in range(times):
        os.write(master, data)
        time.sleep(0.15)
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    text = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", bytes(output)).decode("utf-8", "replace")
    now = time.monotonic()
    if step == 0 and b"\x1b[?1006h" in output:
        output.clear()
        os.write(master, b"n")
        step = 1
    # The form has loaded its options once the default agent label is shown; Tab then moves the focus from
    # Project to the button row, where Enter creates the session.
    elif step == 1 and "Create and attach" in text and "‹ shell ›" in text:
        output.clear()
        press(b"\t", 7)
        os.write(master, b"\r")
        step = 2
    elif step == 2 and "Launch warning: base_branch_fallback" in text:
        paused = not any(call[:2] == ["attach", "--host"] for call in calls())
        os.write(master, b"\r")
        step = 3
    elif step == 3 and any(call[:2] == ["attach", "--host"] for call in calls()) and "Work is unavailable" in text:
        output.clear()
        next_input = now
        step = 4
    # Keys are ignored while the TUI is busy, so each view key is sent again until its view is shown.
    elif step == 4:
        if "No sessions" in text:
            output.clear()
            next_input = now
            step = 5
        elif now >= next_input:
            os.write(master, b"2")
            next_input = now + 0.5
    elif step == 5 and "NEW ASSISTANT" not in text and now >= next_input:
        os.write(master, b"a")
        next_input = now + 0.5
    # The assistant fields skip the unavailable request field: from Project, five Tabs reach the button row.
    elif step == 5 and "NEW ASSISTANT" in text and "Create and attach" in text and "codex" in text.lower():
        output.clear()
        press(b"\t", 5)
        os.write(master, b"\r")
        step = 6
    elif step == 6 and len([call for call in calls() if call[:2] == ["attach", "--host"]]) == 2 and "No sessions" in text:
        os.write(master, b"q")
        next_input = now + 0.3
        step = 7
    elif step == 7 and now >= next_input:
        os.write(master, b"q")
        next_input = now + 0.3
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
os.close(master)
print(json.dumps({"exit": child.returncode, "step": step, "paused": paused}))
`;

const PYTHON_WORK_RESULT_PTY = String.raw`
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
output = bytearray()
step = 0
next_input = 0
mouse_opened = False
keyboard_opened = False
no_automatic_action = True
previewed = False
mouse_action_previewed = False
deadline = time.monotonic() + 15
def trace():
    return open(sys.argv[3]).read() if os.path.exists(sys.argv[3]) else ""
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    now = time.monotonic()
    if step == 0 and b"WORK  1 items" in output and b"\x1b[?1006h" in output:
        time.sleep(0.2)
        output.clear()
        os.write(master, b"\x1b[<0;10;7M")
        step = 1
    elif step == 1 and b"WORK ITEM" in output and b"Run review" in output:
        mouse_opened = True
        no_automatic_action = no_automatic_action and '"do"' not in trace()
        output.clear()
        os.write(master, b"\x1b")
        step = 2
    elif step == 2 and b"WORK  1 items" in output:
        output.clear()
        os.write(master, b"\r")
        step = 3
    elif step == 3 and b"WORK ITEM" in output and b"Run review" in output:
        keyboard_opened = True
        no_automatic_action = no_automatic_action and '"do"' not in trace()
        output.clear()
        os.write(master, b"\r")
        step = 4
    elif step == 4 and b"PLAN PREVIEW" in output and b"name: Review this" in output:
        previewed = True
        output.clear()
        os.write(master, b"\x1b")
        step = 5
    elif step == 5 and b"WORK ITEM" in output and b"Run review" in output:
        time.sleep(0.2)
        output.clear()
        # The action buttons are on row 12; column 18 is inside "Preview plan", which never runs the action.
        os.write(master, b"\x1b[<0;18;12M")
        step = 6
    elif step == 6 and b"PLAN PREVIEW" in output:
        mouse_action_previewed = True
        output.clear()
        os.write(master, b"\x1b")
        step = 7
    elif step == 7 and b"WORK ITEM" in output and b"Run review" in output:
        output.clear()
        os.write(master, b"r")
        step = 8
    elif step == 8 and b"confirmation_required: owner declined" in output:
        os.write(master, b"q")
        next_input = now + 0.3
        step = 9
    elif step == 9 and now >= next_input:
        os.write(master, b"q")
        next_input = now + 0.3
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
os.close(master)
print(json.dumps({"exit": child.returncode, "step": step, "mouse_opened": mouse_opened, "keyboard_opened": keyboard_opened, "no_automatic_action": no_automatic_action, "previewed": previewed, "mouse_action_previewed": mouse_action_previewed, **({"trace": trace()} if child.returncode != 0 else {})}))
`;


const PYTHON_LOST_SESSION_PTY = String.raw`
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
output = bytearray()
step = 0
resume_visible = False
remove_visible = False
attach_hidden = False
deadline = time.monotonic() + 20
def trace():
    return open(sys.argv[3]).read() if os.path.exists(sys.argv[3]) else ""
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    now = time.monotonic()
    if step == 0 and b"\x1b[?1006h" in output:
        output.clear()
        os.write(master, b"2")
        step = 1
    elif step == 1 and b"SESSIONS  1" in output and b"Lost session" in output:
        output.clear()
        os.write(master, b"\r")
        step = 2
    elif step == 2 and b"OUTPUT" in output and b"Resume" in output and b"Remove" in output:
        resume_visible = True
        remove_visible = True
        attach_hidden = b"Attach" not in output
        output.clear()
        os.write(master, b"r")
        step = 3
    elif step == 3 and b"RECOVERY TARGET" in output:
        output.clear()
        os.write(master, b"y")
        step = 33
    elif step == 33 and '"resume","lost-1"' in trace() and '"attach","--host","local","--","lost-1"' in trace() and b"SESSIONS  1" in output:
        output.clear()
        next_input = now + 0.5
        step = 31
    elif step == 31 and now >= next_input:
        os.write(master, b"\r")
        step = 4
    elif step == 4 and b"OUTPUT" in output and b"Remove" in output:
        output.clear()
        os.write(master, b"D")
        step = 5
    # Keys are ignored while the TUI is busy, so the confirmation is sent again until the removal is requested.
    elif step == 5 and '"rm","lost-1"' not in trace() and b"Confirm remove" in output and now >= next_input:
        os.write(master, b"y")
        next_input = now + 0.5
    elif step == 5 and '"rm","lost-1"' in trace():
        step = 6
    # The success status is replaced by the refresh that follows the removal, so the reload is awaited instead.
    elif step == 6 and '"session","list"' in trace()[trace().find('"rm","lost-1"'):] and trace().find('"rm","lost-1"') >= 0:
        os.write(master, b"q")
        step = 7
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
os.close(master)
print(json.dumps({"exit": child.returncode, "step": step, "resume_visible": resume_visible, "remove_visible": remove_visible, "attach_hidden": attach_hidden, **({"trace": trace()} if child.returncode != 0 else {})}))
`;


const PYTHON_TEMPLATE_PTY = String.raw`
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
output = bytearray()
step = 0
next_input = 0
deadline = time.monotonic() + 15
def press(data, times):
    for _ in range(times):
        os.write(master, data)
        time.sleep(0.15)
# Keys, not clicks: the form's row positions depend on whether the status line is drawn yet.
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    now = time.monotonic()
    if step == 0 and b"\x1b[?1006h" in output:
        output.clear()
        os.write(master, b"n")
        step = 1
    elif step == 1 and b"NEW SESSION" in output and b"repo" in output and b"Create and attach" in output:
        output.clear()
        press(b"\t", 2)
        step = 2
    elif step == 2 and b"Choose action/template" in output and b"review" in output:
        output.clear()
        os.write(master, b"\x1b[C")
        step = 3
    elif step == 3 and b"Review template prompt" in output:
        output.clear()
        os.write(master, b"\x1b[D")
        next_input = now + 0.5
        step = 4
    elif step == 4 and now >= next_input:
        press(b"\t", 5)
        os.write(master, b"\r")
        step = 5
    elif step == 5 and os.path.exists(sys.argv[3]) and '"session","new"' in open(sys.argv[3]).read() and b"Work is unavailable" in output:
        os.write(master, b"q")
        next_input = now + 0.3
        step = 6
    elif step == 6 and now >= next_input:
        os.write(master, b"q")
        next_input = now + 0.3
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
os.close(master)
print(json.dumps({"exit": child.returncode, "step": step}))
`;

const PYTHON_FOCUSED_CHOICE_PTY = String.raw`
import fcntl, json, os, pty, re, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
output = bytearray()
step = 0
next_input = 0
deadline = time.monotonic() + 15
def trace():
    return open(sys.argv[3]).read() if os.path.exists(sys.argv[3]) else ""
def click(column, row):
    os.write(master, ("\x1b[<0;%d;%dM" % (column, row)).encode())
# Rows are read from the form: the status line above the fields appears with the first refresh and shifts
# every row below it by one, so the Action row is measured once the refresh has settled.
action_row = None
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    text = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", bytes(output)).decode("utf-8", "replace")
    now = time.monotonic()
    if step == 0 and b"\x1b[?1006h" in output:
        output.clear()
        os.write(master, b"n")
        step = 1
    elif step == 1 and "NEW SESSION" in text and "repo" in text and "Create and attach" in text:
        if action_row is None:
            action_row = now + 1.5
        elif now >= action_row:
            row = 9 if "host/source error(s)" in text else 8
            output.clear()
            click(10, row)
            action_row = row
            step = 2
    elif step == 2 and "Choose action/template" in text and "review" in text:
        output.clear()
        click(10, action_row + 7)
        step = 3
    elif step == 3 and "Review template prompt" in text:
        # A click on the focused field's own row must keep the selected template.
        output.clear()
        click(10, action_row)
        next_input = now + 0.5
        step = 4
    elif step == 4 and now >= next_input:
        click(10, action_row + 8)
        step = 5
    elif step == 5 and '"session","new"' in trace() and "Work is unavailable" in text:
        os.write(master, b"q")
        next_input = now + 0.3
        step = 6
    elif step == 6 and now >= next_input:
        os.write(master, b"q")
        next_input = now + 0.3
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
os.close(master)
print(json.dumps({"exit": child.returncode, "step": step, **({"trace": trace()} if child.returncode != 0 else {})}))
`;

async function runPty(mode: "main" | "new-session", key: string): Promise<{ exit: number; sent: boolean; alternate: boolean; restored: boolean; screen: boolean }> {
  const app = join(import.meta.dir, "../../src/ink/app.tsx");
  const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:${JSON.stringify(mode)},selfBin:"/missing/pohunek-work",pohunekBin:"/missing/pohunek",timeoutMs:100,listTimeoutMs:100,launchTimeoutMs:100,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,outputMaxBytes:65536,detailMinWidth:120});`;
  const process = Bun.spawn(["python3", "-c", PYTHON_PTY, Bun.which("bun") ?? "bun", source, mode === "main" ? "pohunek-work" : "pohunek-work new-session", Buffer.from(key).toString("hex")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout) as { exit: number; sent: boolean; alternate: boolean; restored: boolean; screen: boolean };
}

/** Stand-ins and daemons started by a scenario; stopped after it, also when the scenario fails. */
const stopLater: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stopLater.splice(0)) await stop();
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

test("the Ink process enters and restores the terminal when the owner quits", async () => {
  const result = await runPty("main", "q");
  expect(result).toEqual({ exit: 0, sent: true, alternate: true, restored: true, screen: true });
}, 20_000);

test("the standalone session form cancels before creating a session", async () => {
  const result = await runPty("new-session", "\u001b");
  expect(result).toEqual({ exit: 0, sent: true, alternate: true, restored: true, screen: true });
}, 20_000);

test("click and horizontal arrows switch tabs and mouse tracking is restored on exit", async () => {
  const daemon = await startCoreDaemon();
  stopLater.push(() => daemon.stop());
  const app = join(import.meta.dir, "../../src/ink/app.tsx");
  const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:"/missing/pohunek",timeoutMs:100,listTimeoutMs:100,launchTimeoutMs:100,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",localSocket:${JSON.stringify(daemonLocalSocket(daemon))},reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,outputMaxBytes:65536,detailMinWidth:120});`;
  const process = Bun.spawn(["python3", "-c", PYTHON_MOUSE_PTY, Bun.which("bun") ?? "bun", source], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ exit: 0, clicked: true, switched: true, right_switched: true, left_switched: true, mouse_off: true });
}, REAL_SCENARIO_TIMEOUT_MS);

test("the standalone session form focuses a text field by click", async () => {
  const daemon = await startCoreDaemon();
  stopLater.push(() => daemon.stop());
  const app = join(import.meta.dir, "../../src/ink/app.tsx");
  const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"new-session",selfBin:"/missing/pohunek-work",pohunekBin:"/missing/pohunek",timeoutMs:100,listTimeoutMs:100,launchTimeoutMs:100,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",localSocket:${JSON.stringify(daemonLocalSocket(daemon))},reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,outputMaxBytes:65536,detailMinWidth:120});`;
  const process = Bun.spawn(["python3", "-c", PYTHON_FORM_MOUSE_PTY, Bun.which("bun") ?? "bun", source], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ exit: 0, clicked: true, edited: true });
}, REAL_SCENARIO_TIMEOUT_MS);

// The assistant option list and its launch are the release CLI's with a scripted host: the test host has no
// assistant-capable agent installed, so `host inspect` and `assistant` are answered by this scenario's binary.
// Session reads come from the stand-in (empty here).
test("a second form launches an assistant with a capable default agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-ink-forms-"));
  try {
    const binary = join(directory, "pohunek");
    const trace = join(directory, "trace.jsonl");
    await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
const calls = readFileSync(${JSON.stringify(trace)}, "utf8").trim().split("\\n").map(JSON.parse);
const ok = (value) => console.log(JSON.stringify({cli_version:"0.33.1",protocol:{minimum:4,maximum:4},ok:value}));
if (args[0] === "host" && (args[1] === "discover" || args[1] === "list")) ok([]);
else if (args[0] === "host" && args[1] === "inspect") ok({runtimes:[{agent:"shell",agent_base:"shell",available:true},{agent:"codex",agent_base:"codex",available:true,supported:true}]});
else if (args[0] === "project" && args[1] === "list") ok([]);
else if (args[2] === "session" && args[3] === "list") ok([]);
else if (args[2] === "project" && args[3] === "list") ok([]);
else if (args[2] === "notifications" && args[3] === "list") ok({notifications:[],next_cursor:null});
else if (args[0] === "session" && args[1] === "new") { const number = calls.filter((call) => call[0] === "session" && call[1] === "new").length; ok({id:"created-" + number,...(number === 1 ? {warnings:[{kind:"base_branch_fallback",message:"private branch detail"}]} : {})}); }
else if (args[0] === "assistant") ok({session:{id:"assistant-2"},assistant:{intent:"help"}});
else if (args[0] === "attach") process.exit(0);
else process.exit(70);
`);
    await chmod(binary, 0o700);
    const standIn = await startSdkStandIn(binary);
    stopLater.push(standIn.stop);
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:${JSON.stringify(binary)},timeoutMs:2000,listTimeoutMs:100,launchTimeoutMs:2000,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",localSocket:${JSON.stringify(standIn.socket)},reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,outputMaxBytes:65536,detailMinWidth:120});`;
    const process = Bun.spawn(["python3", "-c", PYTHON_TWO_FORMS_PTY, Bun.which("bun") ?? "bun", source, trace], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ exit: 0, step: 7, paused: true });
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((call) => call[0] === "session" && call[1] === "new")).toHaveLength(1);
    const assistant = calls.find((call) => call[0] === "assistant");
    expect(assistant).toContain("codex");
    expect(assistant).not.toContain("shell");
    expect(calls.filter((call) => call[0] === "attach").map((call) => call.at(-1))).toEqual(["created-1", "assistant-2"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("a Work item shows its plan before an explicit action is run", async () => {
  const daemon = await startCoreDaemon();
  stopLater.push(() => daemon.stop());
  const directory = await mkdtemp(join(tmpdir(), "pohunek-ink-work-"));
  try {
    const binary = join(directory, "pohunek-work");
    const core = join(daemon.coreDir, "pohunek");
    const trace = join(directory, "trace.jsonl");
    // The work sources (GitHub, Linear) are not part of the daemon, so the work list is answered by this
    // scenario's binary; the core CLI and the local socket are the real daemon's.
    await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
const envelope = (version, payload) => console.log(JSON.stringify({cli_version:"0.5.0",protocol:{minimum:version,maximum:version},...payload}));
if (args[0] === "list") envelope(4, {ok:{items:[{key:"github-issue:acme/repo#1",project:"repo",issue:{id:"1",title:"Review this",state:"open",url:"https://github.com/acme/repo/issues/1"},pull_request:null,no_issue:false,issue_key:null,sessions:[],on_turn:{actor:"me",reason:"review",rule:1},actions:[{name:"review",delegable:true}],ignored:false,sources:{github:"ok",github_merged:"ok",linear:"unused",github_issues:"ok",pohunek:"ok"}}],orphaned_sessions:[],unlinked_sessions:[],projects:[],omitted_ignored:0}});
else if (args[0] === "do" && args.includes("--dry-run")) envelope(1, {ok:{dry_run:true,plan:{action:"review",key:"github-issue:acme/repo#1",name:"Review this"}}});
else if (args[0] === "do") { envelope(1, {err:{class:"action",code:"confirmation_required",msg:"owner declined"}}); process.exit(2); }
else process.exit(70);
`);
    await chmod(binary, 0o700);
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:${JSON.stringify(binary)},pohunekBin:${JSON.stringify(core)},timeoutMs:2000,listTimeoutMs:2000,launchTimeoutMs:100,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",localSocket:${JSON.stringify(daemonLocalSocket(daemon))},reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,outputMaxBytes:65536,detailMinWidth:120});`;
    const process = Bun.spawn(["python3", "-c", PYTHON_WORK_RESULT_PTY, Bun.which("bun") ?? "bun", source, trace], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ exit: 0, step: 9, mouse_opened: true, keyboard_opened: true, no_automatic_action: true, previewed: true, mouse_action_previewed: true });
    expect(await readFile(trace, "utf8")).toContain('["do","github-issue:acme/repo#1","review","--project","repo","--dry-run","--json"]');
    expect(await readFile(trace, "utf8")).toContain('["do","github-issue:acme/repo#1","review","--project","repo","--json"]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, REAL_SCENARIO_TIMEOUT_MS);

// The lost runtime, the resume capability and the native target come from the stand-in relaying this scenario's
// binary, because the daemon offers resume only for a profile on an agent base (a `[resume]` table on a shell
// base is rejected by the daemon, per the core agent-profiles concept), and such a base needs its CLI installed
// with hooks that report the native conversation, which CI does not have. Actions are recorded by the same binary.
test("a lost session offers recovery and removal without offering direct attachment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-ink-lost-"));
  try {
    const binary = join(directory, "pohunek");
    const trace = join(directory, "trace.jsonl");
    await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
const ok = (value) => console.log(JSON.stringify({cli_version:"0.33.1",protocol:{minimum:4,maximum:4},ok:value}));
const session = {id:"lost-1",name:"Lost session",agent:"codex",cwd:"/repo",state:"running",activity:"working",runtime:{state:"lost"},capabilities:{resume:true,fork:false},updated_at:"2026-10-09T10:00:00Z",project_id:"p1",project_label:"repo",branch:"main",metadata:{},subagents:[]};
if (args[0] === "host" && args[1] === "discover") ok([]);
else if (args[2] === "session" && args[3] === "list") ok([session]);
else if (args[2] === "session" && args[3] === "inspect") ok(session);
else if (args[2] === "session" && args[3] === "resume") ok({session:{...session,runtime:{state:"active"}}});
else if (args[2] === "session" && args[3] === "stop") ok({stopped:true});
else if (args[2] === "session" && args[3] === "rm") ok({removed:true,stopped:false,worktrees_removed:0,worktrees_failed:0});
else if (args[2] === "project" && args[3] === "list") ok([]);
else if (args[2] === "notifications" && args[3] === "list") ok({notifications:[],next_cursor:null});
else if (args[0] === "attach") process.exit(0);
else process.exit(70);
`);
    await chmod(binary, 0o700);
    const standIn = await startSdkStandIn(binary);
    stopLater.push(standIn.stop);
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:${JSON.stringify(binary)},timeoutMs:2000,listTimeoutMs:100,launchTimeoutMs:2000,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",localSocket:${JSON.stringify(standIn.socket)},reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,outputMaxBytes:65536,detailMinWidth:120});`;
    const process = Bun.spawn(["python3", "-c", PYTHON_LOST_SESSION_PTY, Bun.which("bun") ?? "bun", source, trace], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ exit: 0, step: 7, resume_visible: true, remove_visible: true, attach_hidden: true });
    const calls = await readFile(trace, "utf8");
    expect(calls).toContain('["--host","local","session","resume","lost-1","--json"]');
    expect(calls).toContain('["--host","local","session","rm","lost-1","--json"]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);

// Project templates are answered by this scenario's binary: the test daemon has no project with action
// templates. Session reads come from the stand-in (empty here).
test("switching from a template to blank clears its launch fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-ink-template-"));
  try {
    const binary = join(directory, "pohunek");
    const trace = join(directory, "trace.jsonl");
    await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
const ok = (value) => console.log(JSON.stringify({cli_version:"0.33.1",protocol:{minimum:4,maximum:4},ok:value}));
if (args[0] === "host" && (args[1] === "discover" || args[1] === "list")) ok([]);
else if (args[0] === "host" && args[1] === "inspect") ok({runtimes:[{agent:"codex",agent_base:"codex",available:true,supported:true}]});
else if (args[0] === "project" && args[1] === "list") ok([{id:"p1",label:"repo",repo_root:"/repo",git_common_dir:"/repo/.git"}]);
else if (args[0] === "project" && args[1] === "actions") ok({actions:[{name:"review",provider:"none",template:"review-prompt",layer:"in_repo"}]});
else if (args[0] === "project" && args[1] === "action") ok({provider:"none",agent:"codex",branch:"review/topic",base_branch:"main",prompt_name:"review-prompt",prompt_content:"Review template prompt"});
else if (args[2] === "session" && args[3] === "list") ok([]);
else if (args[2] === "project" && args[3] === "list") ok([{id:"p1",label:"repo",repo_root:"/repo",git_common_dir:"/repo/.git"}]);
else if (args[2] === "notifications" && args[3] === "list") ok({notifications:[],next_cursor:null});
else if (args[0] === "session" && args[1] === "new") ok({id:"blank-created"});
else if (args[0] === "attach") process.exit(0);
else process.exit(70);
`);
    await chmod(binary, 0o700);
    const standIn = await startSdkStandIn(binary);
    stopLater.push(standIn.stop);
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:${JSON.stringify(binary)},timeoutMs:2000,listTimeoutMs:100,launchTimeoutMs:2000,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",localSocket:${JSON.stringify(standIn.socket)},reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,outputMaxBytes:65536,detailMinWidth:120});`;
    const process = Bun.spawn(["python3", "-c", PYTHON_TEMPLATE_PTY, Bun.which("bun") ?? "bun", source, trace], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ exit: 0, step: 6 });
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const create = calls.find((call) => call[0] === "session" && call[1] === "new");
    expect(create).toBeDefined();
    expect(create).not.toContain("--agent");
    expect(create).not.toContain("--branch");
    expect(create).not.toContain("--base-branch");
    expect(create).not.toContain("--input-stdin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

// Project templates are answered by this scenario's binary: the test daemon has no project with action
// templates. Session reads come from the stand-in (empty here).
test("clicking the focused template field does not change the selected template", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-ink-focused-choice-"));
  try {
    const binary = join(directory, "pohunek");
    const trace = join(directory, "trace.jsonl");
    await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
const ok = (value) => console.log(JSON.stringify({cli_version:"0.33.1",protocol:{minimum:4,maximum:4},ok:value}));
if (args[0] === "host" && (args[1] === "discover" || args[1] === "list")) ok([]);
else if (args[0] === "host" && args[1] === "inspect") ok({runtimes:[{agent:"codex",agent_base:"codex",available:true,supported:true}]});
else if (args[0] === "project" && args[1] === "list") ok([{id:"p1",label:"repo",repo_root:"/repo",git_common_dir:"/repo/.git"}]);
else if (args[0] === "project" && args[1] === "actions") ok({actions:[{name:"review",provider:"none",template:"review-prompt",layer:"in_repo"}]});
else if (args[0] === "project" && args[1] === "action") ok({provider:"none",agent:"codex",branch:"review/topic",base_branch:"main",prompt_name:"review-prompt",prompt_content:"Review template prompt"});
else if (args[2] === "session" && args[3] === "list") ok([]);
else if (args[2] === "project" && args[3] === "list") ok([{id:"p1",label:"repo",repo_root:"/repo",git_common_dir:"/repo/.git"}]);
else if (args[2] === "notifications" && args[3] === "list") ok({notifications:[],next_cursor:null});
else if (args[0] === "session" && args[1] === "new") { if (args.includes("--input-stdin")) appendFileSync(${JSON.stringify(trace)}, JSON.stringify(["prompt", await Bun.stdin.text()]) + "\\n"); ok({id:"template-created"}); }
else if (args[0] === "attach") process.exit(0);
else process.exit(70);
`);
    await chmod(binary, 0o700);
    const standIn = await startSdkStandIn(binary);
    stopLater.push(standIn.stop);
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:${JSON.stringify(binary)},timeoutMs:2000,listTimeoutMs:100,launchTimeoutMs:2000,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",localSocket:${JSON.stringify(standIn.socket)},reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,outputMaxBytes:65536,detailMinWidth:120});`;
    const process = Bun.spawn(["python3", "-c", PYTHON_FOCUSED_CHOICE_PTY, Bun.which("bun") ?? "bun", source, trace], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ exit: 0, step: 6 });
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(calls).toContainEqual(["prompt", "Review template prompt"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
