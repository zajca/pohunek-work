// Regression: the detail panel must show only the output of the session the owner highlights. The output of
// the previous session must not stay on screen after the owner moves to another session. The core serves both
// outputs for real; the TUI reads live output through the SDK, which the CLI proxy cannot delay.
import { afterEach, expect, test } from "bun:test";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const DOWN = "\x1b[B";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("the panel shows only the highlighted session's output after the owner moves to another session", async () => {
  scenario = await startTuiScenario();
  const first = await createShellSession(scenario.daemon, "alpha-screen");
  const second = await createShellSession(scenario.daemon, "beta-screen");
  for (const [id, text] of [[first, "echo AAA-MARK"], [second, "echo BBB-MARK"]] as const) {
    const sent = await scenario.daemon.pohunek(["session", "input", id, text, "--json"]);
    if (!sent.stdout.includes('"ok"')) throw new Error(`session input failed: ${sent.stdout}${sent.stderr}`);
  }
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "alpha-screen · local · shell" },
    { expect: "AAA-MARK" },
    keys(DOWN),
    { expect: "beta-screen · local · shell" },
    { expect: "BBB-MARK" },
    { pause: 1500 },
  ];
  const result = await scenario.run(steps, { timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  // Frames redraw the whole screen, so the newest beta frame is the last one that names beta's panel.
  expect(result.output.slice(result.output.lastIndexOf("beta-screen · local · shell"))).not.toContain("AAA-MARK");
}, SCENARIO_TIMEOUT_MS);
