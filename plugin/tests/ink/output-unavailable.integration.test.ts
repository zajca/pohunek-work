// A session without a terminal has no output to show. The panel's output block says so; the status line is
// left for actions, so the failure is not reported there.
import { afterEach, expect, test } from "bun:test";
import { keys } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("a failed session's panel says its output is unavailable", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const id = await createShellSession(scenario.daemon, "failed-output");
  await scenario.daemon.pohunek(["session", "input", id, "exit 1\n", "--json"]);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const inspected = await scenario.daemon.pohunek(["session", "inspect", id, "--json"]);
    if ((JSON.parse(inspected.stdout) as { ok?: { state?: string } }).ok?.state === "failed") break;
    if (Date.now() > deadline) throw new Error("the session did not fail");
    await Bun.sleep(100);
  }
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "output unavailable: daemon error" },
  ], { timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, 90_000);
