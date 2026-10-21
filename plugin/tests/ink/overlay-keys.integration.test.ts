// A non-modal overlay (the session detail and the work item detail) consumes every key it does not handle. q, ?
// and the digits 1-4 do nothing inside it: they neither quit, open help nor switch the view. Esc closes the overlay
// onto the view it was opened from, so a view switch that leaked through would show in the header after Esc.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keys, type PtyStep } from "./support/pty.ts";
import { workItem, workList } from "./support/work-source.ts";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const WIDE = { cols: 120, rows: 40 };
/** Narrower than the side-panel width, so Enter on a session opens the detail overlay instead of attaching. */
const NO_PANEL = { cols: 100, rows: 40 };
const ENTER = "\r";
const ESCAPE = "\x1b";
const SETTLE_MS = 800;
const PR_URL = "https://github.com/acme/widgets/pull/12";
/** Wait bound for the open command's trace: the child process writes it after the TUI reports the open. */
const TRACE_WAIT_MS = 10_000;
const TRACE_POLL_MS = 50;

let scenario: TuiScenario | null = null;
let directory: string | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

/** Writes an open-command stub that appends its arguments to a trace file, and returns both paths. */
async function openStub(dir: string): Promise<{ command: string; trace: string }> {
  const command = join(dir, "open-stub");
  const trace = join(dir, "open-trace.txt");
  await writeFile(command, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(trace)}, process.argv.slice(2).join(" ") + "\\n");
`);
  await chmod(command, 0o700);
  return { command, trace };
}

/** Lines the open command has recorded, polled until `count` of them exist or the wait bound passes. */
async function traced(trace: string, count: number): Promise<string[]> {
  const deadline = Date.now() + TRACE_WAIT_MS;
  for (;;) {
    const lines = await readFile(trace, "utf8").then((text) => text.trim().split("\n").filter((line) => line !== ""), () => []);
    if (lines.length >= count || Date.now() > deadline) return lines;
    await Bun.sleep(TRACE_POLL_MS);
  }
}

test("q, ? and 1-4 do nothing in the session detail; Esc returns to the list of the same view", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys(ENTER),
    { expect: "Back" },
    // q would quit the TUI if it reached the global keys; the Esc after it must still find the list.
    keys("q"),
    { pause: SETTLE_MS },
    { clear: true },
    keys(ESCAPE),
    { expect: "SESSIONS  1" },
    keys(ENTER),
    { expect: "Back" },
    keys("?"),
    { pause: SETTLE_MS },
    { absent: "Every list:" },
    { clear: true },
    keys(ESCAPE),
    { expect: "SESSIONS  1" },
    keys(ENTER),
    { expect: "Back" },
    keys("1"),
    { pause: SETTLE_MS },
    { clear: true },
    keys(ESCAPE),
    // A digit that switched the view would show WORK here.
    { expect: "SESSIONS  1" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...NO_PANEL, timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("q, ? and 2 do nothing in the work item detail; o opens its pull request; Esc returns to the Work list", async () => {
  directory = await mkdtemp(join(tmpdir(), "pw-overlay-keys-"));
  const stub = await openStub(directory);
  scenario = await startTuiScenario({ overrides: { "tui.open_command": stub.command } });
  const sessionId = await createShellSession(scenario.daemon, "alpha");
  await writeFile(scenario.workListFile, JSON.stringify(workList([workItem(sessionId, "pr:12", PR_URL, null)])));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { expect: "WORK  1 items" },
    keys(ENTER),
    { expect: "WORK ITEM" },
    keys("q"),
    keys("?"),
    keys("2"),
    { pause: SETTLE_MS },
    { absent: "Every list:" },
    { absent: "SESSIONS  1" },
    { clear: true },
    keys(ESCAPE),
    // A digit that switched the view would show SESSIONS here.
    { expect: "WORK  1 items" },
    keys(ENTER),
    { expect: "WORK ITEM" },
    keys("o"),
    { pause: SETTLE_MS },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  expect(await traced(stub.trace, 1)).toEqual([PR_URL]);
}, REAL_SCENARIO_TIMEOUT_MS);
