// Regression: after the owner detaches from a session, the TUI must read input and act again. The
// attach is the real `pohunek attach` on a real shell session, and detach is the real Ctrl-] key
// that the attach child reads from the terminal; a busy flag left set by the handover refuses every key.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const DETACH = "1d";
const BUSY_REFUSAL = "Still working on the last action";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("attach, detach, then keys and attach work again", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "detach");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("o"),
    { pause: 1500 },
    { send: DETACH, settle: 1500 },
    { expect: "SESSIONS  1" },
    keys("3"),
    { expect: "HOSTS" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("o"),
    { pause: 1500 },
    { send: DETACH, settle: 1500 },
    { expect: "SESSIONS  1" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
  const attaches = (await scenario.proxy.calls()).filter((call) => call.includes("attach"));
  expect(attaches.length).toBe(2);
}, SCENARIO_TIMEOUT_MS);
