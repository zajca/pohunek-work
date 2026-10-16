// The key precedence that the single input dispatcher keeps. A modal overlay takes Tab and every letter, a confirmation
// is cancelled by any key but y, and a typed list filter takes digits and letters as text. Each test presses the key
// that would act if the tier were missing, then checks that the tier above it consumed the key.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const WIDE_ENOUGH_FOR_NO_PANEL = { cols: 100, rows: 40 };
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("Tab inside the rename overlay does not leave it: Escape then returns to the session detail", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("\r"),
    { expect: "Back" },
    keys("e"),
    { expect: "Name: alpha_" },
    keys("\t"),
    { pause: 500 },
    keys("\x1b"),
    { expect: "Back" },
  ];
  const result = await scenario.run(steps, { ...WIDE_ENOUGH_FOR_NO_PANEL, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a letter other than y cancels a Stop confirmation and the session keeps running", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("\r"),
    { expect: "Back" },
    keys("x"),
    { expect: "Confirm stop of alpha" },
    keys("n"),
    { expect: "Back" },
    { pause: 1000 },
  ];
  const result = await scenario.run(steps, { ...WIDE_ENOUGH_FOR_NO_PANEL, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  const listed = JSON.parse((await scenario.daemon.pohunek(["session", "list", "--json"])).stdout) as { ok?: { name: string | null; state: string }[] };
  expect((listed.ok ?? []).map((item) => item.state)).toEqual(["running"]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("while the Sessions filter is typed, digits and q are text and do not switch the view or quit", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("/"),
    { expect: "Search  _" },
    keys("1q4"),
    { expect: "Search  1q4_" },
    { expect: "No sessions match" },
    keys("\x7f\x7f\x7f"),
    { expect: "SESSIONS  1" },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("q typed into the rename overlay is part of the name and does not quit the TUI", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("\r"),
    { expect: "Back" },
    keys("e"),
    { expect: "Name: alpha_" },
    keys("q"),
    { expect: "Name: alphaq_" },
  ];
  const result = await scenario.run(steps, { ...WIDE_ENOUGH_FOR_NO_PANEL, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);
