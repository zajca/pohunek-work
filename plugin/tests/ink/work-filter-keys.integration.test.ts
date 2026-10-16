// The Work view's filter keys: m toggles the owner's own items, f cycles the actor filter through every actor, h hides
// stale items and P cycles the project filter through each project and then back to all. Each key changes the filter
// line the view draws, and the view keeps the list it had.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { workItem, workList } from "./support/work-source.ts";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const WIDE = { cols: 120, rows: 40 };
const SETTLE_MS = 800;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("m, f, h and P change the Work filter line, and P returns to all projects", async () => {
  scenario = await startTuiScenario();
  const sessionId = await createShellSession(scenario.daemon, "alpha");
  await writeWorkList(scenario, sessionId);
  // The view starts on the owner's items (initial_view mine), so the actor filter starts at me.
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { expect: "WORK  1 items" },
    { expect: "Actor me  Project all" },
    { expect: "Hide stale off" },
    keys("m"),
    { expect: "Actor all  Project all" },
    keys("m"),
    { expect: "Actor me  Project all" },
    // f steps through the actor filters in their fixed order: all, me, agent, reviewer.
    keys("f"),
    { expect: "Actor agent  Project all" },
    keys("f"),
    { expect: "Actor reviewer  Project all" },
    keys("h"),
    { expect: "Hide stale on" },
    keys("P"),
    { expect: "Project widgets" },
    keys("P"),
    { expect: "Project all" },
    { pause: SETTLE_MS },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

/** One work item of the scenario's project, so the list has a project for P to cycle through. */
async function writeWorkList(tui: TuiScenario, sessionId: string): Promise<void> {
  await Bun.write(tui.workListFile, JSON.stringify(workList([workItem(sessionId, "pr:12", null, null)])));
}
