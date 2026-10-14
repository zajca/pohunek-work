// The Sessions view on real sessions: sections with headings, the highlighted session's panel beside the
// list at a wide terminal, the full-screen panel below the breakpoint, the stop confirmation, and the view keys.
import { afterEach, expect, test } from "bun:test";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const WIDE = { cols: 120, rows: 40 };
const NARROW = { cols: 80, rows: 30 };
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

async function sessionState(scenario: TuiScenario, id: string): Promise<string> {
  const inspected = await scenario.daemon.pohunek(["session", "inspect", id, "--json"]);
  return (JSON.parse(inspected.stdout) as { ok?: { state?: string } }).ok?.state ?? "unknown";
}

test("sections head the list and the highlighted session's panel follows the selection", async () => {
  scenario = await startTuiScenario({ rules: [] });
  await createShellSession(scenario.daemon, "alpha-panel");
  const broken = await createShellSession(scenario.daemon, "broken-panel");
  await scenario.daemon.pohunek(["session", "input", broken, "exit 1\n", "--json"]);
  const deadline = Date.now() + 20_000;
  while ((await sessionState(scenario, broken)) !== "failed") {
    if (Date.now() > deadline) throw new Error("the broken session did not fail");
    await Bun.sleep(100);
  }
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "NEEDS YOU  1" },
    { expect: "RUNNING  1" },
    // Steps match in order of output and a panel heading is drawn once per change, so the heading of the
    // session the owner moves to is the check that the panel follows the selection.
    keys("\x1b[B"),
    { expect: "alpha-panel · local · shell" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("x stops the highlighted session after a confirmation that names it", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const id = await createShellSession(scenario.daemon, "stop-panel");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "stop-panel" },
    keys("x"),
    { expect: "Confirm stop of stop-panel? y/N" },
    keys("y"),
    { expect: "stop completed" },
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await sessionState(scenario, id)).not.toBe("running");
}, SCENARIO_TIMEOUT_MS);

test("Tab cycles the views and a narrow terminal shows the panel full screen until Esc", async () => {
  scenario = await startTuiScenario({ rules: [] });
  await createShellSession(scenario.daemon, "narrow-panel");
  const wide: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("\t"),
    { expect: "SESSIONS  " },
    keys("\t"),
    { expect: "HOSTS" },
    keys("\t"),
    { expect: "Scope: Recent" },
    keys("2"),
    { expect: "SESSIONS" },
  ];
  const wideResult = await scenario.run(wide, { ...WIDE, timeoutS: 40 });
  expect(wideResult.failed, `step ${String(wideResult.failed)} failed; output:\n${wideResult.output.slice(-900)}`).toBe(-1);
  const narrow: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "narrow-panel" },
    keys("\r"),
    { expect: "Status  " },
    keys("\x1b"),
    { expect: "SESSIONS" },
    keys("q"),
  ];
  const narrowResult = await scenario.run(narrow, { ...NARROW, timeoutS: 40 });
  expect(narrowResult.failed, `step ${String(narrowResult.failed)} failed; output:\n${narrowResult.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
