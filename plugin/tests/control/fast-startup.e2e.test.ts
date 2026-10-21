// The control client publishes a host's sessions before its notifications are read, and a notification event
// applies its change without paging the notifications again. The daemon is the real pinned release; the relay
// in front of its socket only holds the `notification.list` replies, which the daemon cannot delay itself.
import { afterEach, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectLocal, type Client } from "@pohunek/sdk";
import { createControlClient, type ControlClient, type ControlSnapshot } from "../../src/control/index.ts";
import { NotificationAnnouncer } from "../../src/ink/notices.ts";
import { createLogger } from "../../src/log.ts";
import { startControlRelay, type ControlRelay } from "../helpers/control-relay.ts";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, startCoreDaemon, type CoreDaemon } from "../helpers/core-daemon.ts";

const SCENARIO_TIMEOUT_MS = 60_000;
const SNAPSHOT_WAIT_MS = 10_000;
const NOTIFICATION_COUNT = 30;
const ATTENTION_COUNT = 3;
const ACTIVITY_COUNT = 60;
const PAGE_SIZE = 10;
let daemon: CoreDaemon | null = null;
let control: ControlClient | null = null;
let relay: ControlRelay | null = null;
let creator: Client | null = null;

afterEach(async () => {
  relay?.release();
  await control?.close();
  control = null;
  await creator?.close();
  creator = null;
  relay?.stop();
  relay = null;
  await daemon?.stop();
  daemon = null;
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

function clientFor(fixture: CoreDaemon, localSocket: string): ControlClient {
  return createControlClient({
    binary: join(fixture.coreDir, "pohunek"), timeoutMs: 10_000, notificationsPageSize: PAGE_SIZE, reconnectMaxMs: 1_000, localSocket, env: fixture.clientEnv,
  });
}

function notificationSource(index: number): { provider: string; provider_event: string; host_local_source_id: string } {
  return { provider: "fast-startup-test", provider_event: `event-${String(index)}`, host_local_source_id: `source-${String(index)}` };
}

async function createNotification(index: number): Promise<void> {
  if (creator === null) throw new Error("the notification creator is not connected");
  await creator.call("notification.create", {
    source: notificationSource(index), kind: "approval_required", severity: "action_required", title: `notification ${String(index)}`, body: "created by the scenario",
  });
}

/** Resolves with the first snapshot that satisfies `matches`, or rejects when none arrives within the wait. */
function nextSnapshot(client: ControlClient, matches: (snapshot: ControlSnapshot) => boolean, what: string): Promise<ControlSnapshot> {
  return new Promise<ControlSnapshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`${what} did not arrive within ${String(SNAPSHOT_WAIT_MS)} ms`));
    }, SNAPSHOT_WAIT_MS);
    const unsubscribe = client.subscribe((snapshot) => {
      if (!matches(snapshot)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

test("the sessions of a host are published while its notifications are still being read", async () => {
  daemon = await startCoreDaemon();
  const created = await daemon.pohunek(["session", "new", "--agent", "shell", "--cwd", daemon.root, "--name", "shown-first", "--json"]);
  expect(created.exitCode, created.stderr).toBe(0);
  creator = await connectLocal(join(daemon.runtimeDir, "pohunek", "daemon.sock"));
  for (let index = 0; index < NOTIFICATION_COUNT; index += 1) await createNotification(index);

  // The announcer runs on the snapshots of the scenario: the notifications read after the gap are a baseline and are not announced.
  const calls = join(daemon.root, "notify-calls");
  const notifier = join(daemon.root, "notify-send");
  await writeFile(notifier, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);
  await chmod(notifier, 0o755);
  const logger = createLogger({ logDir: join(daemon.root, "logs"), command: "tui", maxStringLength: 1024 });
  const announcer = new NotificationAnnouncer({ command: notifier, timeoutMs: 2_000 }, logger);
  try {
    relay = startControlRelay(join(daemon.runtimeDir, "pohunek", "daemon.sock"), join(daemon.runtimeDir, "relay.sock"));
    control = clientFor(daemon, relay.socket);
    relay.holdNotificationLists();
    const client = control;
    const refreshed = client.refresh();
    let shown: ControlSnapshot;
    try {
      shown = await nextSnapshot(client, (snapshot) => snapshot.sessions.some((session) => session.name === "shown-first"),
        "the session of the host while its notifications are held");
      expect(shown.notifications).toEqual([]);
      expect(shown.pendingNotifications).toEqual(["local"]);
      await announcer.announce(shown);
    } finally {
      relay.release();
    }
    const snapshot = await refreshed;
    // Host discovery is not part of the scenario; the sessions and notifications of the local daemon must read cleanly.
    expect(snapshot.errors.filter((error) => error.scope !== "discovery"), JSON.stringify(snapshot.errors)).toEqual([]);
    expect(snapshot.pendingNotifications).toEqual([]);
    expect(snapshot.notifications).toHaveLength(NOTIFICATION_COUNT);
    await announcer.announce(snapshot);
    expect(await Bun.file(calls).exists()).toBe(false);
  } finally {
    await logger.close();
  }
}, SCENARIO_TIMEOUT_MS);

test("a notification event applies its change without paging every notification again", async () => {
  daemon = await startCoreDaemon();
  creator = await connectLocal(join(daemon.runtimeDir, "pohunek", "daemon.sock"));
  for (let index = 0; index < NOTIFICATION_COUNT; index += 1) await createNotification(index);

  relay = startControlRelay(join(daemon.runtimeDir, "pohunek", "daemon.sock"), join(daemon.runtimeDir, "relay.sock"));
  control = clientFor(daemon, relay.socket);
  const initial = await control.refresh();
  expect(initial.notifications).toHaveLength(NOTIFICATION_COUNT);
  const listsBefore = relay.notificationListRequests();

  const client = control;
  const created = `notification ${String(NOTIFICATION_COUNT)}`;
  const arrived = nextSnapshot(client, (snapshot) => snapshot.notifications.some((record) => record.title === created),
    "the notification created after the first read");
  await createNotification(NOTIFICATION_COUNT);
  const updated = await arrived;
  expect(updated.notifications).toHaveLength(NOTIFICATION_COUNT + 1);
  expect(relay.notificationListRequests()).toBe(listsBefore);
}, SCENARIO_TIMEOUT_MS);

test("startup reads only the notifications that need the owner, and the activity list is read a page at a time", async () => {
  daemon = await startCoreDaemon();
  creator = await connectLocal(join(daemon.runtimeDir, "pohunek", "daemon.sock"));
  // Most of the host's notifications need no action, so a read of the attention list must not return them.
  for (let index = 0; index < ACTIVITY_COUNT; index += 1) {
    await creator.call("notification.create", {
      source: notificationSource(index), kind: "error", severity: "info", title: `quiet ${String(index)}`, body: "created by the scenario",
    });
  }
  for (let index = 0; index < ATTENTION_COUNT; index += 1) {
    await createNotification(ACTIVITY_COUNT + index);
  }

  relay = startControlRelay(join(daemon.runtimeDir, "pohunek", "daemon.sock"), join(daemon.runtimeDir, "relay.sock"));
  control = clientFor(daemon, relay.socket);
  const snapshot = await control.refresh();
  expect(snapshot.errors.filter((error) => error.scope !== "discovery"), JSON.stringify(snapshot.errors)).toEqual([]);
  expect(snapshot.notifications).toHaveLength(ATTENTION_COUNT);
  // Each attention query returns only the matching records: the action-required and the approval-required ones, once each.
  expect(relay.notificationRecordsReturned()).toBe(2 * ATTENTION_COUNT);
  expect(relay.notificationRecordsReturned()).toBeLessThan(ACTIVITY_COUNT);

  const before = relay.notificationRecordsReturned();
  const first = await control.activity("recent", null);
  expect(first.ok ? first.data.records.length : null).toBe(PAGE_SIZE);
  expect(first.ok ? first.data.cursor : null).not.toBeNull();
  expect(relay.notificationRecordsReturned() - before).toBe(PAGE_SIZE);

  const cursor = first.ok ? first.data.cursor : null;
  if (cursor === null) throw new Error("the first activity page did not return a cursor");
  const second = await control.activity("recent", cursor);
  expect(second.ok ? second.data.records.length : null).toBe(PAGE_SIZE);
  const firstIds = new Set(first.ok ? first.data.records.map((record) => record.id) : []);
  expect(second.ok ? second.data.records.some((record) => firstIds.has(record.id)) : true).toBe(false);
  expect(relay.notificationRecordsReturned() - before).toBe(2 * PAGE_SIZE);
}, SCENARIO_TIMEOUT_MS);
