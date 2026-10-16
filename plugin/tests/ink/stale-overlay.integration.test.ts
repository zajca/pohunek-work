// Regression: acknowledging a notification closes its overlay only once the list has been read, and only
// if that overlay is still open. The control refresh is delayed at the CLI boundary (`host discover` is the
// first call of every refresh), so the owner can leave the notification and open help while it is pending.
import { afterEach, expect, test } from "bun:test";
import type { NotificationRecord as WireNotification } from "@pohunek/protocol";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const REFRESH_DELAY_MS = 3000;
const NOTIFICATION_WAIT_MS = 20_000;
const POLL_MS = 100;
const ESCAPE = "1b";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

/** Makes a real shell session fail, which the daemon reports as an unread notification. */
async function failSession(running: TuiScenario, id: string): Promise<void> {
  const sent = await running.daemon.pohunek(["session", "input", id, "exit 1\n", "--json"]);
  if (!sent.stdout.includes('"ok"')) throw new Error(`session input failed: ${sent.stdout}${sent.stderr}`);
}

/** Waits until the daemon lists the notification of the session. */
async function notificationOf(running: TuiScenario, sessionId: string): Promise<{ title: string; body: string }> {
  const deadline = Date.now() + NOTIFICATION_WAIT_MS;
  for (;;) {
    const listed = await running.daemon.pohunek(["notifications", "list", "--json"]);
    const wire = (JSON.parse(listed.stdout) as { ok?: { notifications?: WireNotification[] } }).ok?.notifications ?? [];
    const mine = wire.find((record) => record.session_id === sessionId);
    if (mine !== undefined) return { title: mine.title, body: mine.body };
    if (Date.now() > deadline) throw new Error("the daemon listed no notification for the session");
    await Bun.sleep(POLL_MS);
  }
}

test("a notification acknowledged during a delayed refresh does not close the overlay opened after it", async () => {
  scenario = await startTuiScenario({ rules: [{ match: ["host", "discover"], delayMs: REFRESH_DELAY_MS }] });
  const id = await createShellSession(scenario.daemon, "ack-session");
  await failSession(scenario, id);
  const record = await notificationOf(scenario, id);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    // The startup refresh is delayed too; acknowledging before it ends would skip the refresh after it.
    { pause: REFRESH_DELAY_MS * 2 },
    keys("4"),
    { expect: record.title },
    keys("\r"),
    { expect: record.body },
    // Opening the notification starts a delayed refresh; acknowledging before it ends would skip the refresh after it.
    { pause: REFRESH_DELAY_MS * 2 },
    keys("a"),
    { expect: "Notification acknowledged" },
    // The list read is still pending: leave the notification and open help.
    { send: ESCAPE, settle: 300 },
    keys("?"),
    { expect: "Every list:" },
    // The read finishes during this pause. Help keeps its own footer; a closed overlay would draw the main
    // footer at that point, so the main footer must not be drawn in this window.
    { clear: true },
    { absent: "Tab views", pause: REFRESH_DELAY_MS * 3 },
    keys("?"),
    { expect: "Tab views" },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("a notification opened during an acknowledgement's delayed refresh stays open when that refresh ends", async () => {
  scenario = await startTuiScenario({ rules: [{ match: ["host", "discover"], delayMs: REFRESH_DELAY_MS }] });
  const id = await createShellSession(scenario.daemon, "reopen-session");
  await failSession(scenario, id);
  const record = await notificationOf(scenario, id);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { pause: REFRESH_DELAY_MS * 2 },
    keys("4"),
    { expect: record.title },
    keys("\r"),
    { expect: record.body },
    { pause: REFRESH_DELAY_MS * 2 },
    keys("a"),
    { expect: "Notification acknowledged" },
    // Leave the acknowledged notification and open the notification again while its list read is pending.
    { send: ESCAPE, settle: 300 },
    keys("\r"),
    { expect: "Acknowledge" },
    // The read finishes during this pause. The reopened notification has its own footer; the main footer
    // must not be drawn in this window, because that would mean the read closed it.
    { clear: true },
    { absent: "Tab views", pause: REFRESH_DELAY_MS * 3 },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("an acknowledgement issued during a delayed in-flight read shows without waiting for that read", async () => {
  // Opening the notification starts a read that the delayed `host discover` holds for REFRESH_DELAY_MS. The
  // acknowledgement is issued during it and must show at once, not after the read has finished.
  scenario = await startTuiScenario({ rules: [{ match: ["host", "discover"], delayMs: REFRESH_DELAY_MS }] });
  const id = await createShellSession(scenario.daemon, "in-flight-session");
  await failSession(scenario, id);
  const record = await notificationOf(scenario, id);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { pause: REFRESH_DELAY_MS * 2 },
    keys("4"),
    { expect: record.title },
    keys("\r"),
    { expect: record.body },
    keys("a"),
    { expect: "Notification acknowledged" },
    { send: ESCAPE, settle: 300 },
    { expect: `${record.title}  acknowledged`, timeout: 15 },
    // The in-flight read ends and the reconcile queued by the acknowledgement runs once, after it.
    { pause: REFRESH_DELAY_MS * 2 },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  // Startup read, the read that opening the notification started, and exactly one reconcile after the acknowledgement.
  const discovers = (await scenario.proxy.calls()).filter((call) => call.includes("discover")).length;
  expect(discovers).toBe(3);
}, SCENARIO_TIMEOUT_MS);
