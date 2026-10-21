// Regression: a session creation whose response speaks a protocol range this plugin does not support
// has an unknown outcome, so the form must stay locked instead of creating a second session. The core
// creates the session for real; the CLI proxy rewrites only the protocol range of the response.
import { afterEach, expect, test } from "bun:test";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("a creation with an unsupported protocol range is not repeated by a second submission", async () => {
  scenario = await startTuiScenario({ rules: [{ match: ["session", "new"], protocolRange: { minimum: 99, maximum: 99 } }] });
  const tabs = (count: number): PtyStep[] => Array.from({ length: count }, (): PtyStep => ({ send: "09", settle: 100 }));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    keys("n"),
    { expect: "NEW SESSION" },
    ...tabs(7),
    keys("\r"),
    { expect: "creation outcome unknown" },
    { pause: 1000 },
    keys("\r"),
    { pause: 2500 },
  ];
  const result = await scenario.run(steps, { timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const creations = (await scenario.proxy.calls()).filter((call) => call.includes("session") && call.includes("new"));
  expect(creations).toHaveLength(1);
}, SCENARIO_TIMEOUT_MS);
