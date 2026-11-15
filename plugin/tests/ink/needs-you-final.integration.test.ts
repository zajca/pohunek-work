// Regression: an ended session is listed as unavailable, never under Needs you although nothing in it can be answered.
// A live session with an open approval stays under Needs you.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { connectLocal } from "@pohunek/sdk";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const WAIT_MS = 20_000;
const POLL_MS = 100;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

/** Waits until `check` holds, polling the daemon through the release CLI. */
async function waitFor(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

test("an ended session is not under Needs you, a live one with an approval is", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const running = scenario;
  const ended = await createShellSession(running.daemon, "ended-session");
  const asking = await createShellSession(running.daemon, "asking-session");
  const sent = await running.daemon.pohunek(["session", "input", ended, "exit 1\n", "--json"]);
  if (!sent.stdout.includes('"ok"')) throw new Error(`session input failed: ${sent.stdout}${sent.stderr}`);
  await waitFor("the failed state", async () => {
    const inspected = await running.daemon.pohunek(["session", "inspect", ended, "--json"]);
    return (JSON.parse(inspected.stdout) as { ok?: { state?: unknown } }).ok?.state === "failed";
  });
  const client = await connectLocal(join(running.daemon.runtimeDir, "pohunek", "daemon.sock"));
  try {
    await client.call("notification.create", {
      source: { provider: "needs-you-final-test", provider_event: "approval-0", host_local_source_id: "approval-0" },
      kind: "approval_required", severity: "action_required", title: "approve the plan", body: "created by the scenario", session_id: asking,
    });
  } finally {
    await client.close();
  }
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "NEEDS YOU  1" },
    { expect: "asking-session" },
    { expect: "UNAVAILABLE  1" },
    { expect: "ended-session" },
    keys("q"),
  ];
  const result = await running.run(steps, { cols: 120, rows: 40, timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-2500)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);
