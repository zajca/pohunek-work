// The choice list of a pick field scrolls with the wheel independently of its highlight, and a paste into a pick
// field becomes its query. The Agent field lists the default agent, the shell and the installed profiles.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const DOWN = "\x1b[B";
const UP = "\x1b[A";
/** Wheel down over the first choice row of the Agent list (SGR button 65, 1-based cell row 15, column 10). */
const WHEEL_DOWN_AT_AGENT_CHOICES = "\x1b[<65;10;15M";
/** The same wheel step once a query is typed: the Search line sits above the list and pushes it one row down. */
const WHEEL_DOWN_AT_FILTERED_AGENT_CHOICES = "\x1b[<65;10;16M";
const BACKSPACE = "\x7f";
const WHEEL_STEPS = 3;
const PROFILES = Array.from({ length: 10 }, (_, index) => `profile-${String.fromCharCode(97 + index)}`);
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

/** A bracketed paste, as the terminal sends it when the owner pastes text. */
function paste(text: string): PtyStep {
  return { send: Buffer.from(`\x1b[200~${text}\x1b[201~`).toString("hex"), settle: 300 };
}

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

test("the wheel scrolls the Agent choices past the highlighted one", async () => {
  scenario = await startTuiScenario({ agentProfiles: PROFILES });
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys(DOWN),
    { expect: "▸ Agent" },
    { expect: "1. default" },
    { send: Buffer.from(WHEEL_DOWN_AT_AGENT_CHOICES).toString("hex"), settle: 300 },
    { send: Buffer.from(WHEEL_DOWN_AT_AGENT_CHOICES).toString("hex"), settle: 300 },
    { send: Buffer.from(WHEEL_DOWN_AT_AGENT_CHOICES).toString("hex"), settle: 300 },
    // The window starts at the fourth choice, past the highlighted shell; a snap back would show "2. shell" again.
    { expect: `${String(WHEEL_STEPS + 1)}. ${PROFILES[WHEEL_STEPS - 2] ?? ""}` },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("a paste into the Host and Agent fields becomes the field's query", async () => {
  scenario = await startTuiScenario({ agentProfiles: ["opus-review", "sonnet-plan"] });
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys(UP),
    { expect: "▸ Host" },
    paste("loc"),
    { expect: "Search: loc" },
    { expect: "1. Local" },
    keys("\r"),
    { expect: "▸ Project" },
    keys(DOWN),
    { expect: "▸ Agent" },
    paste("opu"),
    { expect: "Search: opu" },
    { expect: "1. opus-review" },
    keys("\r"),
    { expect: "‹ opus-review ›" },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("a query edit after a wheel scroll brings the highlighted match back into the choice window", async () => {
  scenario = await startTuiScenario({ agentProfiles: PROFILES });
  // The highlight stays on the first match through the scroll and the Backspace, so only the query change moves the window.
  const steps: PtyStep[] = [
    ...openNewSession(),
    keys(DOWN),
    { expect: "▸ Agent" },
    keys("profile"),
    { expect: "Search: profile" },
    { expect: "▸ 1. profile-a" },
    { send: Buffer.from(WHEEL_DOWN_AT_FILTERED_AGENT_CHOICES).toString("hex"), settle: 600 },
    { send: Buffer.from(WHEEL_DOWN_AT_FILTERED_AGENT_CHOICES).toString("hex"), settle: 600 },
    { send: Buffer.from(WHEEL_DOWN_AT_FILTERED_AGENT_CHOICES).toString("hex"), settle: 600 },
    { expect: `${String(WHEEL_STEPS + 1)}. ${PROFILES[WHEEL_STEPS] ?? ""}` },
    keys(BACKSPACE),
    { expect: "Search: profil" },
    { expect: "▸ 1. profile-a" },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
