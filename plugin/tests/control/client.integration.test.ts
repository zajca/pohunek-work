import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlClient, type ControlClient, type ControlSnapshot } from "../../src/control/index.ts";
import { startSdkStandIn, type SdkFault, type SdkStandIn } from "../helpers/sdk-stand-in.ts";

// Session mutations go through the daemon socket, so these tests run the socket stand-in relaying the CLI stub.
let standIn: SdkStandIn | null = null;
afterEach(async () => { await standIn?.stop(); standIn = null; });

interface Rule { readonly args: readonly string[]; readonly ok?: unknown; readonly err?: unknown; readonly stdout?: string; readonly exit?: number; readonly delayMs?: number }
const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function cli(rules: readonly Rule[]): Promise<{ binary: string; calls: () => Promise<readonly string[][]> }> {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-control-"));
  tempDirs.push(directory);
  const rulesPath = join(directory, "rules.json");
  const logPath = join(directory, "calls.jsonl");
  const binary = join(directory, "pohunek");
  await writeFile(rulesPath, JSON.stringify(rules));
  await writeFile(binary, `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const rules = JSON.parse(readFileSync(${JSON.stringify(rulesPath)}, "utf8"));
const rule = rules.find((entry) => JSON.stringify(entry.args) === JSON.stringify(args));
if (!rule) { process.stderr.write("unexpected argv: " + JSON.stringify(args)); process.exit(70); }
if (rule.delayMs) await Bun.sleep(rule.delayMs);
process.stdout.write(rule.stdout ?? JSON.stringify({cli_version:"0.33.1",protocol:{minimum:4,maximum:4},...(rule.err ? {err:rule.err} : {ok:rule.ok})}));
process.exit(rule.exit ?? (rule.err ? 1 : 0));
`);
  await chmod(binary, 0o755);
  return { binary, calls: async () => {
    try { return (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]); }
    catch { return []; }
  } };
}

const session = {
  id: "s1", name: "Fix test", agent: "claude", cwd: "/repo", state: "running", activity: "working",
  updated_at: "2026-10-09T10:00:00Z", project_id: "p1", project_label: "repo", branch: "fix",
  worktree_path: "/repo/fix", capabilities: { resume: true, fork: true },
  metadata: { "work.url": "https://example.test/issue/1" },
  subagents: [{ id: "sub1", provider: "claude", lifecycle: "running", revision: 1,
    started_at_ms: 1, updated_at_ms: 2 }],
};
const project = { id: "p1", label: "repo", repo_root: "/repo", git_common_dir: "/repo/.git" };
const notification = { id: "n1", kind: "approval_required", severity: "action_required", status: "unread", title: "Ready",
  body: "Review needed", created_at: "2026-10-09T10:00:00Z", session_id: "s1", project_id: "p1" };

describe("control CLI process boundary", () => {
  test("reads session, screen, project and host details through JSON CLI calls", async () => {
    const stub = await cli([
      { args: ["--host", "local", "session", "inspect", "s1", "--json"], ok: session },
      { args: ["--host", "local", "session", "screen", "s1", "--json"], ok: { session_id: "s1", visible_lines: ["hello"] } },
      { args: ["--host", "local", "project", "show", "p1", "--json"], ok: { project, worktrees: [{ path: "/repo/fix", branch: "fix", head: "abc", session_id: "s1" }] } },
      { args: ["host", "inspect", "local", "--json"], ok: { daemon_version: "0.33.1", protocol_version: 4, supported_agents: ["claude"],
        git_available: true, worktree_supported: true, terminal_read_supported: true, output_read_supported: true } },
      { args: ["host", "governance", "inspect", "local", "--json"], ok: {
        host_id: "host_opaque", enrollment: null, owner: null, owner_revision: null,
        quarantine: null, approval_key_reference: "approval_key_opaque",
      } },
    ]);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: null });
    expect((await client.inspectSession("local", "s1")).ok).toBe(true);
    expect((await client.screen("local", "s1")).ok).toBe(true);
    expect((await client.showProject("local", "p1")).ok).toBe(true);
    expect((await client.inspectHost("local")).ok).toBe(true);
    expect((await client.inspectGovernance("local")).ok).toBe(true);
  });

  test("executes notification mutations through the daemon socket without cleanup acceptance", async () => {
    const rules: Rule[] = [
      ...(["read", "ack", "archive"] as const).map(kind => ({ args: ["--host", "local", "notifications", kind, "n1", "--json"], ok: { record: notification } })),
    ];
    const stub = await cli(rules);
    standIn = await startSdkStandIn(stub.binary);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket });
    for (const kind of ["read", "ack", "archive"] as const) {
      expect((await client.act({ kind, host: "local", notificationId: "n1" })).ok).toBe(true);
    }
    expect((await stub.calls()).flat().includes("--accept-unconfirmed-cleanup")).toBe(false);
  });

  test("forks a session through the daemon socket and returns the forked session", async () => {
    const forked = { ...session, id: "s2", name: "Fork" };
    const stub = await cli([{ args: ["--host", "local", "session", "fork", "s1", "--json"], ok: forked }]);
    standIn = await startSdkStandIn(stub.binary);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket });
    const result = await client.act({ kind: "fork", host: "local", sessionId: "s1", cols: 100, rows: 30 });
    expect(result.ok ? result.data.kind : null).toBe("fork");
    expect(result.ok && result.data.kind === "fork" ? result.data.session.id : null).toBe("s2");
  });

  test("classifies CLI errors, protocol mismatch and malformed payloads", async () => {
    const stub = await cli([
      { args: ["--host", "local", "session", "inspect", "timeout", "--json"], err: { class: "timeout", code: "request_timeout", msg: "late" } },
      { args: ["--host", "local", "session", "inspect", "mismatch", "--json"], stdout: JSON.stringify({ cli_version: "future", protocol: { minimum: 5, maximum: 6 }, ok: session }) },
      { args: ["--host", "local", "session", "inspect", "broken", "--json"], ok: { ...session, state: 42 } },
    ]);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: null });
    const timeout = await client.inspectSession("local", "timeout");
    const mismatch = await client.inspectSession("local", "mismatch");
    const broken = await client.inspectSession("local", "broken");
    expect(timeout.ok ? null : timeout.error.code).toBe("timeout");
    expect(mismatch.ok ? null : mismatch.error.code).toBe("protocol_mismatch");
    expect(broken.ok ? null : broken.error.code).toBe("invalid_response");
  });

  test("reports the verified native recovery target and refuses an ambiguous one from the core", async () => {
    const stub = await cli([
      { args: ["--host", "local", "session", "inspect", "verified", "--json"], ok: { ...session, id: "verified", native_session_id: "native-1", native_last_activity_at: "2026-10-09T09:00:00Z" } },
      { args: ["--host", "local", "session", "inspect", "ambiguous", "--json"], ok: { ...session, id: "ambiguous", native_session_id: "native-1", native_session_path: "/conversation.jsonl" } },
      { args: ["--host", "local", "session", "inspect", "unknown", "--json"], ok: { ...session, id: "unknown", native_session_id: null, native_session_path: null, native_last_activity_at: null } },
      { args: ["--host", "local", "session", "resume", "ambiguous", "--json"], err: { class: "runtime", code: "recovery_target_ambiguous", msg: "two native references" } },
    ]);
    standIn = await startSdkStandIn(stub.binary);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket });
    const verified = await client.inspectSession("local", "verified");
    expect(verified.ok ? verified.data.nativeTarget : null).toEqual({ status: "verified", kind: "id", value: "native-1" });
    expect(verified.ok ? verified.data.nativeLastActivityAt : null).toBe("2026-10-09T09:00:00Z");
    const ambiguous = await client.inspectSession("local", "ambiguous");
    expect(ambiguous.ok ? ambiguous.data.nativeTarget.status : null).toBe("invalid");
    const unknown = await client.inspectSession("local", "unknown");
    expect(unknown.ok ? unknown.data.nativeTarget : null).toEqual({ status: "none" });
    expect(unknown.ok ? unknown.data.nativeLastActivityAt : "set").toBeNull();
    const refused = await client.act({ kind: "resume", host: "local", sessionId: "ambiguous" });
    expect(refused.ok ? null : refused.error.cliCode).toBe("recovery_target_ambiguous");
  });

  test("rejects a host-qualified target before it can override the selected host", async () => {
    const stub = await cli([]);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: null });
    const action = await client.act({ kind: "remove", host: "local", sessionId: "remote/s1" });
    const detail = await client.inspectSession("local", "remote/s1");
    expect(action.ok ? null : action.error.code).toBe("command_failed");
    expect(detail.ok ? null : detail.error.code).toBe("command_failed");
    const undialable = await client.inspectHost("undialable:record");
    expect(undialable.ok ? null : undialable.error.code).toBe("unavailable");
    expect(await stub.calls()).toEqual([]);
  });

  test("does not retry a timed-out removal whose outcome is unknown", async () => {
    const args = ["--host", "local", "session", "rm", "s1", "--json"];
    const inspect = ["--host", "local", "session", "inspect", "s1", "--json"];
    const stub = await cli([
      { args: inspect, ok: { ...session, state: "exited" } },
      { args, ok: { removed: true, stopped: true, worktrees_removed: 0, worktrees_failed: 0 }, delayMs: 3_000 },
    ]);
    standIn = await startSdkStandIn(stub.binary);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 1_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket });
    const result = await client.act({ kind: "remove", host: "local", sessionId: "s1" });
    expect(result.ok ? null : result.error.code).toBe("outcome_unknown");
    expect((await stub.calls()).filter((call) => call.includes("rm"))).toEqual([args]);
  });

  // The stand-in makes the reply faults: a real daemon cannot produce a connection that a stalled or corrupted
  // reply has left unusable, so the link's recovery from such a reply is only reachable through the socket stand-in.
  describe("a reply fault leaves the link usable for the calls after it", () => {
    const RECOVERY_WAIT_MS = 10_000;
    const sessionsFailed = (snapshot: ControlSnapshot): boolean =>
      snapshot.errors.some((error) => error.host === "local" && error.scope === "sessions");

    /** Refreshes until the sessions read succeeds again; the link waits out its reconnect backoff in between. */
    async function refreshUntilHealthy(client: ControlClient): Promise<ControlSnapshot> {
      const deadline = Date.now() + RECOVERY_WAIT_MS;
      for (;;) {
        const snapshot = await client.refresh();
        if (!sessionsFailed(snapshot) || Date.now() > deadline) return snapshot;
        await Bun.sleep(100);
      }
    }

    async function faultedClient(fault: SdkFault["kind"]): Promise<{ client: ControlClient }> {
      const stub = await cli([
        { args: ["host", "discover", "--json"], ok: [] },
        { args: ["--host", "local", "session", "list", "--json"], ok: [session] },
        { args: ["--host", "local", "project", "list", "--json"], ok: [project] },
      ]);
      standIn = await startSdkStandIn(stub.binary, { faults: [{ method: "session.list", kind: fault, times: 1 }] });
      const client = createControlClient({ binary: stub.binary, timeoutMs: 1_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket });
      return { client };
    }

    test("a stalled reply", async () => {
      const { client } = await faultedClient("stall");
      expect(sessionsFailed(await client.refresh())).toBe(true);
      const recovered = await refreshUntilHealthy(client);
      expect(sessionsFailed(recovered)).toBe(false);
      expect(recovered.sessions.map((item) => item.id)).toEqual([session.id]);
      await client.close();
    });

    test("a corrupted reply", async () => {
      const { client } = await faultedClient("corrupt");
      expect(sessionsFailed(await client.refresh())).toBe(true);
      const recovered = await refreshUntilHealthy(client);
      expect(sessionsFailed(recovered)).toBe(false);
      expect(recovered.sessions.map((item) => item.id)).toEqual([session.id]);
      await client.close();
    });
  });

  // A client inheriting one half of the origin pair must not send a stop over the SDK without the origin: the
  // daemon could then not refuse a stop of the session that hosts the TUI.
  test("a half-set origin pair refuses a stop on the socket instead of sending it without the origin", async () => {
    const stub = await cli([
      { args: ["host", "discover", "--json"], ok: [] },
      { args: ["--host", "local", "session", "list", "--json"], ok: [session] },
      { args: ["--host", "local", "project", "list", "--json"], ok: [project] },
      { args: ["--host", "local", "session", "stop", session.id, "--json"], ok: { stopped: true } },
    ]);
    standIn = await startSdkStandIn(stub.binary);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket, env: { POHUNEK_SESSION_ID: "half" } });
    const outcome = await client.act({ kind: "stop", host: "local", sessionId: session.id });
    expect(outcome.ok).toBe(false);
    expect((await stub.calls()).some((call) => call.includes("stop"))).toBe(false);
    await client.close();
  });

  // A removal that fails after the stop succeeded must say both facts: the session is stopped and not removed.
  test("a failed removal after a stop reports that the session is stopped but not removed", async () => {
    const stub = await cli([
      { args: ["--host", "local", "session", "inspect", session.id, "--json"], ok: session },
      { args: ["--host", "local", "session", "stop", session.id, "--json"], ok: { stopped: true } },
      { args: ["--host", "local", "session", "rm", session.id, "--json"], err: { class: "runtime", code: "worktree_dirty", msg: "uncommitted changes" } },
    ]);
    standIn = await startSdkStandIn(stub.binary);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket });
    const outcome = await client.act({ kind: "remove", host: "local", sessionId: session.id });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? "" : outcome.error.message).toContain("session stopped but not removed");
    expect((await stub.calls()).some((call) => call.includes("stop"))).toBe(true);
    await client.close();
  });

  // A removal whose reply is lost after the stop succeeded may have removed the session: it is not reported as refused.
  test("a removal lost after a stop is reported as an unknown outcome", async () => {
    const stub = await cli([
      { args: ["--host", "local", "session", "inspect", session.id, "--json"], ok: session },
      { args: ["--host", "local", "session", "stop", session.id, "--json"], ok: { stopped: true } },
      { args: ["--host", "local", "session", "rm", session.id, "--json"], ok: { removed: true, stopped: true, worktrees_removed: 0, worktrees_failed: 0 } },
    ]);
    standIn = await startSdkStandIn(stub.binary, { faults: [{ method: "session.remove", kind: "stall", times: 1 }] });
    const client = createControlClient({ binary: stub.binary, timeoutMs: 1_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket });
    const outcome = await client.act({ kind: "remove", host: "local", sessionId: session.id });
    expect(outcome.ok ? "" : outcome.error.code).toBe("outcome_unknown");
    expect(outcome.ok ? "" : outcome.error.message).toContain("session stopped; removal outcome is unknown");
    await client.close();
  }, 15_000);

  // A fork whose reply does not come back has an unknown outcome: the fork may exist, so it is not reported as failed.
  test("a fork that does not answer in time reports an unknown outcome", async () => {
    const stub = await cli([{ args: ["host", "discover", "--json"], ok: [] }]);
    standIn = await startSdkStandIn(stub.binary, { faults: [{ method: "session.fork", kind: "stall", times: 1 }] });
    const client = createControlClient({ binary: stub.binary, timeoutMs: 1_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket });
    const outcome = await client.act({ kind: "fork", host: "local", sessionId: session.id, cols: 80, rows: 24 });
    expect(outcome.ok ? "" : outcome.error.code).toBe("outcome_unknown");
    expect(outcome.ok ? "" : outcome.error.message).toContain("fork outcome is unknown");
    await client.close();
  }, 15_000);

  // Calls on one link run one at a time. A mutation queued behind a read that stalls must not run after the link
  // has entered its outage: the stand-in never answers the read, the read times out, and the mutation is refused.
  test("a mutation queued behind a stalled read is refused, not sent, once the link reconnects", async () => {
    const stub = await cli([
      { args: ["host", "discover", "--json"], ok: [] },
      { args: ["--host", "local", "session", "list", "--json"], ok: [session] },
      { args: ["--host", "local", "project", "list", "--json"], ok: [project] },
      { args: ["--host", "local", "session", "stop", session.id, "--json"], ok: { stopped: true } },
    ]);
    standIn = await startSdkStandIn(stub.binary, { faults: [{ method: "session.list", kind: "stall", times: 1 }] });
    const client = createControlClient({ binary: stub.binary, timeoutMs: 1_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: standIn.socket });
    const listing = client.refresh();
    // Host discovery runs before the session read, so the mutation is asked for once that read is in flight.
    await Bun.sleep(300);
    const stopped = client.act({ kind: "stop", host: "local", sessionId: session.id });
    await listing;
    const outcome = await stopped;
    expect(outcome.ok).toBe(false);
    expect((await stub.calls()).some((call) => call.includes("stop"))).toBe(false);
    await client.close();
  }, 15_000);

  // A refresh still waiting on host discovery must not reach the daemon socket once the client is closed.
  test("close during a pending refresh opens no daemon connection afterwards", async () => {
    const stub = await cli([{ args: ["host", "discover", "--json"], ok: [], delayMs: 1_000 }]);
    const directory = await mkdtemp(join(tmpdir(), "pohunek-control-socket-"));
    tempDirs.push(directory);
    const socketPath = join(directory, "daemon.sock");
    let connections = 0;
    const listener = Bun.listen({ unix: socketPath, socket: { open() { connections += 1; }, data() {}, close() {}, error() {} } });
    try {
      const client = createControlClient({ binary: stub.binary, timeoutMs: 5_000, notificationsPageSize: 2, reconnectMaxMs: 1_000, localSocket: socketPath });
      const pending = client.refresh();
      await Bun.sleep(200);
      await client.close();
      await pending;
      expect(connections).toBe(0);
    } finally {
      listener.stop(true);
    }
  });
});
