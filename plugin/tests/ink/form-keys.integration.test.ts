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

test("three Tabs sent as one write move the focus three fields and never enter a text field", async () => {
  scenario = await startTuiScenario();
  // Project, Agent, Action/template, Name: the Tabs arrive together, so each one must be read as a press of its own.
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys("\t\t\t"),
    { expect: "▸ Name" },
    keys("q"),
    // A tab typed into Name would sit before the q, so the value must read exactly q.
    { expect: `▸ ${"Name".padEnd(16)} q_` },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("a chunk of text and a Tab types the text and moves the focus", async () => {
  scenario = await startTuiScenario();
  // Name is the fourth field: the text and the Tab arrive in one write, so the text lands in Name and the focus moves on.
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys("\t\t\t"),
    { expect: "▸ Name" },
    keys("abc\t"),
    { expect: "▸ Prompt" },
    keys(UP),
    { expect: `▸ ${"Name".padEnd(16)} abc_` },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("n and a Tab sent as one write open the form and move the focus to the second field", async () => {
  scenario = await startTuiScenario();
  // The Tab must read the form the n press opened, so the form stays open with its focus on Agent.
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    keys("n\t"),
    { expect: "NEW SESSION" },
    { expect: "▸ Agent" },
    // The form stays open: a closed form would show the empty Sessions view again.
    { absent: "No sessions", pause: 500 },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("a Tab sent before a paste lands the paste in the field the Tab moves to", async () => {
  scenario = await startTuiScenario();
  // Name is the fourth field. The Tab and the bracketed paste arrive in one write: the paste must land in Prompt,
  // the field the Tab reached, and Name must stay empty.
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys("\t\t\t"),
    { expect: "▸ Name" },
    keys(`\t\x1b[200~hello\x1b[201~`),
    { expect: "▸ Prompt" },
    // The cursor sits on Prompt only, so the text after it is the one the paste put there.
    { expect: "hello_" },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("two ↓ sent as one write move the focus two fields", async () => {
  scenario = await startTuiScenario();
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys(DOWN + DOWN),
    { expect: "▸ Action/template" },
    // A third move would reach Name; the focus must stay on Action/template.
    { absent: "▸ Name", pause: 500 },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
