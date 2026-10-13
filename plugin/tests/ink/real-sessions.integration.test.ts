// Scenarios on real sessions and real notifications: the test daemon runs shell sessions, and a
// shell session that exits with status 1 fails, which the daemon reports as a notification. The
// only synthetic condition is a delayed CLI reply, supplied by the CLI proxy, in the one scenario
// that is about that delay.
import { afterEach, expect, test } from "bun:test";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys, type PtyStep } from "./support/pty.ts";

const NOTIFICATION_WAIT_MS = 20_000;
const POLL_MS = 100;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

/** Makes a real shell session fail, which the daemon reports as an unread notification. */
async function failSession(scenario: TuiScenario, id: string): Promise<void> {
  const sent = await scenario.daemon.pohunek(["session", "input", id, "exit 1\n", "--json"]);
  if (!sent.stdout.includes('"ok"')) throw new Error(`session input failed: ${sent.stdout}${sent.stderr}`);
}

interface NotificationRecord { readonly id: string; readonly title: string; readonly body: string; readonly sessionId: string }

/** Waits until the daemon lists `count` notifications for the given sessions, newest first. */
async function notificationsFor(scenario: TuiScenario, sessionIds: readonly string[]): Promise<NotificationRecord[]> {
  const deadline = Date.now() + NOTIFICATION_WAIT_MS;
  for (;;) {
    const listed = await scenario.daemon.pohunek(["notifications", "list", "--json"]);
    const records = (JSON.parse(listed.stdout) as { ok?: { notifications?: NotificationRecord[] } }).ok?.notifications ?? [];
    const mine = records.filter((record) => sessionIds.includes(record.sessionId));
    if (mine.length >= sessionIds.length) return mine;
    if (Date.now() > deadline) throw new Error(`the daemon listed ${String(mine.length)} of ${String(sessionIds.length)} notifications`);
    await Bun.sleep(POLL_MS);
  }
}

test("clicking a real notification keeps its message visible until Open session is chosen", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const id = await createShellSession(scenario.daemon, "alert-session");
  await failSession(scenario, id);
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
    { send: "\x1b[<0;10;11M" },
    { pause: 300 },
    { send: "\x1b[<0;10;11m" },
    { pause: 300 },
    keys("o"),
    { pause: 1500 },
  ];
  const result = await scenario.run(steps, { cols: 100, timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const attached = (await scenario.proxy.calls()).filter((call) => call.includes("attach")).map((call) => call.at(-1));
  expect(attached).toEqual([ids[1]]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("an older notification read response cannot replace the newer detail the owner opened", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const first = await createShellSession(scenario.daemon, "older-session");
  await failSession(scenario, first);
  await notificationsFor(scenario, [first]);
  const second = await createShellSession(scenario.daemon, "newer-session");
  await failSession(scenario, second);
  const records = await notificationsFor(scenario, [first, second]);
  const newest = records.find((record) => record.sessionId === second);
  const older = records.find((record) => record.sessionId === first);
  if (newest === undefined || older === undefined) throw new Error("missing notifications");
  // The read of the newest notification answers after the owner has moved on to the older one.
  await scenario.proxy.setRules([{ match: ["notifications", "read", newest.id], delayMs: 3000 }]);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("4"),
    { expect: newest.title },
    keys("\r"),
    { expect: newest.body },
    keys("\x1b"),
    { expect: older.title },
    keys("\x1b[B"),
    keys("\r"),
    { expect: older.body },
    { pause: 4000 },
  ];
  const result = await scenario.run(steps, { cols: 100, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  // The late answer for the newest notification must not be the last detail shown.
  expect(result.output.lastIndexOf(older.body)).toBeGreaterThan(result.output.lastIndexOf(newest.body));
}, REAL_SCENARIO_TIMEOUT_MS);
