// Presses on a list row: one press selects the row and never opens it; a second press on the same row
// within `[tui] double_click_ms` does what Enter does on that row. The interval is set in the scenario's
// configuration, and the gaps between presses are derived from it, so the scenario and the TUI agree on it.
import { afterEach, expect, test } from "bun:test";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const DOUBLE_CLICK_MS = 1000;
/** Gap between the two presses of a double click: well inside the interval. */
const DOUBLE_PRESS_GAP_MS = DOUBLE_CLICK_MS / 5;
/** Gap after a press that must not pair with the next one: past the interval. */
const SEPARATE_PRESS_GAP_MS = DOUBLE_CLICK_MS * 2;
/** Gap after a press that is followed by a step waiting for the screen; the step itself does not depend on it. */
const SETTLE_MS = 300;
const WIDE = { cols: 120, rows: 40 };
const NARROW = { cols: 80, rows: 30 };
/** A list of this many sessions does not fit the rows of LONG_LIST: the window must scroll. */
const LONG_LIST_SESSIONS = 12;
const LONG_LIST = { cols: 120, rows: 30 };
/** Left-button presses on the second row of the Sessions list and the first row of the Hosts list, in terminal cells (1-based). */
const PRESS_HOST_ROW = "\x1b[<0;10;5M";
const PRESS_ROW_TWO = "\x1b[<0;10;11M";
const PRESS_ROW_THREE = "\x1b[<0;10;12M";
/** A row of the long list below the middle of its visible window (1-based terminal cell, row 7 of 8 visible). */
const PRESS_LONG_LIST_ROW = "\x1b[<0;10;21M";
const LONG_LIST_ROW_INDEX = 6;
/** Footer of every overlay that replaces the list; the list keeps the plain footer. */
const OVERLAY_FOOTER = "Esc back";
const SCENARIO_OVERRIDES = { "tui.double_click_ms": DOUBLE_CLICK_MS };

let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("a single click selects a session at a wide terminal and only a second click on it attaches", async () => {
  scenario = await startTuiScenario({ rules: [{ match: ["attach"], replaceWith: [Bun.which("sleep") ?? "/bin/sleep", "1"] }], overrides: SCENARIO_OVERRIDES });
  const ids: string[] = [];
  for (const name of ["row-a", "row-b", "row-c"]) ids.push(await createShellSession(scenario.daemon, name));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "row-a · local · shell" },
    // A single press on the second row selects it: its panel follows, and no full-screen detail opens.
    { ...keys(PRESS_ROW_TWO), settle: SETTLE_MS },
    { expect: "row-b · local · shell" },
    { clear: true },
    { absent: OVERLAY_FOOTER, pause: SEPARATE_PRESS_GAP_MS },
    // The third row is pressed alone, then pressed again inside the interval: the second press attaches it.
    { ...keys(PRESS_ROW_THREE), settle: SETTLE_MS },
    { expect: "row-c · local · shell" },
    { clear: true },
    { absent: OVERLAY_FOOTER, pause: SEPARATE_PRESS_GAP_MS },
    { ...keys(PRESS_ROW_THREE), settle: DOUBLE_PRESS_GAP_MS },
    { ...keys(PRESS_ROW_THREE), settle: SETTLE_MS },
    { pause: SEPARATE_PRESS_GAP_MS },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const attached = (await scenario.proxy.calls()).filter((call) => call.includes("attach")).map((call) => call.at(-1));
  expect(attached).toEqual([ids[2]]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a single click selects a host at a wide terminal and a double click opens it", async () => {
  scenario = await startTuiScenario({ rules: [], overrides: SCENARIO_OVERRIDES });
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("3"),
    { expect: "HOSTS" },
    { ...keys(PRESS_HOST_ROW), settle: SETTLE_MS },
    { clear: true },
    { absent: OVERLAY_FOOTER, pause: SEPARATE_PRESS_GAP_MS },
    { ...keys(PRESS_HOST_ROW), settle: DOUBLE_PRESS_GAP_MS },
    { ...keys(PRESS_HOST_ROW), settle: SETTLE_MS },
    { expect: "Host capabilities" },
    { expect: OVERLAY_FOOTER },
    keys("\x1b"),
    { expect: "HOSTS" },
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("below the breakpoint a single click only selects and a double click opens the session as Enter does", async () => {
  scenario = await startTuiScenario({ rules: [], overrides: SCENARIO_OVERRIDES });
  await createShellSession(scenario.daemon, "narrow-one");
  await createShellSession(scenario.daemon, "narrow-two");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  2" },
    { ...keys(PRESS_ROW_TWO), settle: SETTLE_MS },
    { clear: true },
    { absent: OVERLAY_FOOTER, pause: SEPARATE_PRESS_GAP_MS },
    { ...keys(PRESS_ROW_TWO), settle: DOUBLE_PRESS_GAP_MS },
    { ...keys(PRESS_ROW_TWO), settle: SETTLE_MS },
    { expect: "Status  " },
    { expect: OVERLAY_FOOTER },
    keys("\x1b"),
    { expect: "SESSIONS  2" },
  ];
  const result = await scenario.run(steps, { ...NARROW, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a second press after the double click interval only selects the row", async () => {
  scenario = await startTuiScenario({ rules: [{ match: ["attach"], replaceWith: [Bun.which("sleep") ?? "/bin/sleep", "1"] }], overrides: SCENARIO_OVERRIDES });
  const ids: string[] = [];
  for (const name of ["row-a", "row-b"]) ids.push(await createShellSession(scenario.daemon, name));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "row-a · local · shell" },
    { ...keys(PRESS_ROW_TWO), settle: SETTLE_MS },
    { expect: "row-b · local · shell" },
    { clear: true },
    // The second press on the same row comes after the interval, so it is a new first press: it only selects.
    { pause: SEPARATE_PRESS_GAP_MS },
    { ...keys(PRESS_ROW_TWO), settle: SETTLE_MS },
    { pause: SEPARATE_PRESS_GAP_MS },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const attached = (await scenario.proxy.calls()).filter((call) => call.includes("attach"));
  expect(attached).toEqual([]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("presses on two different rows within the double click interval open neither row", async () => {
  scenario = await startTuiScenario({ rules: [{ match: ["attach"], replaceWith: [Bun.which("sleep") ?? "/bin/sleep", "1"] }], overrides: SCENARIO_OVERRIDES });
  for (const name of ["row-a", "row-b", "row-c"]) await createShellSession(scenario.daemon, name);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "row-a · local · shell" },
    { ...keys(PRESS_ROW_TWO), settle: DOUBLE_PRESS_GAP_MS },
    // Well inside the interval, but on another row: the second press selects that row and does not open it.
    { ...keys(PRESS_ROW_THREE), settle: SETTLE_MS },
    { expect: "row-c · local · shell" },
    { pause: SEPARATE_PRESS_GAP_MS },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const attached = (await scenario.proxy.calls()).filter((call) => call.includes("attach"));
  expect(attached).toEqual([]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a double click on a row below the middle of a scrolled list attaches that row", async () => {
  scenario = await startTuiScenario({ rules: [{ match: ["attach"], replaceWith: [Bun.which("sleep") ?? "/bin/sleep", "1"] }], overrides: SCENARIO_OVERRIDES });
  const ids: string[] = [];
  for (let index = 1; index <= LONG_LIST_SESSIONS; index++) ids.push(await createShellSession(scenario.daemon, `s${String(index).padStart(2, "0")}`));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  12" },
    { ...keys(PRESS_LONG_LIST_ROW), settle: SETTLE_MS },
    { expect: "s07 · local · shell" },
    { clear: true },
    { absent: OVERLAY_FOOTER, pause: DOUBLE_PRESS_GAP_MS },
    // The list must not move under the mouse: the same cell is the same row, so the second press attaches it.
    { ...keys(PRESS_LONG_LIST_ROW), settle: SETTLE_MS },
    { pause: SEPARATE_PRESS_GAP_MS },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...LONG_LIST, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const attached = (await scenario.proxy.calls()).filter((call) => call.includes("attach")).map((call) => call.at(-1));
  expect(attached).toEqual([ids[LONG_LIST_ROW_INDEX]]);
}, REAL_SCENARIO_TIMEOUT_MS);
