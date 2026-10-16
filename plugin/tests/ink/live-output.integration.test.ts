// Live output of the selected session in the Sessions panel, on a real shell session of the test daemon.
// The later commands are sent after the panel is open, so their text can only appear through continued live reads.
import { afterEach, expect, test } from "bun:test";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("the panel shows the output a session prints before and after the panel opens, through two continuations", async () => {
  scenario = await startTuiScenario();
  const id = await createShellSession(scenario.daemon, "live");
  const first = await scenario.daemon.pohunek(["session", "input", id, "echo live-marker-$((6*7))\n", "--json"]);
  if (!first.stdout.includes('"ok"')) throw new Error(`session input failed: ${first.stdout}${first.stderr}`);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "live-marker-42" },
    { expect: "live-marker-49" },
    { expect: "live-marker-64" },
    keys("q"),
  ];
  const running = scenario.run(steps, { timeoutS: 60 });
  await Bun.sleep(3000);
  const second = await scenario.daemon.pohunek(["session", "input", id, "echo live-marker-$((7*7))\n", "--json"]);
  if (!second.stdout.includes('"ok"')) throw new Error(`session input failed: ${second.stdout}${second.stderr}`);
  await Bun.sleep(3000);
  const third = await scenario.daemon.pohunek(["session", "input", id, "echo live-marker-$((8*8))\n", "--json"]);
  if (!third.stdout.includes('"ok"')) throw new Error(`session input failed: ${third.stdout}${third.stderr}`);
  const result = await running;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);
