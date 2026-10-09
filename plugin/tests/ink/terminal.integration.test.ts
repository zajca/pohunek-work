import { expect, test } from "bun:test";
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
clicked = False
switched = False
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    if not clicked and b"\x1b[?1006h" in output:
        os.write(master, b"\x1b[<0;17;3M")
        clicked = True
    if clicked and not switched and b"No sessions" in output:
        switched = True
        os.write(master, b"q")
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
print(json.dumps({"exit": child.returncode, "clicked": clicked, "switched": switched, "mouse_off": b"\x1b[?1006l" in output}))
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
    if not clicked and b"\x1b[?1006h" in output and b"host list: cannot start" in output:
        os.write(master, b"\x1b[<0;10;11Mmouse-name")
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

const PYTHON_LIST_MOUSE_PTY = String.raw`
import fcntl, json, os, pty, re, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
output = bytearray()
step = 0
next_input = 0
mouse_scrolled = False
keyboard_scrolled = False
screen_start = 0
deadline = time.monotonic() + 20
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    now = time.monotonic()
    if step == 0 and b"\x1b[?1006h" in output:
        os.write(master, b"\x1b[<0;17;3M")
        step = 1
    elif step == 1 and b"SESSIONS  12" in output and b"Session 1" in output and b"New session" in output:
        time.sleep(0.2)
        os.write(master, b"\x1b[<65;10;8M")
        next_input = time.monotonic() + 0.3
        step = 2
    elif step == 2 and now >= next_input:
        os.write(master, b"\r")
        step = 3
    elif step == 3 and os.path.exists(sys.argv[3]) and '"inspect","s2"' in open(sys.argv[3]).read():
        output.clear()
        os.write(master, b"p")
        step = 4
    elif step == 4 and os.path.exists(sys.argv[3]) and '"screen","s2"' in open(sys.argv[3]).read():
        positions = re.findall(rb"(\d+)\xe2\x80\x93(\d+) / (\d+)", output)
        if positions:
            screen_start = int(positions[-1][0])
            output.clear()
            os.write(master, b"\x1b[<64;10;8M")
            step = 5
    elif step == 5:
        positions = re.findall(rb"(\d+)\xe2\x80\x93(\d+) / (\d+)", output)
        if positions and int(positions[-1][0]) < screen_start:
            mouse_scrolled = True
            screen_start = int(positions[-1][0])
            output.clear()
            os.write(master, b"\x1b[5~")
            step = 6
    elif step == 6:
        positions = re.findall(rb"(\d+)\xe2\x80\x93(\d+) / (\d+)", output)
        if positions and int(positions[-1][0]) < screen_start:
            keyboard_scrolled = True
            os.write(master, b"\x1b")
            next_input = now + 0.3
            step = 7
    elif step == 7 and now >= next_input:
        os.write(master, b"\x1b[<0;10;13M")
        next_input = now + 0.3
        step = 8
    elif step == 8 and now >= next_input:
        os.write(master, b"\r")
        step = 9
    elif step == 9 and os.path.exists(sys.argv[3]) and '"inspect","s4"' in open(sys.argv[3]).read():
        os.write(master, b"\x1b")
        next_input = now + 0.3
        step = 10
    elif step == 10 and now >= next_input:
        os.write(master, b"\x1b[<0;10;9M")
        next_input = now + 0.3
        step = 11
    elif step == 11 and now >= next_input:
        os.write(master, b"o")
        step = 12
    elif step == 12 and os.path.exists(sys.argv[3]) and '["attach","--host","local","--","s2"]' in open(sys.argv[3]).read():
        next_input = now + 0.3
        step = 13
    elif step == 13 and now >= next_input:
        os.write(master, b"q")
        next_input = now + 0.3
        step = 14
    elif step == 14 and now >= next_input:
        os.write(master, b"q")
        next_input = now + 0.3
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
os.close(master)
print(json.dumps({"exit": child.returncode, "step": step, "mouse_scrolled": mouse_scrolled, "keyboard_scrolled": keyboard_scrolled}))
`;

const PYTHON_TWO_FORMS_PTY = String.raw`
import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time
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
    elif step == 1 and b"NEW SESSION" in output and b"Create and attach" in output:
        output.clear()
        os.write(master, b"\x1b[<0;10;15M")
        step = 2
    elif step == 2 and b"Launch warning: base_branch_fallback" in output:
        paused = not any(call[:2] == ["attach", "--host"] for call in calls())
        os.write(master, b"\x1b[<0;10;8M")
        step = 3
    elif step == 3 and any(call[:2] == ["attach", "--host"] for call in calls()) and b"Work is unavailable" in output:
        output.clear()
        os.write(master, b"\x1b[<0;17;3M")
        step = 4
    elif step == 4 and b"No sessions" in output:
        output.clear()
        os.write(master, b"a")
        step = 5
    elif step == 5 and b"NEW ASSISTANT" in output and b"Create and attach" in output:
        output.clear()
        os.write(master, b"\x1b[<0;10;14M")
        step = 6
    elif step == 6 and len([call for call in calls() if call[:2] == ["attach", "--host"]]) == 2 and b"No sessions" in output:
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
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.05)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    if step == 0 and b"WORK  1 items" in output:
        os.write(master, b"\r")
        step = 1
    elif step == 1 and b"confirmation_required: owner declined" in output:
        os.write(master, b"q")
        step = 2
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
os.close(master)
print(json.dumps({"exit": child.returncode, "step": step}))
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
        os.write(master, b"\x1b[<0;10;9M")
        step = 2
    elif step == 2 and b"Choose action/template" in output and b"review" in output:
        output.clear()
        os.write(master, b"\x1b[<0;10;16M")
        step = 3
    elif step == 3 and b"Review template prompt" in output:
        output.clear()
        os.write(master, b"\x1b[<0;10;15M")
        next_input = now + 0.1
        step = 4
    elif step == 4 and now >= next_input:
        os.write(master, b"\x1b[<0;10;17M")
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

async function runPty(mode: "main" | "new-session", key: string): Promise<{ exit: number; sent: boolean; alternate: boolean; restored: boolean; screen: boolean }> {
  const app = join(import.meta.dir, "../../src/ink/app.tsx");
  const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:${JSON.stringify(mode)},selfBin:"/missing/pohunek-work",pohunekBin:"/missing/pohunek",timeoutMs:100,listTimeoutMs:100,launchTimeoutMs:100,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open"});`;
  const process = Bun.spawn(["python3", "-c", PYTHON_PTY, Bun.which("bun") ?? "bun", source, mode === "main" ? "pohunek-work" : "pohunek-work new-session", Buffer.from(key).toString("hex")], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(exit, stderr).toBe(0);
  return JSON.parse(stdout) as { exit: number; sent: boolean; alternate: boolean; restored: boolean; screen: boolean };
}

test("the Ink process enters and restores the terminal when the owner quits", async () => {
  const result = await runPty("main", "q");
  expect(result).toEqual({ exit: 0, sent: true, alternate: true, restored: true, screen: true });
}, 20_000);

test("the standalone session form cancels before creating a session", async () => {
  const result = await runPty("new-session", "\u001b");
  expect(result).toEqual({ exit: 0, sent: true, alternate: true, restored: true, screen: true });
}, 20_000);

test("a mouse click switches tabs and mouse tracking is restored on exit", async () => {
  const app = join(import.meta.dir, "../../src/ink/app.tsx");
  const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:"/missing/pohunek",timeoutMs:100,listTimeoutMs:100,launchTimeoutMs:100,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open"});`;
  const process = Bun.spawn(["python3", "-c", PYTHON_MOUSE_PTY, Bun.which("bun") ?? "bun", source], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ exit: 0, clicked: true, switched: true, mouse_off: true });
}, 20_000);

test("the standalone session form focuses a text field by click", async () => {
  const app = join(import.meta.dir, "../../src/ink/app.tsx");
  const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"new-session",selfBin:"/missing/pohunek-work",pohunekBin:"/missing/pohunek",timeoutMs:100,listTimeoutMs:100,launchTimeoutMs:100,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open"});`;
  const process = Bun.spawn(["python3", "-c", PYTHON_FORM_MOUSE_PTY, Bun.which("bun") ?? "bun", source], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ exit: 0, clicked: true, edited: true });
}, 20_000);

test("mouse selection and attach target the current session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-ink-mouse-"));
  try {
    const binary = join(directory, "pohunek");
    const trace = join(directory, "trace.jsonl");
    await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
const session = (number) => ({ id: "s" + number, name: "Session " + number, agent: "codex", cwd: "/repo", state: "running", activity: "working", updated_at: "2026-10-09T10:00:00Z", project_id: "p1", project_label: "repo", branch: "main", metadata: {}, subagents: [] });
const ok = (value) => console.log(JSON.stringify({cli_version:"0.33.1",protocol:{minimum:4,maximum:4},ok:value}));
if (args[0] === "host" && args[1] === "discover") ok([]);
else if (args[2] === "session" && args[3] === "list") ok(Array.from({length:12}, (_, index) => session(index + 1)));
else if (args[2] === "session" && args[3] === "inspect") ok(session(Number(args[4].slice(1))));
else if (args[2] === "session" && args[3] === "screen") ok({session_id:args[4],title:"terminal",progress:null,visible_lines:Array.from({length:40},(_,index)=>"SCREEN_LINE_"+(index+1))});
else if (args[2] === "project" && args[3] === "list") ok([]);
else if (args[2] === "notifications" && args[3] === "list") ok({notifications:[],next_cursor:null});
else if (args[0] === "attach") process.exit(0);
else process.exit(70);
`);
    await chmod(binary, 0o700);
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:${JSON.stringify(binary)},timeoutMs:2000,listTimeoutMs:100,launchTimeoutMs:2000,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open"});`;
    const process = Bun.spawn(["python3", "-c", PYTHON_LIST_MOUSE_PTY, Bun.which("bun") ?? "bun", source, trace], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ exit: 0, step: 14, mouse_scrolled: true, keyboard_scrolled: true });
    expect(await readFile(trace, "utf8")).toContain('["--host","local","session","inspect","s2","--json"]');
    expect(await readFile(trace, "utf8")).toContain('["--host","local","session","inspect","s4","--json"]');
    expect(await readFile(trace, "utf8")).toContain('["attach","--host","local","--","s2"]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

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
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:${JSON.stringify(binary)},timeoutMs:2000,listTimeoutMs:100,launchTimeoutMs:2000,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open"});`;
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

test("a refused Work action remains visible after terminal handover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-ink-work-"));
  try {
    const binary = join(directory, "pohunek-work");
    const trace = join(directory, "trace.jsonl");
    await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
const envelope = (version, payload) => console.log(JSON.stringify({cli_version:"0.5.0",protocol:{minimum:version,maximum:version},...payload}));
if (args[0] === "list") envelope(4, {ok:{items:[{key:"github-issue:acme/repo#1",project:"repo",issue:{id:"1",title:"Review this",state:"open",url:"https://github.com/acme/repo/issues/1"},pull_request:null,no_issue:false,issue_key:null,sessions:[],on_turn:{actor:"me",reason:"review",rule:1},actions:[{name:"review",delegable:true}],ignored:false,sources:{github:"ok",github_merged:"ok",linear:"unused",github_issues:"ok",pohunek:"ok"}}],orphaned_sessions:[],unlinked_sessions:[],projects:[],omitted_ignored:0}});
else if (args[0] === "do") { envelope(1, {err:{class:"action",code:"confirmation_required",msg:"owner declined"}}); process.exit(2); }
else process.exit(70);
`);
    await chmod(binary, 0o700);
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:${JSON.stringify(binary)},pohunekBin:"/missing/pohunek",timeoutMs:100,listTimeoutMs:2000,launchTimeoutMs:100,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open"});`;
    const process = Bun.spawn(["python3", "-c", PYTHON_WORK_RESULT_PTY, Bun.which("bun") ?? "bun", source], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ exit: 0, step: 2 });
    expect(await readFile(trace, "utf8")).toContain('["do","github-issue:acme/repo#1","review","--project","repo","--json"]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

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
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:${JSON.stringify(binary)},timeoutMs:2000,listTimeoutMs:100,launchTimeoutMs:2000,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"mine",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open"});`;
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
