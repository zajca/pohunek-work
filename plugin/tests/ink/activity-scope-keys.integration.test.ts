// The Activity view's c key steps the scope through Recent, Unread and Archived and back to Recent, and the view keeps
// its place when the scope changes. The arrows change the scope too (view-keys covers them).
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("c steps the Activity scope Recent, Unread, Archived and back to Recent", async () => {
  scenario = await startTuiScenario();
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("4"),
    { expect: "Scope: Recent" },
    keys("c"),
    { expect: "Scope: Unread" },
    keys("c"),
    { expect: "Scope: Archived" },
    keys("c"),
    { expect: "Scope: Recent" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { cols: 120, rows: 40, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);
