// The session panel follows the notifications of its session while it stays selected: an action archived from the
// Activity view no longer shows as the session's attention when the panel is drawn again.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { connectLocal } from "@pohunek/sdk";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const WIDE = { cols: 120, rows: 40 };
const TAB = "09";
const ENTER = "0d";
const ESCAPE = "1b";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("an action archived from Activity is no longer the attention of its session panel", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const running = scenario;
  const sessionId = await createShellSession(running.daemon, "stale-notes");
  const client = await connectLocal(join(running.daemon.runtimeDir, "pohunek", "daemon.sock"));
  try {
    await client.call("notification.create", {
      source: { provider: "session-notes-test", provider_event: "approval-0", host_local_source_id: "approval-0" },
      kind: "approval_required", severity: "action_required", title: "stale attention", body: "created by the scenario", session_id: sessionId,
    });
  } finally {
    await client.close();
  }
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "Attention  stale attention" },
    // Activity: the first record opens, and archiving it leaves the attention of the session.
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { expect: "ACTIVITY  1" },
    { send: ENTER, settle: 800 },
    keys("x"),
    { expect: "Notification archived" },
    { send: ESCAPE, settle: 800 },
    // Back on the session: the panel is drawn from the records it has now.
    keys("2"),
    { expect: "Attention  none" },
  ];
  const result = await running.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-2500)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
