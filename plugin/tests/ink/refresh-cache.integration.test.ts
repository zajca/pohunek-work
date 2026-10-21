// The work list reads through the shared cache. Startup and the refresh timer ask `list` for the cached answer; only
// an explicit `r` asks it to read past the cache max age. The stand-in work source records the mode of each call.
import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { keys, type PtyStep } from "./support/pty.ts";
import { REFRESH_SECS } from "./support/work-source.ts";
import { LIST_ARGV_FILE, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

/** Long enough for the refresh timer to fire at least twice before the explicit refresh. */
const TIMER_WAIT_MS = 2_500;
const SETTLE_MS = 300;

let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("startup and the refresh timer read the work list from the cache; r reads it past the max age", async () => {
  scenario = await startTuiScenario({ overrides: { "tui.refresh_interval_secs": REFRESH_SECS } });
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { pause: TIMER_WAIT_MS },
    keys("r"),
    { pause: SETTLE_MS },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const modes = (await readFile(join(scenario.daemon.root, LIST_ARGV_FILE), "utf8")).trim().split("\n");
  expect(modes[0]).toBe("cached");
  expect(modes.filter((mode) => mode === "cached").length).toBeGreaterThanOrEqual(3);
  expect(modes.filter((mode) => mode === "refresh")).toEqual(["refresh"]);
}, REAL_SCENARIO_TIMEOUT_MS);
