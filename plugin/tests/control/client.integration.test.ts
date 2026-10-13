import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlClient } from "../../src/control/index.ts";
import { startSdkStandIn, type SdkStandIn } from "../helpers/sdk-stand-in.ts";

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
      { args: ["--host", "local", "session", "resume", "ambiguous", "--json"], err: { class: "invalid_state", code: "recovery_target_ambiguous", msg: "two native references" } },
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
    expect(result.ok ? null : result.error.code).toBe("timeout");
    expect((await stub.calls()).filter((call) => call.includes("rm"))).toEqual([args]);
  });
});
