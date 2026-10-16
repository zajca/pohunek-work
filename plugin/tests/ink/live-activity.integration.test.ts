// The Activity view follows the notifications of the daemon while it is open: a notification created after the view is
// shown appears in the list without a key press. The notification is created through the SDK on the real daemon socket.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { connectLocal } from "@pohunek/sdk";
import { keys, type PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const TAB = "09";
const ENTER = "0d";
const ESCAPE = "1b";
const CREATE_AFTER_MS = 3_000;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("a notification created while Activity is open appears in its list without a key press", async () => {
  scenario = await startTuiScenario();
  const running = scenario;
  const socket = join(running.daemon.runtimeDir, "pohunek", "daemon.sock");
  // The notification is created once the empty Activity list is drawn, so it arrives through the event stream.
  const creating = Bun.sleep(CREATE_AFTER_MS).then(async () => {
    const client = await connectLocal(socket);
    try {
      await client.call("notification.create", {
        source: { provider: "live-activity-test", provider_event: "event-0", host_local_source_id: "source-0" },
        kind: "error", severity: "info", title: "live record", body: "created by the scenario",
      });
    } finally {
      await client.close();
    }
  });
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { expect: "No recent notifications" },
    { expect: "ACTIVITY  1", timeout: 30 },
  ];
  const result = await running.run(steps, { timeoutS: 60 });
  await creating;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-2500)}`).toBe(-1);
}, 120_000);

test("opening an unread notification marks it read and it leaves the Unread list without a refresh", async () => {
  scenario = await startTuiScenario();
  const running = scenario;
  const client = await connectLocal(join(running.daemon.runtimeDir, "pohunek", "daemon.sock"));
  try {
    await client.call("notification.create", {
      source: { provider: "live-activity-test", provider_event: "unread-0", host_local_source_id: "unread-0" },
      kind: "error", severity: "info", title: "unread record", body: "created by the scenario",
    });
  } finally {
    await client.close();
  }
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { expect: "ACTIVITY  1" },
    { ...keys("c"), settle: 800 },
    { expect: "Scope: Unread" },
    // Enter opens the notification, which the TUI marks read; the record leaves the Unread list.
    { send: ENTER, settle: 800 },
    { send: ESCAPE, settle: 800 },
    { expect: "No unread notifications", timeout: 30 },
  ];
  const result = await running.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-2500)}`).toBe(-1);
}, 120_000);
