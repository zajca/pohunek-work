import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { startSdkStandIn } from "../helpers/sdk-stand-in.ts";

/** Stand-ins started by the scenario; stopped after it, also when it fails. */
const stopLater: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stopLater.splice(0)) await stop();
});
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drives the Ink app in a pseudo-terminal against a fake core CLI: the owner opens
// a lost-session row, asks for a resume, sees the verified native target, cancels
// once (no resume call) and confirms once (exactly one resume call).
const PYTHON_RECOVERY_PTY = String.raw`
import fcntl, json, os, pty, re, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
child = subprocess.Popen([sys.argv[1], "--eval", sys.argv[2]], stdin=slave, stdout=slave, stderr=slave, env={**os.environ, "TERM": "xterm-256color", "CI": "true"})
os.close(slave)
trace_path = sys.argv[3]
def trace():
    try:
        with open(trace_path) as handle:
            return handle.read()
    except OSError:
        return ""
output = bytearray()
step = "tabs"
last_sent = 0.0
shown = False
target_shown = False
cancel_resumed = None
confirmed_resumed = False
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            output.extend(os.read(master, 65536))
        except OSError:
            break
    plain = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", bytes(output))
    now = time.monotonic()
    if step == "tabs" and b"Work" in plain:
        os.write(master, b"\t")
        step = "sessions"
        output.clear()
    elif step == "sessions" and b"Recovery session" in plain:
        os.write(master, b"\r")
        step = "open"
        last_sent = now
        output.clear()
    elif step == "open" and now - last_sent > 0.5:
        # Enter opens the recovery from the list; a resend waits for the overlay, since any key closes it.
        if b"RECOVERY TARGET" in plain:
            shown = True
            target_shown = b"native-1" in plain and b"2026-10-09T09:00:00Z" in plain
            os.write(master, b"n")
            step = "cancelled"
            last_sent = now
            output.clear()
        else:
            os.write(master, b"\r")
            last_sent = now
    elif step == "cancelled" and now - last_sent > 1.5:
        cancel_resumed = '"resume"' in trace()
        step = "reopen"
        last_sent = now
        output.clear()
    elif step == "reopen" and now - last_sent > 0.5:
        if b"RECOVERY TARGET" in plain:
            os.write(master, b"y")
            step = "confirmed"
            last_sent = now
        else:
            os.write(master, b"\r")
            last_sent = now
    elif step == "confirmed" and '"resume"' in trace():
        confirmed_resumed = True
        time.sleep(0.5)
        os.write(master, b"q")
        step = "done"
    if child.poll() is not None:
        break
if child.poll() is None:
    child.kill()
child.wait()
os.close(master)
print(json.dumps({"exit": child.returncode, "step": step, "shown": shown, "target_shown": target_shown,
                  "cancel_resumed": cancel_resumed, "confirmed_resumed": confirmed_resumed}))
`;

// The native target and the resume capability come from the stand-in relaying this scenario's binary. A
// `[resume]` table on a shell base is rejected by the daemon, and an agent base needs its CLI installed with hooks
// that report the native conversation; CI has neither, so the daemon cannot produce this state there.
test("a resume waits for the owner to confirm the verified native target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-ink-recovery-"));
  try {
    const binary = join(directory, "pohunek");
    const trace = join(directory, "trace.jsonl");
    await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + "\\n");
const session = {
  id: "s1", name: "Recovery session", agent: "claude", cwd: "/repo", state: "exited", activity: null,
  updated_at: "2026-10-09T10:00:00Z", project_id: "p1", project_label: "repo", branch: "main", worktree_path: "/repo",
  metadata: {}, subagents: [], capabilities: { resume: true, fork: true }, runtime: { state: "stopped" },
  native_session_id: "native-1", native_last_activity_at: "2026-10-09T09:00:00Z",
};
const ok = (value) => console.log(JSON.stringify({cli_version:"0.34.2",protocol:{minimum:4,maximum:4},ok:value}));
if (args[0] === "host" && args[1] === "discover") ok([]);
else if (args[2] === "session" && args[3] === "list") ok([session]);
else if (args[2] === "session" && args[3] === "inspect") ok(session);
else if (args[2] === "session" && args[3] === "resume") ok({session: {...session, state: "running"}});
else if (args[2] === "project" && args[3] === "list") ok([]);
else if (args[2] === "notifications" && args[3] === "list") ok({notifications:[],next_cursor:null});
else if (args[0] === "attach") process.exit(0);
else process.exit(70);
`);
    await chmod(binary, 0o700);
    // The native conversation and resume capability exist only for an agent the release cannot run here;
    // the stand-in serves the session list from this scenario's binary, the CLI keeps every action.
    const standIn = await startSdkStandIn(binary);
    stopLater.push(standIn.stop);
    const app = join(import.meta.dir, "../../src/ink/app.tsx");
    const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:${JSON.stringify(binary)},timeoutMs:2000,listTimeoutMs:100,launchTimeoutMs:2000,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"all",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",localSocket:${JSON.stringify(standIn.socket)},reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,doubleClickMs:500,outputMaxBytes:65536,detailMinWidth:120});`;
    const process = Bun.spawn(["python3", "-c", PYTHON_RECOVERY_PTY, Bun.which("bun") ?? "bun", source, trace], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(exit, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      exit: 0, step: "done", shown: true, target_shown: true, cancel_resumed: false, confirmed_resumed: true,
    });
    const calls = (await readFile(trace, "utf8")).trim().split("\n");
    expect(calls.filter((call) => call.includes('"resume"'))).toEqual(['["--host","local","session","resume","s1","--json"]']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
