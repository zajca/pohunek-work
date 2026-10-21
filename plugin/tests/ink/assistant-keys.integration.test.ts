// The Assistant form shares the New session field model: ↑/↓ skip the disabled Request row, and the Intent pick
// field filters its choices like the other pick fields.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("↑ and ↓ skip the disabled Request row of the assistant form", async () => {
  scenario = await startTuiScenario();
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    keys("a"),
    { expect: "NEW ASSISTANT" },
    { expect: "▸ Project" },
    keys(DOWN),
    { expect: "▸ Agent" },
    keys(DOWN),
    { expect: "▸ Intent" },
    keys(DOWN),
    { expect: "▸ Branch" },
    keys(UP),
    { expect: "▸ Intent" },
    keys(UP),
    { expect: "▸ Agent" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("typing deb in Intent narrows the intents; Enter picks it and moves past the Request row", async () => {
  scenario = await startTuiScenario();
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    keys("a"),
    { expect: "NEW ASSISTANT" },
    keys(DOWN),
    keys(DOWN),
    { expect: "▸ Intent" },
    keys("deb"),
    { expect: "Search: deb" },
    { expect: "1. debug" },
    keys("\r"),
    { expect: "‹ debug ›" },
    { expect: "▸ Branch" },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
