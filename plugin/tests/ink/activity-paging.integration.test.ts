// The Activity view shows one page of its scope when it is shown, and the next page only when the owner asks for it.
// The notifications are created through the SDK of the pinned release on the real daemon socket.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { connectLocal, type Client } from "@pohunek/sdk";
import { keys, type PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const TAB = "09";
const PAGE_SIZE = 5;
const NOTIFICATION_COUNT = 12;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("the Activity view shows one page of notifications and loads the next page on demand", async () => {
  scenario = await startTuiScenario({ overrides: { "pohunek.notifications_page_size": PAGE_SIZE } });
  const client: Client = await connectLocal(join(scenario.daemon.runtimeDir, "pohunek", "daemon.sock"));
  try {
    for (let index = 0; index < NOTIFICATION_COUNT; index += 1) {
      await client.call("notification.create", {
        source: { provider: "activity-paging-test", provider_event: `event-${String(index)}`, host_local_source_id: `source-${String(index)}` },
        kind: "error", severity: "info", title: `activity ${String(index)}`, body: "created by the scenario",
      });
    }
  } finally {
    await client.close();
  }

  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    // Work, Sessions and Hosts pass by Tab; Activity then reads its first page of the Recent scope. Expectations match in
    // the order the frames are drawn, so the header of the list is awaited before the footer's scope.
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { expect: `ACTIVITY  ${String(PAGE_SIZE)}` },
    { clear: true },
    keys("m"),
    { expect: `ACTIVITY  ${String(PAGE_SIZE * 2)}` },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-2500)}`).toBe(-1);
}, 120_000);
