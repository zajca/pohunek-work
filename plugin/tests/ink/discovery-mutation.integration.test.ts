// Regression: a failed host discovery must not block mutations of sessions the local daemon
// lists and serves. The discovery failure is the condition under test: the CLI proxy refuses
// `host discover`, as a machine without netbird does; the session and its stop are real.
import { afterEach, expect, test } from "bun:test";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("a stop goes through when only host discovery fails", async () => {
  scenario = await startTuiScenario({ rules: [{ match: ["host", "discover"], failWith: 1 }] });
  const id = await createShellSession(scenario.daemon, "gamma-stop");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "gamma-stop" },
    keys("x"),
    // The confirmation names the highlighted session, so the stop applies to the session the owner sees.
    { expect: "Confirm stop of gamma-stop? y/N" },
    keys("y"),
    { expect: "stop completed" },
  ];
  const result = await scenario.run(steps, { timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const inspected = await scenario.daemon.pohunek(["session", "inspect", id, "--json"]);
  expect(inspected.stdout).toMatch(/"state":\s*"(stopped|exited|terminal)"/);
}, SCENARIO_TIMEOUT_MS);
