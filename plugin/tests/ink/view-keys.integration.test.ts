// Regression: only Tab and Shift-Tab switch views. The arrows never do: in Sessions they jump between
// sections, in Activity they change the scope, and in a text field they move the cursor. Each step
// clears the output first, so the expected header must come from the Tab press alone.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const RIGHT = "1b5b43";
const LEFT = "1b5b44";
const TAB = "09";
const ESCAPE = "1b";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("arrows never switch views; Tab does", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "views");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    // Work: the arrows do nothing, so the next Tab reaches Sessions.
    { send: RIGHT, settle: 800 },
    { send: LEFT, settle: 800 },
    { clear: true },
    { send: TAB, settle: 800 },
    { expect: "SESSIONS  1" },
    // Sessions: the arrows jump sections, so the next Tab reaches Hosts.
    { send: RIGHT, settle: 800 },
    { send: LEFT, settle: 800 },
    { clear: true },
    { send: TAB, settle: 800 },
    { expect: "HOSTS" },
    // Hosts: the arrows do nothing, so the next Tab reaches Activity.
    { send: RIGHT, settle: 800 },
    { send: LEFT, settle: 800 },
    { clear: true },
    { send: TAB, settle: 800 },
    { expect: "Scope: Recent" },
    // Activity: the arrows change the scope and stay on the view, so the next Tab reaches Work.
    { send: RIGHT, settle: 800 },
    { expect: "Scope: Unread" },
    { send: LEFT, settle: 800 },
    { expect: "Scope: Recent" },
    { clear: true },
    { send: TAB, settle: 800 },
    { expect: "WORK" },
    // A text field keeps the arrows for its cursor and does not switch views.
    keys("/"),
    { expect: "Search  _" },
    { send: RIGHT, settle: 800 },
    { clear: true },
    keys("z"),
    { expect: "Search  z_" },
    { send: ESCAPE, settle: 800 },
    { clear: true },
    { send: TAB, settle: 800 },
    { expect: "SESSIONS  1" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
