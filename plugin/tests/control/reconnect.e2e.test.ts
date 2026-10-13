// The control client keeps the session list through a daemon outage: when the event stream drops, the snapshot
// reports the sessions scope as unavailable with the last sessions kept, commands fail at once, and the list is
// reconciled after the daemon is started again without any explicit read. The outage is a real stop of the
// pinned daemon process; the restart reuses its root, so the same state and socket come back.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createControlClient, type ControlClient, type ControlSnapshot } from "../../src/control/index.ts";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, daemonLocalSocket, startCoreDaemon, type CoreDaemon } from "../helpers/core-daemon.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const SNAPSHOT_WAIT_MS = 30_000;
/** Backoff cap of the test client: the retries find the restarted daemon well within the snapshot wait. */
const RECONNECT_MAX_MS = 1_000;
/** The message the link reports while its event stream is down; the outage snapshot must carry it. */
const OUTAGE_MESSAGE = "reconnecting to the daemon";

let daemon: CoreDaemon | null = null;
let control: ControlClient | null = null;

afterEach(async () => {
  await control?.close();
  control = null;
  await daemon?.stop();
  daemon = null;
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

/** Resolves with the next snapshot that `ready` accepts; rejects when none arrives within the wait. */
function nextSnapshot(client: ControlClient, label: string, ready: (snapshot: ControlSnapshot) => boolean): Promise<ControlSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no snapshot ${label} within ${String(SNAPSHOT_WAIT_MS)} ms`));
    }, SNAPSHOT_WAIT_MS);
    const unsubscribe = client.subscribe((snapshot) => {
      if (!ready(snapshot)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(snapshot);
    });
  });
}

const sessionsOutage = (snapshot: ControlSnapshot): boolean =>
  snapshot.errors.some((error) => error.host === "local" && error.scope === "sessions" && error.error.message === OUTAGE_MESSAGE);
const sessionsHealthy = (snapshot: ControlSnapshot): boolean =>
  !snapshot.errors.some((error) => error.host === "local" && error.scope === "sessions");

test("the session list is kept during a daemon outage and reconciled after the restart", async () => {
  daemon = await startCoreDaemon();
  const created = await daemon.pohunek(["session", "new", "--agent", "shell", "--cwd", daemon.root, "--name", "kept-through-outage", "--json"]);
  const id = (JSON.parse(created.stdout) as { ok?: { id?: string } }).ok?.id;
  if (id === undefined) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);

  const client = createControlClient({
    binary: join(daemon.coreDir, "pohunek"),
    timeoutMs: 10_000,
    notificationsPageSize: 25,
    localSocket: daemonLocalSocket(daemon),
    env: daemon.clientEnv,
    reconnectMaxMs: RECONNECT_MAX_MS,
  });
  control = client;
  const first = await client.refresh();
  expect(first.sessions.map((session) => session.id), JSON.stringify(first.errors)).toEqual([id]);

  const outage = nextSnapshot(client, "reporting the outage", sessionsOutage);
  await daemon.interrupt();
  const during = await outage;
  expect(during.sessions.map((session) => session.id)).toEqual([id]);
  const unavailable = during.errors.find((error) => error.host === "local" && error.scope === "sessions");
  expect(unavailable?.error.code).toBe("unavailable");

  const refused = await client.act({ kind: "rename", host: "local", sessionId: id, name: "during-outage" });
  expect(refused.ok ? null : refused.error.code).toBe("unavailable");

  const recovered = nextSnapshot(client, "after the restart", (snapshot) => sessionsHealthy(snapshot) && snapshot.sessions.some((session) => session.id === id));
  await daemon.restart();
  const after = await recovered;
  expect(after.sessions.map((session) => session.id)).toEqual([id]);
}, SCENARIO_TIMEOUT_MS);
