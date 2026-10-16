// Regression: Ctrl-C during a handoff to an interactive child must reach the child only. The child
// shares the terminal's foreground group; while the terminal is cooked, the interrupt signals the TUI
// too, and the TUI must survive it and draw again. The attach child is a stand-in (`sleep`) placed
// by the CLI proxy, because the real attach puts the terminal into raw mode and never receives the
// signal; the real session is started through the release CLI.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const CTRL_C = "03";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("Ctrl-C during an attach interrupts the child and returns the TUI", async () => {
  const sleep = Bun.which("sleep");
  if (sleep === null) throw new Error("sleep is not on PATH; the attach stand-in needs it");
  scenario = await startTuiScenario({ rules: [{ match: ["attach"], replaceWith: [sleep, "60"] }] });
  await createShellSession(scenario.daemon, "handoff");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("o"),
    { pause: 1500 },
    { send: CTRL_C, settle: 1000 },
    { expect: "SESSIONS  1" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 30 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect((await scenario.proxy.calls()).some((call) => call.includes("attach"))).toBe(true);
}, SCENARIO_TIMEOUT_MS);
