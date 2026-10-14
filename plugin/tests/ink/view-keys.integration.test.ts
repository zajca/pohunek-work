// Regression: the arrow keys switch views in every main view, as Tab does, and in Sessions they do not
// jump between sections (that stays on [ and ]). A text field keeps the arrows for its own cursor.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const RIGHT = "1b5b43";
const LEFT = "1b5b44";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("arrows switch views from every main view and leave a text field alone", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "views");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { send: RIGHT, settle: 800 },
    { expect: "SESSIONS  1" },
    { send: RIGHT, settle: 800 },
    { expect: "HOSTS" },
    { send: RIGHT, settle: 800 },
    { expect: "Scope: Recent" },
    { send: RIGHT, settle: 800 },
    { expect: "WORK" },
    { send: LEFT, settle: 800 },
    { expect: "Scope: Recent" },
    { send: LEFT, settle: 800 },
    { expect: "HOSTS" },
    { send: LEFT, settle: 800 },
    { expect: "SESSIONS  1" },
    keys("1"),
    keys("/"),
    { expect: "Search  _" },
    { send: LEFT, settle: 800 },
    keys("z"),
    { expect: "Search  z_" },
    keys("\x1b"),
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
