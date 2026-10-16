// A source that becomes unavailable through a publish that no refresh asked for (the daemon's event stream ends, and the
// reconnect reads fail) still shows the outage warning, because the status line holds no action message.
import { afterEach, expect, test } from "bun:test";
import type { PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const STOP_AFTER_MS = 4_000;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("an outage that arrives through an event-driven publish shows the source warning without a refresh", async () => {
  scenario = await startTuiScenario({ overrides: { "tui.session_reconcile_secs": 300 } });
  const running = scenario;
  // The daemon stops after the TUI has drawn its first frame; the explicit reconcile is set far beyond the run.
  const stopping = Bun.sleep(STOP_AFTER_MS).then(() => running.daemon.stop());
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { expect: "source(s) unavailable; mutating actions are paused", timeout: 30 },
  ];
  const result = await running.run(steps, { timeoutS: 60 });
  await stopping;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-2500)}`).toBe(-1);
}, 120_000);
