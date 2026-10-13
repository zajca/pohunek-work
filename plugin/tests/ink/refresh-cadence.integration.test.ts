// The session snapshot reconciles on `session_reconcile_secs`, not on the Work refresh interval.
// Counting the CLI's `session list` calls through the process proxy shows the cadence of the real
// daemon's reads; the Work interval is set long so only the session reconcile repeats in the window.
import { afterEach, expect, test } from "bun:test";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const WINDOW_MS = 3500;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("sessions reconcile on their own interval while the Work list keeps its own", async () => {
  scenario = await startTuiScenario({ rules: [], overrides: { "tui.session_reconcile_secs": 1, "tui.refresh_interval_secs": 3600 } });
  const steps: PtyStep[] = [{ expect: "CONTROL CENTER" }, { pause: WINDOW_MS }, keys("q")];
  const result = await scenario.run(steps, { timeoutS: 30 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-600)}`).toBe(-1);
  const listings = (await scenario.proxy.calls()).filter((call) => call.includes("session") && call.includes("list"));
  expect(listings.length).toBeGreaterThanOrEqual(3);
}, SCENARIO_TIMEOUT_MS);
