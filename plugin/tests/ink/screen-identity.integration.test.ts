// Regression: a terminal screen requested for one session must not be shown under another session
// the owner opened before the response arrived. The core reads both screens for real; the CLI proxy
// delays only the first session's `session screen` call, which is the condition under test.
import { afterEach, expect, test } from "bun:test";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const DELAY_MS = 3000;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("a delayed screen response is discarded after the owner opens another session", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const first = await createShellSession(scenario.daemon, "alpha-screen");
  const second = await createShellSession(scenario.daemon, "beta-screen");
  for (const [id, text] of [[first, "echo AAA-MARK"], [second, "echo BBB-MARK"]] as const) {
    const sent = await scenario.daemon.pohunek(["session", "input", id, text, "--json"]);
    if (!sent.stdout.includes('"ok"')) throw new Error(`session input failed: ${sent.stdout}${sent.stderr}`);
  }
  await scenario.proxy.setRules([{ match: ["session", "screen", first], delayMs: DELAY_MS }]);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "alpha-screen" },
    keys("\r"),
    { expect: "alpha-screen" },
    keys("p"),
    keys("\x1b"),
    keys("\x1b[B"),
    keys("\r"),
    { expect: "beta-screen" },
    { pause: DELAY_MS + 2000 },
  ];
  const result = await scenario.run(steps, { timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(result.output).not.toContain("AAA-MARK");
}, SCENARIO_TIMEOUT_MS);
