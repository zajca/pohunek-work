// The control client reads sessions and notifications of the local daemon through the SDK of the
// pinned release and follows its event stream: a session created by another process reaches the
// snapshot without a CLI reconcile. Every daemon here is the real pinned release.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createControlClient, type ControlClient, type ControlSnapshot } from "../../src/control/index.ts";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, startCoreDaemon, type CoreDaemon } from "../helpers/core-daemon.ts";

const SCENARIO_TIMEOUT_MS = 60_000;
const EVENT_WAIT_MS = 10_000;
let daemon: CoreDaemon | null = null;
let control: ControlClient | null = null;

afterEach(async () => {
  await control?.close();
  control = null;
  await daemon?.stop();
  daemon = null;
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

/** The client runs the release CLI in the daemon's environment, so no other daemon's hosts are listed. */
function clientFor(fixture: CoreDaemon, localSocket: string | null): ControlClient {
  return createControlClient({
    binary: join(fixture.coreDir, "pohunek"), timeoutMs: 10_000, notificationsPageSize: 25, reconnectMaxMs: 1_000, localSocket, env: fixture.clientEnv,
  });
}

test("the snapshot lists the daemon's sessions and a new session arrives through the event stream", async () => {
  daemon = await startCoreDaemon();
  const created = await daemon.pohunek(["session", "new", "--agent", "shell", "--cwd", daemon.root, "--name", "before-refresh", "--json"]);
  const firstId = (JSON.parse(created.stdout) as { ok?: { id?: string } }).ok?.id;
  if (firstId === undefined) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  control = clientFor(daemon, join(daemon.runtimeDir, "pohunek", "daemon.sock"));
  const first = await control.refresh();
  expect(first.sessions.map((session) => session.id), JSON.stringify(first.errors)).toEqual([firstId]);
  expect(first.errors.filter((error) => error.scope === "sessions")).toEqual([]);

  const client = control;
  const arrived = new Promise<ControlSnapshot>((resolve) => {
    const unsubscribe = client.subscribe((snapshot) => {
      if (snapshot.sessions.some((session) => session.name === "after-subscribe")) {
        unsubscribe();
        resolve(snapshot);
      }
    });
  });
  const second = await daemon.pohunek(["session", "new", "--agent", "shell", "--cwd", daemon.root, "--name", "after-subscribe", "--json"]);
  expect(second.exitCode, second.stderr).toBe(0);
  const snapshot = await Promise.race([
    arrived,
    Bun.sleep(EVENT_WAIT_MS).then(() => { throw new Error(`the new session did not reach the snapshot within ${String(EVENT_WAIT_MS)} ms`); }),
  ]);
  expect(snapshot.sessions.map((session) => session.name)).toContain("after-subscribe");
}, SCENARIO_TIMEOUT_MS);

test("a daemon that cannot be reached is an error of its sessions, never an empty list", async () => {
  daemon = await startCoreDaemon();
  control = clientFor(daemon, null);
  const snapshot = await control.refresh();
  expect(snapshot.sessions).toEqual([]);
  const sessions = snapshot.errors.find((error) => error.host === "local" && error.scope === "sessions");
  expect(sessions?.error.message).toContain("cannot be resolved");
}, SCENARIO_TIMEOUT_MS);

test("session mutations run through the SDK on the real daemon", async () => {
  daemon = await startCoreDaemon();
  const created = await daemon.pohunek(["session", "new", "--agent", "shell", "--cwd", daemon.root, "--name", "to-mutate", "--json"]);
  const id = (JSON.parse(created.stdout) as { ok?: { id?: string } }).ok?.id;
  if (id === undefined) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  control = clientFor(daemon, join(daemon.runtimeDir, "pohunek", "daemon.sock"));

  const renamed = await control.act({ kind: "rename", host: "local", sessionId: id, name: "renamed-by-sdk" });
  expect(renamed.ok ? renamed.data : null).toMatchObject({ kind: "rename", session: { id, name: "renamed-by-sdk" } });

  const tagged = await control.act({ kind: "metadata", host: "local", sessionId: id, set: { "work.url": "https://github.com/zajca/pohunek/issues/1" } });
  expect(tagged.ok ? tagged.data : null).toMatchObject({ kind: "metadata", session: { id } });

  const stopped = await control.act({ kind: "stop", host: "local", sessionId: id });
  expect(stopped.ok ? stopped.data : null).toEqual({ kind: "stop", stopped: true });

  const removed = await control.act({ kind: "remove", host: "local", sessionId: id });
  expect(removed.ok ? removed.data : null).toMatchObject({ kind: "remove", removed: true });
  const listed = await daemon.pohunek(["session", "list", "--json"]);
  expect(listed.stdout).not.toContain(id);
}, SCENARIO_TIMEOUT_MS);
