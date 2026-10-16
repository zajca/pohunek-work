// The Sessions view follows the daemon's event stream: a session created by another process appears
// while the TUI runs, with the session reconcile interval set far beyond the scenario, so only the
// event stream can have shown it.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("a session created while the TUI runs appears in the Sessions view without a reconcile", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    { expect: "live-arrival" },
    keys("q"),
  ];
  const running = scenario.run(steps, { timeoutS: 40 });
  await Bun.sleep(2500);
  await scenario.daemon.pohunek(["session", "new", "--agent", "shell", "--cwd", scenario.daemon.root, "--name", "live-arrival", "--json"]);
  const result = await running;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
