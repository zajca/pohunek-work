// Regression: after a resize the TUI clears the screen and draws the next frame from the top. Ink erases a frame
// relative to the cursor, and a terminal moves the cursor and the content in its own way on a resize (a phone keyboard
// changes only the height), so a relative erase after a resize left stale rows. The scenario follows the owner's
// report: the Sessions view with a filter typed, then the keyboard shown and hidden.
import { afterEach, expect, test } from "bun:test";
import { keys } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 60_000;
const COLUMNS = 51;
const ROWS = 29;
const KEYBOARD_ROWS = 16;
/** Erase the whole screen, then move the cursor to the top left cell. */
const ABSOLUTE_CLEAR = "\x1b[2J\x1b[1;1H";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("every resize clears the screen and redraws from the top", async () => {
  scenario = await startTuiScenario();
  await createShellSession(scenario.daemon, "resize");
  const steps = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "Needs you" },
    keys("/"),
    keys("res"),
    { pause: 1000 },
    { resize: [KEYBOARD_ROWS, COLUMNS] as const },
    { pause: 1000 },
    { resize: [ROWS, COLUMNS] as const },
    { pause: 1000 },
    { clear: true as const },
    keys("\x1b"),
    { expect: "SESSIONS" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { cols: COLUMNS, rows: ROWS });
  expect(result.failed, `output:\n${result.output.slice(-900)}`).toBe(-1);
  const bytes = Buffer.from(result.raw, "hex");
  expect(result.resizedAt.length).toBe(2);
  for (const at of result.resizedAt) {
    expect(bytes.subarray(at).toString("utf8")).toContain(ABSOLUTE_CLEAR);
  }
}, SCENARIO_TIMEOUT_MS);
