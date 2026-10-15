// The `/` filter of every list and the project picker: the query is a fuzzy subsequence, typed text belongs to the
// filter until Enter keeps it or Esc clears it, so x and D do nothing while the filter is typed.
import { afterEach, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { createShellSession, PROJECT, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys } from "./support/pty.ts";
import { workItem, workList } from "./support/work-source.ts";

const OTHER = "gadgets";
const ESCAPE = "1b";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("Sessions: a subsequence query narrows the list; x and D are text while typing; Esc restores", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "orchid-review");
  await createShellSession(scenario.daemon, "maple-tree");
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  2" },
    keys("/"),
    { expect: "Search  _" },
    keys("ordrv"),
    { expect: "SESSIONS  1" },
    { expect: "Search  ordrv_" },
    keys("x"),
    { expect: "No sessions match" },
    keys("\x7f"),
    { expect: "SESSIONS  1" },
    keys("D"),
    { expect: "No sessions match" },
    { send: ESCAPE, settle: 300 },
    { expect: "SESSIONS  2" },
    keys("q"),
  ], { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("Work: a subsequence of the item key finds it; Enter keeps the filter", async () => {
  scenario = await startTuiScenario();
  await writeFile(scenario.workListFile, JSON.stringify(workList([
    workItem("s-review", "widgets-review", null, null),
    workItem("s-cleanup", "widgets-cleanup", null, null),
  ])));
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    { expect: "WORK  2 items" },
    keys("/"),
    keys("wrv"),
    { expect: "WORK  1 items" },
    { expect: "widgets / widgets-review" },
    keys("\r"),
    { expect: "Search wrv  Hide stale" },
    keys("q"),
  ], { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the project picker matches a subsequence of the project label", async () => {
  scenario = await startTuiScenario();
  await scenario.daemon.registerProject(OTHER, "acme/gadgets");
  const created = await scenario.daemon.pohunek(["session", "new", "--agent", "shell", "--project", OTHER, "--name", "gizmo", "--json"]);
  if (!created.stdout.includes('"ok"')) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  const plain = await scenario.daemon.pohunek(["session", "new", "--agent", "shell", "--project", PROJECT, "--name", "plain", "--json"]);
  if (!plain.stdout.includes('"ok"')) throw new Error(`session new failed: ${plain.stdout}${plain.stderr}`);
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "gizmo" },
    keys("P"),
    { expect: "PROJECTS" },
    keys("/"),
    { expect: "filter: none_" },
    keys("wgt"),
    { expect: "widgets  1 sessions" },
    keys("\r"),
    { expect: "Project: widgets" },
    keys("q"),
  ], { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("Hosts and Activity: / filters the list and Esc restores it", async () => {
  scenario = await startTuiScenario();
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("3"),
    { expect: "HOSTS" },
    keys("/"),
    keys("zz"),
    { expect: "No hosts match" },
    { send: ESCAPE, settle: 300 },
    { expect: "HOSTS" },
    keys("4"),
    keys("/"),
    keys("zz"),
    { expect: "No notifications match" },
    { send: ESCAPE, settle: 300 },
    { expect: "Scope: Recent" },
    keys("q"),
  ], { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);
