// The activity list is globally newest first across hosts, and a session's notifications are read to the end. Both
// hosts are real pinned daemons: the second one is discovered as a reachable host and dialled through a TCP relay,
// the same way a remote host is reached. Only the `host discover` answer is supplied by a wrapper around the CLI.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLocal, type Client } from "@pohunek/sdk";
import { createControlClient, type ControlClient } from "../../src/control/index.ts";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, daemonLocalSocket, startCoreDaemon, type CoreDaemon } from "../helpers/core-daemon.ts";
import { startSocketRelay, type SocketRelay } from "../ink/support/socket-relay.ts";
import { startTcpRelay, type TcpRelay } from "../ink/support/tcp-relay.ts";

const SCENARIO_TIMEOUT_MS = 60_000;
const PAGE_SIZE = 10;
const REMOTE_RECORDS = 3;
const LOCAL_RECORDS = 25;
// Fewer local records than a page, so the page of the Activity list has to read the failing host to fill it.
const PARTIAL_LOCAL_RECORDS = 4;
const SESSION_RECORDS = 25;
const CREATED_BEFORE_MS = 20;
const HOLD_POLL_MS = 20;
const HOLD_WAIT_MS = 10_000;

const daemons: CoreDaemon[] = [];
let control: ControlClient | null = null;
let relay: TcpRelay | null = null;
let socketRelay: SocketRelay | null = null;
const roots: string[] = [];

afterEach(async () => {
  await control?.close();
  control = null;
  await relay?.stop();
  relay = null;
  await socketRelay?.stop();
  socketRelay = null;
  for (const daemon of daemons.splice(0)) await daemon.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

async function connect(daemon: CoreDaemon): Promise<Client> {
  return connectLocal(daemonLocalSocket(daemon));
}

async function createNotifications(client: Client, count: number, label: string, sessionId?: string): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await client.call("notification.create", {
      source: { provider: "activity-order-test", provider_event: `${label}-${String(index)}`, host_local_source_id: `${label}-${String(index)}` },
      kind: "error", severity: "info", title: `${label} ${String(index)}`, body: "created by the scenario",
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
    });
  }
}

/** A `pohunek` binary that answers `host discover` with the given hosts and runs every other command unchanged. */
async function discoveringCli(root: string, realBinary: string, hosts: readonly Record<string, unknown>[]): Promise<string> {
  const answer = join(root, "discover.json");
  await writeFile(answer, JSON.stringify({ cli_version: "0.34.2", protocol: { minimum: 4, maximum: 4 }, ok: hosts }));
  const wrapper = join(root, "pohunek");
  await writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "host" ] && [ "$2" = "discover" ]; then /bin/cat '${answer}'; exit 0; fi\nexec '${realBinary}' "$@"\n`);
  await chmod(wrapper, 0o755);
  return wrapper;
}

test("the first activity page is the newest records of every host, not the newest of each host", async () => {
  const local = await startCoreDaemon();
  const remote = await startCoreDaemon();
  daemons.push(local, remote);
  const root = await mkdtemp(join(tmpdir(), "activity-order-"));
  roots.push(root);

  const remoteClient = await connect(remote);
  await createNotifications(remoteClient, REMOTE_RECORDS, "remote");
  await remoteClient.close();
  // The local records are created after the remote ones, so every local record is newer than every remote one.
  await Bun.sleep(CREATED_BEFORE_MS);
  const localClient = await connect(local);
  await createNotifications(localClient, LOCAL_RECORDS, "local");
  await localClient.close();

  relay = startTcpRelay(daemonLocalSocket(remote));
  const binary = await discoveringCli(root, join(local.coreDir, "pohunek"), [{
    name: "remote-daemon", fqdn: "remote.example", address: "127.0.0.1", port: relay.port, overlay: "netbird", peer_id: "remote-peer",
    classification: "reachable_daemon", daemon_version: "0.34.2",
  }]);
  control = createControlClient({
    binary, timeoutMs: 10_000, notificationsPageSize: PAGE_SIZE, reconnectMaxMs: 1_000, localSocket: daemonLocalSocket(local), env: local.clientEnv,
  });
  const snapshot = await control.refresh();
  const remoteRoute = snapshot.hosts.find((host) => host.name === "remote-daemon")?.route;
  if (remoteRoute === undefined) throw new Error(`the remote host was not discovered: ${JSON.stringify(snapshot.errors)}`);

  const first = await control.activity("recent", null);
  if (!first.ok) throw new Error(first.error.message);
  // Ten local records fill the first page; a page that mixed in the remote host's older records would be longer.
  expect(first.data.records).toHaveLength(PAGE_SIZE);
  expect(first.data.records.every((record) => record.host === "local")).toBe(true);

  const second = await control.activity("recent", first.data.cursor);
  if (!second.ok) throw new Error(second.error.message);
  expect(second.data.records).toHaveLength(PAGE_SIZE);
  expect(second.data.records.every((record) => record.host === "local")).toBe(true);

  // The last page holds the local records that are left and then the remote records, in time order, and the list ends.
  const third = await control.activity("recent", second.data.cursor);
  if (!third.ok) throw new Error(third.error.message);
  expect(third.data.records.map((record) => record.host)).toEqual([
    ...Array.from({ length: LOCAL_RECORDS - 2 * PAGE_SIZE }, () => "local"),
    ...Array.from({ length: REMOTE_RECORDS }, () => remoteRoute),
  ]);
  expect(third.data.cursor).toBeNull();
}, SCENARIO_TIMEOUT_MS);

test("the notifications of a session are read to the end of the session", async () => {
  const daemon = await startCoreDaemon();
  daemons.push(daemon);
  const created = await daemon.pohunek(["session", "new", "--agent", "shell", "--cwd", daemon.root, "--name", "many-notes", "--json"]);
  const sessionId = (JSON.parse(created.stdout) as { ok?: { id?: string } }).ok?.id;
  if (sessionId === undefined) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  const client = await connect(daemon);
  await createNotifications(client, SESSION_RECORDS, "session", sessionId);
  await client.close();

  control = createControlClient({
    binary: join(daemon.coreDir, "pohunek"), timeoutMs: 10_000, notificationsPageSize: PAGE_SIZE, reconnectMaxMs: 1_000, localSocket: daemonLocalSocket(daemon), env: daemon.clientEnv,
  });
  const notes = await control.sessionNotifications("local", sessionId);
  if (!notes.ok) throw new Error(notes.error.message);
  expect(notes.data).toHaveLength(SESSION_RECORDS);
}, SCENARIO_TIMEOUT_MS);

test("a host that cannot be read leaves the other hosts' Activity in place, and is read again on the next load", async () => {
  const local = await startCoreDaemon();
  const remote = await startCoreDaemon();
  daemons.push(local, remote);
  const root = await mkdtemp(join(tmpdir(), "activity-partial-"));
  roots.push(root);

  const remoteClient = await connect(remote);
  await createNotifications(remoteClient, REMOTE_RECORDS, "remote");
  await remoteClient.close();
  const localClient = await connect(local);
  await createNotifications(localClient, PARTIAL_LOCAL_RECORDS, "local");
  await localClient.close();

  relay = startTcpRelay(daemonLocalSocket(remote));
  const binary = await discoveringCli(root, join(local.coreDir, "pohunek"), [{
    name: "remote-daemon", fqdn: "remote.example", address: "127.0.0.1", port: relay.port, overlay: "netbird", peer_id: "remote-peer",
    classification: "reachable_daemon", daemon_version: "0.34.2",
  }]);
  control = createControlClient({
    binary, timeoutMs: 10_000, notificationsPageSize: PAGE_SIZE, reconnectMaxMs: 1_000, localSocket: daemonLocalSocket(local), env: local.clientEnv,
  });
  const snapshot = await control.refresh();
  const remoteRoute = snapshot.hosts.find((host) => host.name === "remote-daemon")?.route;
  if (remoteRoute === undefined) throw new Error(`the remote host was not discovered: ${JSON.stringify(snapshot.errors)}`);

  // The relay refuses the remote host from here on, so its page fails while the local host's page is read.
  relay.setFailing(true);
  const partial = await control.activity("recent", null);
  if (!partial.ok) throw new Error(partial.error.message);
  expect(partial.data.records.map((record) => record.host)).toEqual(Array.from({ length: PARTIAL_LOCAL_RECORDS }, () => "local"));
  expect(partial.data.errors.map((item) => item.host)).toEqual([remoteRoute]);
  // The remote host keeps its place in the cursor, so the next load reads it again.
  expect(partial.data.cursor).not.toBeNull();

  // The link to the host reconnects after its back-off, so the next load is read again until the host answers.
  relay.setFailing(false);
  let cursor = partial.data.cursor;
  let retried = await control.activity("recent", cursor);
  const deadline = Date.now() + HOLD_WAIT_MS;
  while (retried.ok && retried.data.errors.length > 0 && Date.now() < deadline) {
    await Bun.sleep(HOLD_POLL_MS);
    cursor = retried.data.cursor ?? cursor;
    retried = await control.activity("recent", cursor);
  }
  if (!retried.ok) throw new Error(retried.error.message);
  expect(retried.data.errors).toEqual([]);
  expect(retried.data.records.map((record) => record.host)).toEqual(Array.from({ length: REMOTE_RECORDS }, () => remoteRoute));
  expect(retried.data.cursor).toBeNull();
}, SCENARIO_TIMEOUT_MS);

test("an archive that arrives while a session's notes are read between pages is not overwritten by the older read", async () => {
  const daemon = await startCoreDaemon();
  daemons.push(daemon);
  const root = await mkdtemp(join(tmpdir(), "session-notes-race-"));
  roots.push(root);
  const created = await daemon.pohunek(["session", "new", "--agent", "shell", "--cwd", daemon.root, "--name", "notes-race", "--json"]);
  const sessionId = (JSON.parse(created.stdout) as { ok?: { id?: string } }).ok?.id;
  if (sessionId === undefined) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  const client = await connect(daemon);
  await createNotifications(client, SESSION_RECORDS, "race", sessionId);

  // The newest record is on the first page of the read, so an archive of it lands after that page was read.
  const newest = await client.call("notification.list", { session_id: sessionId, limit: 1 }) as { notifications: { id: string }[] };
  const newestId = newest.notifications[0]?.id;
  if (newestId === undefined) throw new Error("the session has no notification");

  // The second page of the read is held at the relay until the flag is removed.
  const flag = join(root, "hold-cursor");
  await writeFile(flag, "");
  socketRelay = await startSocketRelay(daemonLocalSocket(daemon), { holdMs: 0, skipCount: 0, holdCount: 0, refuseHealthAfterHold: false, holdCursorFlag: flag });
  control = createControlClient({
    binary: join(daemon.coreDir, "pohunek"), timeoutMs: 10_000, notificationsPageSize: PAGE_SIZE, reconnectMaxMs: 1_000, localSocket: socketRelay.socket, env: daemon.clientEnv,
  });
  const archived = new Promise<void>((resolve) => {
    const unsubscribe = control?.subscribeNotifications((change) => {
      if (change.id !== newestId || change.record?.status !== "archived") return;
      unsubscribe?.();
      resolve();
    });
  });
  const reading = control.sessionNotifications("local", sessionId);
  await waitForFile(`${flag}.held`);

  await client.call("notification.update", { id: newestId, status: "archived" });
  await client.close();
  await archived;
  await rm(flag);

  const notes = await reading;
  if (!notes.ok) throw new Error(notes.error.message);
  expect(notes.data).toHaveLength(SESSION_RECORDS);
  expect(notes.data.find((record) => record.id === newestId)?.status).toBe("archived");
}, SCENARIO_TIMEOUT_MS);

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + HOLD_WAIT_MS;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() > deadline) throw new Error(`${path} was not written within ${String(HOLD_WAIT_MS)} ms`);
    await Bun.sleep(HOLD_POLL_MS);
  }
}
