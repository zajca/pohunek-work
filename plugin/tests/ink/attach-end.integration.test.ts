// Regression: every inline attach ends with its session, and a failed attach is reported. The attach child is the
// real `pohunek attach` on real sessions. The owner's path is the attach menu (Ctrl-\ then t and y, or k and y).
// Other processes act from inside the attached shell, after the attach is confirmed by its output, so each trigger
// happens at a known point of the run and not on a timer.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const CTRL_BACKSLASH = "1c";
const BUSY_REFUSAL = "Still working on the last action";
const READY = "ready-2";
const ECHO_READY = "echo ready-$((1+1))\r";
const ATTACH_SETTLE_MS = 2000;
const RETURN_SETTLE_MS = 1000;
const INLINE = { overrides: { "tui.attach_mode": "inline" } };
const STOPPED_BY_SIGNAL = "stopped by SIGTERM";
const OUTPUT_WAIT_MS = 60_000;
const OUTPUT_POLL_MS = 300;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

/** Opens the Sessions view, attaches the first session (inline, in this terminal) and waits for the shell's answer. */
function attachFirst(sessions: number): PtyStep[] {
  return [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: `SESSIONS  ${String(sessions)}` },
    keys("o"),
    { pause: ATTACH_SETTLE_MS },
    keys(ECHO_READY),
    { expect: READY },
  ];
}

/**
 * The keys that prove the TUI is back after the list was drawn: the view switches and come back to the list. The list
 * can be drawn while the attach child is still exiting, and a key typed then reaches the child, so the keys wait first.
 */
function backInTui(sessionsLeft: string): PtyStep[] {
  return [
    { pause: RETURN_SETTLE_MS },
    keys("3"),
    { expect: "HOSTS" },
    keys("2"),
    { expect: sessionsLeft },
  ];
}

/**
 * Resolves once the session has printed `text`, which the attached shell prints only after the attach is answering.
 * The daemon refuses a stop or removal sent from inside the session itself, so the trigger runs from the test.
 */
async function untilPrinted(tui: TuiScenario, id: string, text: string): Promise<void> {
  const deadline = Date.now() + OUTPUT_WAIT_MS;
  for (;;) {
    const output = JSON.parse((await tui.daemon.pohunek(["session", "output", id, "--json"])).stdout) as { ok?: { data_base64?: string } };
    if (Buffer.from(output.ok?.data_base64 ?? "", "base64").toString("utf8").includes(text)) return;
    if (Date.now() > deadline) throw new Error(`session ${id} never printed ${text}`);
    await Bun.sleep(OUTPUT_POLL_MS);
  }
}

test("the owner's path: Ctrl-\\ then terminate (t, y) ends the attach and the TUI comes back", async () => {
  scenario = await startTuiScenario(INLINE);
  await createShellSession(scenario.daemon, "alpha");
  await createShellSession(scenario.daemon, "beta");
  const steps: PtyStep[] = [
    ...attachFirst(2),
    { send: CTRL_BACKSLASH, settle: 800 },
    { expect: "Session menu" },
    keys("t"),
    { expect: "Terminate and delete session?" },
    keys("y"),
    { expect: "SESSIONS  1" },
    ...backInTui("SESSIONS  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the owner's path: Ctrl-\\ then kill (k, y) ends the attach and the TUI shows the session ended", async () => {
  scenario = await startTuiScenario(INLINE);
  await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    ...attachFirst(1),
    { send: CTRL_BACKSLASH, settle: 800 },
    { expect: "Session menu" },
    keys("k"),
    { expect: "Kill session?" },
    keys("y"),
    { expect: "UNAVAILABLE  1" },
    ...backInTui("UNAVAILABLE  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the session exits inside the attach: the TUI comes back and shows it ended", async () => {
  scenario = await startTuiScenario(INLINE);
  await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    ...attachFirst(1),
    keys("exit\r"),
    { expect: "UNAVAILABLE  1" },
    ...backInTui("UNAVAILABLE  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the session is stopped from outside once the attach answers: the TUI comes back and shows it ended", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  const stopping = untilPrinted(scenario, id, READY).then(() => scenario?.daemon.pohunek(["session", "stop", id]));
  const steps: PtyStep[] = [
    ...attachFirst(1),
    { expect: "UNAVAILABLE  1" },
    ...backInTui("UNAVAILABLE  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  await stopping;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the session is removed from outside once the attach answers: the TUI comes back with the list drawn", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  const removing = untilPrinted(scenario, id, READY).then(() => scenario?.daemon.pohunek(["session", "rm", id]));
  const steps: PtyStep[] = [
    ...attachFirst(1),
    { expect: "No sessions" },
    ...backInTui("No sessions"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  await removing;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a SIGTERM from outside to the attach is reported and the session keeps running", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  // The pids of the attach and of the proxy that starts it both match the pattern; the proxy passes the signal on.
  const killAttach = keys(`kill -TERM $(/usr/bin/pgrep -f "attach --host local -- ${id}") 2>/dev/null\r`);
  const steps: PtyStep[] = [
    ...attachFirst(1),
    killAttach,
    { expect: STOPPED_BY_SIGNAL },
    { pause: RETURN_SETTLE_MS },
    keys("3"),
    { expect: "HOSTS" },
    keys("2"),
    { expect: "READY  1" },
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  const sessions = JSON.parse((await scenario.daemon.pohunek(["session", "list", "--json"])).stdout) as { ok?: { id: string; state: string }[] };
  expect(sessions.ok?.find((item) => item.id === id)?.state).toBe("running");
}, REAL_SCENARIO_TIMEOUT_MS);

test("a session created from the form is attached, and its end brings the TUI back", async () => {
  scenario = await startTuiScenario(INLINE);
  const tabs = (count: number): PtyStep[] => Array.from({ length: count }, (): PtyStep => ({ send: "09", settle: 100 }));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    keys("n"),
    { expect: "NEW SESSION" },
    ...tabs(7),
    keys("\r"),
    { expect: "sh-" },
    keys(ECHO_READY),
    { expect: READY },
    keys("exit\r"),
    { expect: "UNAVAILABLE  1" },
    ...backInTui("UNAVAILABLE  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);
