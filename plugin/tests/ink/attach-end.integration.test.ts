// Regression: the inline attach ends when its session ends, however it ends. The attach child is the real
// `pohunek attach` on real sessions. The owner's path is the attach menu (Ctrl-\ then t and y, or k and y).
// After the session ends the TUI must draw its list again, read keys and clicks, and attach another session.
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
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

/** Opens the Sessions view, attaches the first session (inline, in this terminal) and waits until the shell answers inside the attach. */
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

test("the session is stopped from outside while attached: the TUI comes back and shows it ended", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  // Another process stops the session once the attach has answered; the shell is still in the foreground.
  const stopping = new Promise((resolve) => setTimeout(resolve, STOP_OUTSIDE_MS)).then(() => scenario?.daemon.pohunek(["session", "stop", id]));
  const steps: PtyStep[] = [
    ...attachFirst(1),
    { pause: STOP_OUTSIDE_MS },
    { expect: "UNAVAILABLE  1" },
    ...backInTui("UNAVAILABLE  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  await stopping;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the session is removed from outside while attached: the TUI comes back with the list drawn", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  const removing = new Promise((resolve) => setTimeout(resolve, STOP_OUTSIDE_MS)).then(() => scenario?.daemon.pohunek(["session", "rm", id]));
  const steps: PtyStep[] = [
    ...attachFirst(1),
    { pause: STOP_OUTSIDE_MS },
    { expect: "No sessions" },
    ...backInTui("No sessions"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  await removing;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

/** When the outside stop or removal runs; the attach has answered by then because the steps wait for it first. */
const STOP_OUTSIDE_MS = 6000;
