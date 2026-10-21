// A refresh of an open Activity list keeps the records loaded past its first page. The daemon stamps each record with
// nanoseconds, so records of one creation time cannot be made through it; the socket relay pins `created_at` of the
// records it lists, so the loaded pages share one time and only the id tells them apart.
import { afterEach, expect, test } from "bun:test";
import { connectLocal } from "@pohunek/sdk";
import { keys, type PtyStep } from "./support/pty.ts";
import { startSocketRelay, type SocketRelay } from "./support/socket-relay.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { daemonLocalSocket } from "../helpers/core-daemon.ts";

const TAB = "09";
const DOWN = "1b5b42";
const PAGE_SIZE = 5;
const NOTIFICATION_COUNT = 12;
const SHARED_CREATED_AT = "2026-01-01T00:00:00.000000000Z";
let scenario: TuiScenario | null = null;
let relay: SocketRelay | null = null;

afterEach(async () => {
  await relay?.stop();
  relay = null;
  await scenario?.stop();
  scenario = null;
});

test("a refresh of Activity keeps the loaded records that share the first page's creation time", async () => {
  scenario = await startTuiScenario({ overrides: { "pohunek.notifications_page_size": PAGE_SIZE } });
  const running = scenario;
  const daemonSocket = daemonLocalSocket(running.daemon);
  const client = await connectLocal(daemonSocket);
  try {
    for (let index = 0; index < NOTIFICATION_COUNT; index += 1) {
      await client.call("notification.create", {
        source: { provider: "activity-refresh-test", provider_event: `event-${String(index)}`, host_local_source_id: `source-${String(index)}` },
        kind: "error", severity: "info", title: `activity ${String(index)}`, body: "created by the scenario",
      });
    }
  } finally {
    await client.close();
  }
  relay = await startSocketRelay(daemonSocket, { holdMs: 0, skipCount: 0, holdCount: 0, refuseHealthAfterHold: false, notificationCreatedAt: SHARED_CREATED_AT });

  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { expect: `ACTIVITY  ${String(PAGE_SIZE)}` },
    keys("m"),
    { expect: `ACTIVITY  ${String(PAGE_SIZE * 2)}` },
    // The refresh reads the first page again and the loaded records stay, because each of them is older in the list order
    // than the first page's last record, even though they share its creation time. A selection move then redraws the
    // list, which shows the count the refresh left; an identical frame would not be written again.
    { clear: true },
    { ...keys("r"), settle: 800 },
    { send: DOWN, settle: 800 },
    { expect: `ACTIVITY  ${String(PAGE_SIZE * 2)}`, timeout: 20 },
  ];
  const result = await running.run(steps, { timeoutS: 60, env: { POHUNEK_SOCKET_PATH: relay.socket } });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-2500)}`).toBe(-1);
}, 120_000);
