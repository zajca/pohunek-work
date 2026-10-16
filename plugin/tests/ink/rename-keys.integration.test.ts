// The rename overlay saves the name it shows at the Enter press. Text and Enter sent as one write are two presses,
// so Enter must read the name the text press left, and the daemon must hold that name.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("text and Enter sent as one write rename the session to the typed text", async () => {
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
    keys("abc\r"),
    { pause: 2000 },
  ];
  // The detail opens full screen only when the panel beside the list is absent, which this size leaves out.
  const result = await scenario.run(steps, { cols: 100, rows: 40, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  const listed = JSON.parse((await scenario.daemon.pohunek(["session", "list", "--json"])).stdout) as { ok?: { name: string | null }[] };
  // The edit starts from the current name, so the typed text is appended to it.
  expect((listed.ok ?? []).map((item) => item.name)).toEqual(["alphaabc"]);
}, REAL_SCENARIO_TIMEOUT_MS);
