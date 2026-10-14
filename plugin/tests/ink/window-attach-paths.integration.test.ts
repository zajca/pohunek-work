// Window attach on the paths that open a session other than `o`: the recovery-confirmed resume, and a
// new-session process whose session is created and opened in a window. The window terminal is a stub that
// records its argv and stays alive, as a real terminal window does.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSdkStandIn } from "../helpers/sdk-stand-in.ts";
import { keys, runPty, type PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const LAUNCH_CHECK_MS = 500;
const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;
const TAB = "09";
const ENTER = "0d";
// Tabs from the first field to the create button, as the main TUI form takes them.
const TABS_TO_CREATE = 7;
let scenario: TuiScenario | null = null;
let directory: string | null = null;
let pidFile: string | null = null;
const stopLater: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stopLater.splice(0)) await stop();
  if (pidFile !== null) {
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  }
  pidFile = null;
  await scenario?.stop();
  scenario = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

/** A window terminal stub: records its argv, then stays alive. */
async function recordingTerminal(dir: string): Promise<{ path: string; trace: string }> {
  const sleep = Bun.which("sleep");
  if (sleep === null) throw new Error("sleep is not on PATH; the terminal stub needs it");
  const trace = join(dir, "argv.txt");
  const path = join(dir, "terminal-stub");
  pidFile = join(dir, "terminal.pid");
  await writeFile(path, `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg"; done > ${JSON.stringify(trace)}
echo $$ > ${JSON.stringify(pidFile)}
exec ${JSON.stringify(sleep)} 60
`);
  await chmod(path, 0o700);
  return { path, trace };
}

test("a recovery-confirmed resume opens the resumed session in a window", async () => {
  directory = await mkdtemp(join(tmpdir(), "pohunek-window-resume-"));
  const terminal = await recordingTerminal(directory);
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
else process.exit(70);
`);
  await chmod(binary, 0o700);
  // Same stand-in as the recovery scenario: the native target exists only for an agent this CI cannot run.
  const standIn = await startSdkStandIn(binary);
  stopLater.push(standIn.stop);
  const app = join(import.meta.dir, "../../src/ink/app.tsx");
  const source = `import {runInkTui} from ${JSON.stringify(app)}; process.exitCode = await runInkTui({mode:"main",selfBin:"/missing/pohunek-work",pohunekBin:${JSON.stringify(binary)},timeoutMs:2000,listTimeoutMs:100,launchTimeoutMs:2000,launchKillMarginMs:100,notificationsPageSize:10,refreshIntervalMs:100000,initialView:"all",stalePrDays:14,openUrlHosts:["github.com"],openCommand:"/missing/open",localSocket:${JSON.stringify(standIn.socket)},reconnectMaxMs:1000,sessionReconcileMs:300000,actionCaptureBytes:4194304,outputWaitMs:1000,outputMaxBytes:65536,detailMinWidth:120,attachMode:"window",attachCommand:[${JSON.stringify(terminal.path)},"--id={id}"],attachLaunchCheckMs:${LAUNCH_CHECK_MS}});`;
  const result = await runPty({
    cmd: [Bun.which("bun") ?? "bun", "--eval", source],
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", TERM: "xterm-256color", CI: "true" },
    cols: 120,
    rows: 40,
    steps: [
      { expect: "CONTROL CENTER" },
      { send: TAB, settle: 300 },
      { expect: "Recovery session" },
      { pause: 2500 },
      keys("o"),
      { expect: "RECOVERY TARGET" },
      keys("y"),
      { expect: "Session s1 opened in a new window" },
      keys("q"),
    ],
    timeoutS: 40,
  });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const resumes = (await readFile(trace, "utf8")).trim().split("\n").filter((call) => call.includes('"resume"'));
  expect(resumes).toHaveLength(1);
  expect((await readFile(terminal.trace, "utf8")).split("\n").filter((line) => line !== "")).toEqual(["--id=s1"]);
}, SCENARIO_TIMEOUT_MS);

test("a new-session that creates its session opens it in a window and prints the line before it exits", async () => {
  directory = await mkdtemp(join(tmpdir(), "pohunek-window-new-"));
  const terminal = await recordingTerminal(directory);
  // The form lists hosts too; without an overlay the core refuses that list, so an empty answer keeps Local available.
  scenario = await startTuiScenario({
    rules: [{ match: ["host", "list"], appendOk: [] }],
    overrides: { "tui.attach_mode": "window", "tui.attach_command": `${terminal.path} --id={id}`, "tui.attach_launch_check_ms": LAUNCH_CHECK_MS },
  });
  const result = await runPty({
    cmd: [Bun.which("bun") ?? "bun", MAIN, "new-session"],
    env: { ...scenario.fixture.env, TERM: "xterm-256color", CI: "true" },
    cols: 120,
    rows: 40,
    steps: [
      { expect: "NEW SESSION" },
      // The keys sent before the form has its input handler are lost, so the first key waits for it.
      { pause: 800 },
      ...Array.from({ length: TABS_TO_CREATE }, (): PtyStep => ({ send: TAB, settle: 150 })),
      { send: ENTER },
      // Creating the session takes a while on the daemon; the window status comes before the process exits.
      { expect: "opened", timeout: 30000 },
      // The process exits once the window is open; the line is printed after the screen is restored.
      { pause: 2000 },
    ],
    timeoutS: 60,
  });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(result.exit).toBe(0);
  const [argument] = (await readFile(terminal.trace, "utf8")).split("\n").filter((line) => line !== "");
  expect(argument).toMatch(/^--id=/);
  const id = (argument ?? "").slice("--id=".length);
  expect(result.output).toContain(`opened ${id} in a new window`);
}, SCENARIO_TIMEOUT_MS);
