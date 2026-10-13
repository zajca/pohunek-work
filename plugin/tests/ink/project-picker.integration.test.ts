// The project picker of the Sessions view: P lists the projects with their session counts, `/` filters them,
// Enter applies the chosen project as the list filter. Two projects are registered on the test daemon.
import { afterEach, expect, test } from "bun:test";
import { keys } from "./support/pty.ts";
import { REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const OTHER = "gadgets";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("P filters the Sessions list by the project chosen in the picker", async () => {
  scenario = await startTuiScenario();
  await scenario.daemon.registerProject(OTHER, "acme/gadgets");
  const created = await scenario.daemon.pohunek(["session", "new", "--agent", "shell", "--project", OTHER, "--name", "gizmo", "--json"]);
  if (!created.stdout.includes('"ok"')) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "gizmo" },
    keys("P"),
    { expect: `${OTHER}  1 sessions` },
    keys("/"),
    keys(OTHER.slice(0, 3)),
    keys("\r"),
    { expect: `Project: ${OTHER}` },
    keys("q"),
  ], { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);
