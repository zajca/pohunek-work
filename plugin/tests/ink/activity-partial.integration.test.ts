// A host whose first page of Activity fails keeps the list newest first when its next page answers. The remote daemon is
// reached through a TCP relay that refuses one list request of the host; the local daemon is the TUI's own.
import { afterEach, expect, test } from "bun:test";
import { connectLocal, type Client } from "@pohunek/sdk";
import { daemonLocalSocket, startCoreDaemon, type CoreDaemon } from "../helpers/core-daemon.ts";
import { keys, type PtyStep } from "./support/pty.ts";
import { startTcpRelay, type TcpRelay } from "./support/tcp-relay.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const TAB = "09";
const PAGE_SIZE = 5;
const LOCAL_RECORDS = 7;
const REMOTE_RECORDS = 3;
const PEER = "remote-peer";
/**
 * The no-cursor lists of the remote host before the Activity page: the startup read of its notifications. The Activity
 * first page is the next one, so it is the request the relay refuses.
 */
const REFUSED_LIST = 9;
/** Long enough that no periodic refresh runs during the scenario, so the page after the failure is read by "load more". */
const RECONCILE_OFF_SECS = 600;
let scenario: TuiScenario | null = null;
let remote: CoreDaemon | null = null;
let relay: TcpRelay | null = null;

afterEach(async () => {
  await relay?.stop();
  relay = null;
  await remote?.stop();
  remote = null;
  await scenario?.stop();
  scenario = null;
});

async function createRecords(client: Client, label: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await client.call("notification.create", {
      source: { provider: "activity-partial-test", provider_event: `${label}-${String(index)}`, host_local_source_id: `${label}-${String(index)}` },
      kind: "error", severity: "info", title: `${label}-${String(index)}`, body: "created by the scenario",
    });
  }
}

/** The creation time of each record of a label, read from the daemon that holds it. */
async function timesOf(client: Client, label: string): Promise<Map<string, string>> {
  const page = await client.call("notification.list", { limit: 50 }) as { notifications: { title: string; created_at: string }[] };
  return new Map(page.notifications.filter((item) => item.title.startsWith(`${label}-`)).map((item) => [item.title, item.created_at]));
}

test("a host whose first Activity page fails keeps the list newest first when its next page answers", async () => {
  // The remote daemon and its relay exist before the TUI starts, because the TUI learns the remote host from discovery.
  remote = await startCoreDaemon();
  relay = startTcpRelay(daemonLocalSocket(remote), { refuseNoCursorListAt: REFUSED_LIST });
  const tcp = relay;
  const remoteHost = {
    name: "remote-daemon", fqdn: "remote.example", address: "127.0.0.1", port: tcp.port, overlay: "netbird", peer_id: PEER,
    classification: "reachable_daemon", daemon_version: "0.34.2",
  };
  scenario = await startTuiScenario({
    rules: [{ match: ["host", "discover"], appendOk: [remoteHost] }],
    overrides: { "pohunek.notifications_page_size": PAGE_SIZE, "tui.session_reconcile_secs": RECONCILE_OFF_SECS, "tui.refresh_interval_secs": RECONCILE_OFF_SECS },
  });

  // The records are created before the TUI reads them. The remote records are created after the local ones, so they are
  // the newest records of the list.
  const local = await connectLocal(daemonLocalSocket(scenario.daemon));
  await createRecords(local, "local", LOCAL_RECORDS);
  const localTimes = await timesOf(local, "local");
  await local.close();
  const remoteClient = await connectLocal(daemonLocalSocket(remote));
  await createRecords(remoteClient, "remote", REMOTE_RECORDS);
  const remoteTimes = await timesOf(remoteClient, "remote");
  await remoteClient.close();

  const newestRemote = remoteTimes.get(`remote-${String(REMOTE_RECORDS - 1)}`);
  const newestLocal = localTimes.get(`local-${String(LOCAL_RECORDS - 1)}`);
  if (newestRemote === undefined || newestLocal === undefined) throw new Error("the records were not created");

  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    { send: TAB, settle: 800 },
    // The remote host's first page is refused, so the first page holds the local records only.
    { expect: `ACTIVITY  ${String(PAGE_SIZE)}` },
    { clear: true },
    keys("m"),
    { expect: `ACTIVITY  ${String(PAGE_SIZE * 2)}`, timeout: 30 },
    // The page loaded after the refusal starts with the newest record, which is above the newest local record.
    { expect: newestRemote, timeout: 30 },
    { expect: newestLocal, timeout: 30 },
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-2500)}`).toBe(-1);
}, 120_000);
