// Scenarios on real sessions and real notifications: the test daemon runs shell sessions, and a
// shell session that exits with status 1 fails, which the daemon reports as a notification. The
// only synthetic condition is a delayed CLI reply, supplied by the CLI proxy, in the one scenario
// that is about that delay.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { connectLocal } from "@pohunek/sdk";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";
import type { NotificationRecord as WireNotification } from "@pohunek/protocol";

const NOTIFICATION_WAIT_MS = 20_000;
const POLL_MS = 100;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

interface NotificationRecord { readonly id: string; readonly title: string; readonly body: string; readonly sessionId: string }

/** Waits until the daemon lists `count` notifications for the given sessions, newest first. */
async function notificationsFor(scenario: TuiScenario, sessionIds: readonly string[]): Promise<NotificationRecord[]> {
  const deadline = Date.now() + NOTIFICATION_WAIT_MS;
  for (;;) {
    const listed = await scenario.daemon.pohunek(["notifications", "list", "--json"]);
    const wire = (JSON.parse(listed.stdout) as { ok?: { notifications?: WireNotification[] } }).ok?.notifications ?? [];
    const records = wire.flatMap((record) => record.session_id === undefined ? [] : [{ id: record.id, title: record.title, body: record.body, sessionId: record.session_id }]);
    const mine = records.filter((record) => sessionIds.includes(record.sessionId));
    if (mine.length >= sessionIds.length) return mine;
    if (Date.now() > deadline) throw new Error(`the daemon listed ${String(mine.length)} of ${String(sessionIds.length)} notifications`);
    await Bun.sleep(POLL_MS);
  }
}

test("clicking a real notification keeps its message visible until Open session is chosen", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const id = await createShellSession(scenario.daemon, "alert-session");
  const client = await connectLocal(join(scenario.daemon.runtimeDir, "pohunek", "daemon.sock"));
  try {
    await client.call("notification.create", {
      source: { provider: "real-sessions-test", provider_event: "alert-0", host_local_source_id: "alert-0" },
      kind: "approval_required", severity: "action_required", title: "alert record", body: "created by the scenario", session_id: id,
    });
  } finally {
    await client.close();
  }
  const [record] = await notificationsFor(scenario, [id]);
  if (record === undefined) throw new Error("no notification");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("4"),
    { expect: record.title },
    keys("\r"),
    { expect: record.body },
    { pause: 2000 },
    keys("o"),
    { pause: 1500 },
  ];
  const result = await scenario.run(steps, { cols: 100, timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const calls = await scenario.proxy.calls();
  expect(calls.filter((call) => call.includes("inspect")).length).toBeGreaterThan(0);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a wheel and a row click select the session the owner picks, which then attaches", async () => {
  scenario = await startTuiScenario({ rules: [{ match: ["attach"], replaceWith: [Bun.which("sleep") ?? "/bin/sleep", "1"] }] });
  const ids: string[] = [];
  for (let index = 1; index <= 12; index += 1) ids.push(await createShellSession(scenario.daemon, `Session ${String(index).padStart(2, "0")}`));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  12" },
    // A click on the second row (the rows start below the header, the frame and the subtitle).
    keys("\x1b[<0;10;11M"),
    { pause: 300 },
    keys("\x1b[<0;10;11m"),
    { pause: 300 },
    keys("o"),
    { pause: 1500 },
  ];
  const result = await scenario.run(steps, { cols: 100, timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const attached = (await scenario.proxy.calls()).filter((call) => call.includes("attach")).map((call) => call.at(-1));
  expect(attached).toEqual([ids[1]]);
}, REAL_SCENARIO_TIMEOUT_MS);
