import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlClient } from "../../src/control/index.ts";
import { sessionGroup } from "../../src/ink/views.tsx";

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
  test("discovers canonical routes and merges per-host sessions, projects, and paged notifications", async () => {
    const route = `netbird:peer~${Buffer.from("peer-a").toString("base64url")}@18722`;
    const hosts = [{ name: "peer-a", fqdn: "peer-a.netbird.cloud", address: "100.92.0.1", port: 18722,
      overlay: "netbird", peer_id: "peer-a", classification: "reachable_daemon", daemon_version: "0.33.1" },
    { name: "offline", fqdn: "offline.netbird.cloud", address: null, port: 18722,
      overlay: "netbird", peer_id: null, classification: "unreachable" },
    { name: "candidate", fqdn: null, address: null, port: 18722,
      overlay: "netbird", peer_id: null, classification: "candidate" }];
    const rules: Rule[] = [{ args: ["host", "discover", "--json"], ok: hosts }];
    for (const host of ["local", route]) {
      rules.push({ args: ["--host", host, "session", "list", "--json"], ok: [{ ...session, id: host === "local" ? "s1" : "s2" }] });
      rules.push({ args: ["--host", host, "project", "list", "--json"], ok: [project] });
      rules.push({ args: ["--host", host, "notifications", "list", "--limit", "2", "--status", "unread", "--json"],
        ok: { notifications: [notification], next_cursor: "next" } });
      rules.push({ args: ["--host", host, "notifications", "list", "--limit", "2", "--status", "unread", "--cursor", "next", "--json"],
        ok: { notifications: [], next_cursor: null } });
      rules.push({ args: ["--host", host, "notifications", "list", "--limit", "2", "--status", "read", "--json"],
        ok: { notifications: [], next_cursor: null } });
      rules.push({ args: ["--host", host, "notifications", "list", "--limit", "2", "--status", "acknowledged", "--json"],
        ok: { notifications: [{ ...notification, id: "n-ack", status: "acknowledged" }], next_cursor: null } });
      rules.push({ args: ["--host", host, "notifications", "list", "--limit", "2", "--status", "archived", "--json"],
        ok: { notifications: [{ ...notification, id: "n-archived", status: "archived" }], next_cursor: null } });
    }
    const stub = await cli(rules);
    const snapshot = await createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2 }).refresh();
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.hosts.map(host => host.route)).toEqual(["local", route,
      `netbird:fqdn~${Buffer.from("offline.netbird.cloud").toString("base64url")}@18722`,
      `undialable:${Buffer.from("netbird:candidate::18722").toString("base64url")}`]);
    expect(snapshot.hosts.map(host => host.dialable)).toEqual([true, true, true, false]);
    expect(snapshot.sessions.map(item => `${item.host}/${item.id}`)).toEqual(["local/s1", `${route}/s2`]);
    expect(snapshot.sessions[0]?.metadata["work.url"]).toBe("https://example.test/issue/1");
    expect(snapshot.sessions[0]?.subagents[0]?.id).toBe("sub1");
    expect(snapshot.projects).toHaveLength(2);
    expect(snapshot.notifications).toHaveLength(6);
    expect(snapshot.notifications.filter((entry) => entry.status === "archived")).toHaveLength(2);
    const firstSession = snapshot.sessions[0];
    if (firstSession === undefined) throw new Error("expected a local session");
    expect(sessionGroup(firstSession, snapshot.notifications)).toBe("Needs you");
    expect((await stub.calls()).every(args => args.includes("--json"))).toBe(true);
  });

  test("returns partial local data when discovery or a remote host fails", async () => {
    const rules: Rule[] = [
      { args: ["host", "discover", "--json"], err: { class: "unavailable", code: "netbird_unavailable", msg: "offline" } },
      { args: ["--host", "local", "session", "list", "--json"], ok: [session] },
      { args: ["--host", "local", "project", "list", "--json"], ok: [project] },
      { args: ["--host", "local", "notifications", "list", "--limit", "2", "--status", "unread", "--json"], ok: { notifications: [], next_cursor: null } },
      { args: ["--host", "local", "notifications", "list", "--limit", "2", "--status", "read", "--json"], ok: { notifications: [], next_cursor: null } },
      { args: ["--host", "local", "notifications", "list", "--limit", "2", "--status", "acknowledged", "--json"], ok: { notifications: [], next_cursor: null } },
      { args: ["--host", "local", "notifications", "list", "--limit", "2", "--status", "archived", "--json"], ok: { notifications: [], next_cursor: null } },
    ];
    const stub = await cli(rules);
    const snapshot = await createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2 }).refresh();
    expect(snapshot.hosts.map(host => host.route)).toEqual(["local"]);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.errors).toEqual([{ host: "local", scope: "discovery", error: {
      code: "command_failed", message: "pohunek error netbird_unavailable", cliCode: "netbird_unavailable", cliClass: "unavailable",
    } }]);
  });

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
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2 });
    expect((await client.inspectSession("local", "s1")).ok).toBe(true);
    expect((await client.screen("local", "s1")).ok).toBe(true);
    expect((await client.showProject("local", "p1")).ok).toBe(true);
    expect((await client.inspectHost("local")).ok).toBe(true);
    expect((await client.inspectGovernance("local")).ok).toBe(true);
  });

  test("executes safe lifecycle and notification mutations without cleanup acceptance", async () => {
    const rules: Rule[] = [
      { args: ["--host", "local", "session", "stop", "s1", "--json"], ok: { stopped: true } },
      { args: ["--host", "local", "session", "rm", "s1", "--json"], ok: { removed: true, stopped: false, worktrees_removed: 1, worktrees_failed: 0 } },
      { args: ["--host", "local", "session", "resume", "s1", "--json"], ok: { session } },
      { args: ["--host", "local", "session", "rename", "s1", "--json", "--", "-new"], ok: { session } },
      { args: ["--host", "local", "session", "rename", "s1", "--clear", "--json"], ok: { session } },
      { args: ["--host", "local", "session", "fork", "s1", "--name=fork", "--json"], ok: session },
      { args: ["--host", "local", "session", "metadata", "s1", "--set=work.url=https://example.test", "--clear=old", "--json"], ok: { session } },
      ...(["read", "ack", "archive"] as const).map(kind => ({ args: ["--host", "local", "notifications", kind, "n1", "--json"], ok: { record: notification } })),
    ];
    const stub = await cli(rules);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2 });
    for (const kind of ["stop", "remove", "resume"] as const) {
      expect((await client.act({ kind, host: "local", sessionId: "s1" })).ok).toBe(true);
    }
    expect((await client.act({ kind: "rename", host: "local", sessionId: "s1", name: "-new" })).ok).toBe(true);
    expect((await client.act({ kind: "rename", host: "local", sessionId: "s1", name: null })).ok).toBe(true);
    expect((await client.act({ kind: "fork", host: "local", sessionId: "s1", name: "fork" })).ok).toBe(true);
    expect((await client.act({ kind: "metadata", host: "local", sessionId: "s1", set: { "work.url": "https://example.test" }, clear: ["old"] })).ok).toBe(true);
    for (const kind of ["read", "ack", "archive"] as const) {
      expect((await client.act({ kind, host: "local", notificationId: "n1" })).ok).toBe(true);
    }
    expect((await stub.calls()).flat().includes("--accept-unconfirmed-cleanup")).toBe(false);
  });

  test("classifies CLI errors, protocol mismatch and malformed payloads", async () => {
    const stub = await cli([
      { args: ["--host", "local", "session", "inspect", "timeout", "--json"], err: { class: "timeout", code: "request_timeout", msg: "late" } },
      { args: ["--host", "local", "session", "inspect", "mismatch", "--json"], stdout: JSON.stringify({ cli_version: "future", protocol: { minimum: 5, maximum: 6 }, ok: session }) },
      { args: ["--host", "local", "session", "inspect", "broken", "--json"], ok: { ...session, state: 42 } },
    ]);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2 });
    const timeout = await client.inspectSession("local", "timeout");
    const mismatch = await client.inspectSession("local", "mismatch");
    const broken = await client.inspectSession("local", "broken");
    expect(timeout.ok ? null : timeout.error.code).toBe("timeout");
    expect(mismatch.ok ? null : mismatch.error.code).toBe("protocol_mismatch");
    expect(broken.ok ? null : broken.error.code).toBe("invalid_response");
  });

  test("rejects a host-qualified target before it can override the selected host", async () => {
    const stub = await cli([]);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 2_000, notificationsPageSize: 2 });
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
    const stub = await cli([{ args, ok: { removed: true, stopped: true, worktrees_removed: 0, worktrees_failed: 0 }, delayMs: 200 }]);
    const client = createControlClient({ binary: stub.binary, timeoutMs: 30, notificationsPageSize: 2 });
    const result = await client.act({ kind: "remove", host: "local", sessionId: "s1" });
    expect(result.ok ? null : result.error.code).toBe("timeout");
    expect(await stub.calls()).toEqual([args]);
  });
});
