// The New session form: ↑/↓ move between the fields like Tab and Shift-Tab and stop at the first and last one;
// ←/→ change only the focused pick field; typing filters a pick field's choices with the fuzzy matcher, Enter
// picks the highlighted match and moves on, and a query without a match keeps the field. The profiles are real
// agent profiles of the test daemon, so the Agent field lists them next to the default agent.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const TAB = "09";
const PROFILES = ["opus-review", "sonnet-plan"];
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

/** The steps that open the New session form from the empty Sessions view; the form starts on the Project field. */
function openNewSession(): PtyStep[] {
  return [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    keys("n"),
    { expect: "NEW SESSION" },
    { expect: "▸ Project" },
  ];
}

test("↑ and ↓ move between the fields and stop at the first and last one", async () => {
  scenario = await startTuiScenario();
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys(UP),
    { expect: "▸ Host" },
    // The first field stops ↑: a wrap would leave the focus on the last field, so ↓ would show no field.
    keys(UP),
    keys(DOWN),
    { expect: "▸ Project" },
    keys(DOWN),
    { expect: "▸ Agent" },
    keys(DOWN),
    { expect: "▸ Action/template" },
    keys(DOWN),
    { expect: "▸ Name" },
    keys(UP),
    { expect: "▸ Action/template" },
    { send: TAB, settle: 300 },
    { expect: "▸ Name" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("←/→ change only the focused pick field", async () => {
  scenario = await startTuiScenario({ agentProfiles: PROFILES });
  // The Agent choices are default, shell, opus-review, sonnet-plan; the form starts on shell.
  // Each check reads the frame after a key press, so an expectation names a line that frame prints after the last one.
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys(DOWN),
    { expect: "▸ Agent" },
    { expect: "‹ shell ›" },
    keys(RIGHT),
    { expect: "‹ opus-review ›" },
    keys(RIGHT),
    { expect: "‹ Local ›" },
    { expect: "‹ widgets ›" },
    { expect: "‹ sonnet-plan ›" },
    keys(LEFT),
    { expect: "‹ Local ›" },
    { expect: "‹ widgets ›" },
    { expect: "‹ opus-review ›" },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("typing opu in Agent narrows the profiles; Enter picks the top match and moves on", async () => {
  scenario = await startTuiScenario({ agentProfiles: PROFILES });
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys(DOWN),
    { expect: "▸ Agent" },
    keys("opu"),
    { expect: "Search: opu" },
    { expect: "1. opus-review" },
    keys("\r"),
    { expect: "‹ opus-review ›" },
    { expect: "▸ Action/template" },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("a query without a match shows a status and keeps the field", async () => {
  scenario = await startTuiScenario({ agentProfiles: PROFILES });
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys(DOWN),
    { expect: "▸ Agent" },
    keys("zzq"),
    { expect: "Search: zzq" },
    keys("\r"),
    { expect: "▸ Agent" },
    { expect: "No agent matches \"zzq\"" },
    { send: "7f", settle: 200 },
    { send: "7f", settle: 200 },
    { send: "7f", settle: 200 },
    { expect: "Choose agent" },
    { expect: "1. default" },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
