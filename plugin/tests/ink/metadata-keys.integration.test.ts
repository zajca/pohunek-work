// The metadata key m of the session detail opens a key=value line. Enter without a separator is refused on the status
// line and keeps the line open; Esc leaves it for the detail; a key=value line is merged into the session metadata.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const WIDE = { cols: 100, rows: 40 };
const ENTER = "\r";
const ESCAPE = "\x1b";
const SETTLE_MS = 2000;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("m opens the metadata line; a line without = is refused, Esc keeps the detail, and key=value is stored", async () => {
  scenario = await startTuiScenario();
  const sessionId = await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys(ENTER),
    { expect: "Back" },
    keys("m"),
    { expect: "Metadata key=value: _" },
    keys(ENTER),
    { expect: "Metadata needs key=value" },
    keys(ESCAPE),
    { expect: "Back" },
    keys("m"),
    { expect: "Metadata key=value: _" },
    keys("team=core"),
    { expect: "Metadata key=value: team=core_" },
    keys(ENTER),
    { pause: SETTLE_MS },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  const inspected = JSON.parse((await scenario.daemon.pohunek(["session", "inspect", sessionId, "--json"])).stdout) as { ok?: { metadata?: Record<string, string> } };
  expect(inspected.ok?.metadata?.team).toBe("core");
}, REAL_SCENARIO_TIMEOUT_MS);
