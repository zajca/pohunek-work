// The Stop and Remove confirmations act on the session the confirmation names. The detail toolbar's buttons and the
// x and D keys share one entry point, and leaving the confirmation (a view change) drops its target. Each test reads
// the sessions from the daemon after the confirmation, so a wrong target shows as a changed state. Any key leaves a
// confirmation, so the stale cases use Tab for it and then select beta from the list.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

/** Click on the detail toolbar of a 100x40 terminal (1-based cell): the Stop and Remove labels of the detail. */
const CLICK_STOP = "\x1b[<0;76;16M";
const CLICK_REMOVE = "\x1b[<0;84;16M";
const WIDE_ENOUGH_FOR_NO_PANEL = { cols: 100, rows: 40 };
const SETTLE_MS = 3000;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

interface Listed { readonly name: string | null; readonly state: string }

/** The sessions the daemon lists, by name; a removed session is absent. */
async function listed(tui: TuiScenario): Promise<Map<string, string>> {
  const result = await tui.daemon.pohunek(["session", "list", "--json"]);
  const envelope = JSON.parse(result.stdout) as { ok?: Listed[] };
  return new Map((envelope.ok ?? []).map((item) => [item.name ?? "", item.state]));
}

function click(sequence: string): PtyStep {
  return { send: Buffer.from(sequence).toString("hex"), settle: 500 };
}

async function startWithTwo(): Promise<TuiScenario> {
  const started = await startTuiScenario();
  await createShellSession(started.daemon, "alpha");
  await createShellSession(started.daemon, "beta");
  return started;
}

test("Stop on the detail of alpha stops alpha and only alpha", async () => {
  scenario = await startWithTwo();
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" }, keys("2"), { expect: "SESSIONS  2" },
    keys("\r"), { expect: "Back" },
    click(CLICK_STOP),
    { expect: "Confirm stop of alpha" },
    keys("y"),
    { pause: SETTLE_MS },
  ];
  const result = await scenario.run(steps, { ...WIDE_ENOUGH_FOR_NO_PANEL, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  const states = await listed(scenario);
  expect(states.get("alpha")).toBe("stopped");
  expect(states.get("beta")).toBe("running");
}, REAL_SCENARIO_TIMEOUT_MS);

test("a confirmation left by x on alpha does not act on beta", async () => {
  scenario = await startWithTwo();
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" }, keys("2"), { expect: "SESSIONS  2" },
    keys("x"), { expect: "Confirm stop of alpha" },
    keys("\t"), { expect: "SESSIONS  2" },
    keys("\x1b[B"),
    keys("\r"), { expect: "Back" },
    click(CLICK_STOP),
    { expect: "Confirm stop of beta" },
    keys("y"),
    { pause: SETTLE_MS },
  ];
  const result = await scenario.run(steps, { ...WIDE_ENOUGH_FOR_NO_PANEL, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  const states = await listed(scenario);
  expect(states.get("beta")).toBe("stopped");
  expect(states.get("alpha")).toBe("running");
}, REAL_SCENARIO_TIMEOUT_MS);

test("Remove on the detail of alpha removes alpha and only alpha", async () => {
  scenario = await startWithTwo();
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" }, keys("2"), { expect: "SESSIONS  2" },
    keys("\r"), { expect: "Back" },
    click(CLICK_REMOVE),
    { expect: "Confirm remove of alpha" },
    keys("y"),
    { pause: SETTLE_MS },
  ];
  const result = await scenario.run(steps, { ...WIDE_ENOUGH_FOR_NO_PANEL, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  const states = await listed(scenario);
  expect(states.has("alpha")).toBe(false);
  expect(states.get("beta")).toBe("running");
}, REAL_SCENARIO_TIMEOUT_MS);

test("a Remove confirmation left by D on alpha does not remove beta", async () => {
  scenario = await startWithTwo();
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" }, keys("2"), { expect: "SESSIONS  2" },
    keys("D"), { expect: "Confirm remove of alpha" },
    keys("\t"), { expect: "SESSIONS  2" },
    keys("\x1b[B"),
    keys("\r"), { expect: "Back" },
    click(CLICK_REMOVE),
    { expect: "Confirm remove of beta" },
    keys("y"),
    { pause: SETTLE_MS },
  ];
  const result = await scenario.run(steps, { ...WIDE_ENOUGH_FOR_NO_PANEL, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  const states = await listed(scenario);
  expect(states.has("beta")).toBe(false);
  expect(states.get("alpha")).toBe("running");
}, REAL_SCENARIO_TIMEOUT_MS);
