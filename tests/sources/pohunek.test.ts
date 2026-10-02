import { expect, test } from "bun:test";
import {
  createPohunekClient,
  isLiveSession,
  parseOriginRepo,
  SUPPORTED_PROTOCOL_VERSION,
} from "../../src/sources/pohunek.ts";
import type { PohunekConfig } from "../../src/types/config.ts";
import type { PohunekSession, SourceResult } from "../../src/types/sources.ts";
import { SpawnError, type Exec, type ExecResult } from "../../src/util/exec.ts";

const CONFIG: PohunekConfig = { bin: "/fake/pohunek", timeoutMs: 1234, notificationsPageSize: 2 };
const FIXTURES = new URL("../fixtures/pohunek/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return Bun.file(new URL(name, FIXTURES)).text();
}

function reply(stdout: string, exitCode = 0): ExecResult {
  return { exitCode, stdout, stderr: "", timedOut: false };
}

interface Recorded {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly hasEnv: boolean;
}

function fakeExec(handler: (argv: readonly string[]) => ExecResult | Promise<ExecResult>): {
  exec: Exec;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const exec: Exec = async (argv, options) => {
    calls.push({ argv, timeoutMs: options.timeoutMs, hasEnv: options.env !== undefined });
    return handler(argv);
  };
  return { exec, calls };
}

function failureOf(result: SourceResult<unknown>): { code: string; message: string } {
  if (result.ok) {
    throw new Error("expected a failure result");
  }
  return { code: result.code, message: result.message };
}

test("listProjects normalizes the project list", async () => {
  const body = await fixture("project-list.json");
  const { exec, calls } = fakeExec(() => reply(body));
  const result = await createPohunekClient(CONFIG, { exec, env: {} }).listProjects();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.source).toBe("pohunek");
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(result.data).toEqual([
    { id: "prj_1", label: "widgets", originUrl: "git@github.com:acme/widgets.git", defaultBaseBranch: "main" },
    { id: "prj_2", label: "gadgets", originUrl: "https://github.com/acme/gadgets", defaultBaseBranch: null },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.argv).toEqual(["/fake/pohunek", "project", "list", "--json"]);
  expect(calls[0]?.timeoutMs).toBe(1234);
  expect(calls[0]?.hasEnv).toBe(false);
});

test("listSessions normalizes metadata, runtime state and activity", async () => {
  const body = await fixture("session-list.json");
  const { exec, calls } = fakeExec(() => reply(body));
  const result = await createPohunekClient(CONFIG, { exec, env: {} }).listSessions();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(calls[0]?.argv).toEqual(["/fake/pohunek", "session", "list", "--json"]);
  const [first, lost, stopped] = result.data;
  expect(first).toEqual({
    id: "ses_1",
    name: "ABC-1",
    projectLabel: "widgets",
    branch: "abc-1-add-widget-cache",
    worktreePath: "/work/widgets-wt/abc-1",
    cwd: "/work/widgets",
    state: "running",
    activity: "working",
    runtimeState: "connected",
    metadata: { "pohunek_work.item": "acme/widgets#12" },
  });
  expect(lost?.metadata).toEqual({});
  expect(lost?.runtimeState).toBe("lost");
  expect(stopped?.activity).toBeNull();
  expect(stopped?.runtimeState).toBeNull();
  expect(stopped?.branch).toBeNull();
});

test("isLiveSession: running with a lost runtime is not live", async () => {
  const body = await fixture("session-list.json");
  const { exec } = fakeExec(() => reply(body));
  const result = await createPohunekClient(CONFIG, { exec, env: {} }).listSessions();
  if (!result.ok) throw new Error("expected ok");
  expect(result.data.map(isLiveSession)).toEqual([true, false, false]);
});

test("isLiveSession: absent runtime counts as not lost", () => {
  const session: PohunekSession = {
    id: "s", name: null, projectLabel: null, branch: null, worktreePath: null, cwd: null,
    state: "running", activity: null, runtimeState: null, metadata: {},
  };
  expect(isLiveSession(session)).toBe(true);
  expect(isLiveSession({ ...session, state: "done" })).toBe(false);
});

test("listNotifications paginates across pages and both statuses", async () => {
  const pages: Record<string, string> = {
    "unread|": await fixture("notifications-unread-page1.json"),
    "unread|cursor-unread-2": await fixture("notifications-unread-page2.json"),
    "read|": await fixture("notifications-read-page1.json"),
  };
  const { exec, calls } = fakeExec((argv) => {
    const status = argv[argv.indexOf("--status") + 1] ?? "";
    const cursorIndex = argv.indexOf("--cursor");
    const cursor = cursorIndex === -1 ? "" : (argv[cursorIndex + 1] ?? "");
    return reply(pages[`${status}|${cursor}`] ?? "{}");
  });
  const result = await createPohunekClient(CONFIG, { exec, env: {} }).listNotifications();
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.map((n) => n.id)).toEqual(["ntf_1", "ntf_2", "ntf_3", "ntf_4"]);
  expect(result.data.map((n) => n.kind)).toEqual(["agent_blocked", "turn_completed", "approval_required", "agent_blocked"]);
  expect(result.data[0]).toEqual({
    id: "ntf_1", kind: "agent_blocked", status: "unread", sessionId: "ses_1", createdAt: "2026-01-01T00:00:00Z",
  });
  expect(calls.map((c) => c.argv)).toEqual([
    ["/fake/pohunek", "notifications", "list", "--json", "--limit", "2", "--status", "unread"],
    ["/fake/pohunek", "notifications", "list", "--json", "--limit", "2", "--status", "unread", "--cursor", "cursor-unread-2"],
    ["/fake/pohunek", "notifications", "list", "--json", "--limit", "2", "--status", "read"],
  ]);
});

test("listNotifications fails on a repeated cursor", async () => {
  const page = (await fixture("notifications-unread-page1.json"));
  const { exec, calls } = fakeExec(() => reply(page));
  const result = await createPohunekClient(CONFIG, { exec, env: {} }).listNotifications();
  const failure = failureOf(result);
  expect(failure.code).toBe("invalid_response");
  expect(failure.message).toContain("repeated");
  expect(calls).toHaveLength(2);
});

for (const [name, env] of [
  ["only session id", { POHUNEK_SESSION_ID: "ses_x" }],
  ["only daemon id", { POHUNEK_DAEMON_ID: "dmn_x" }],
] as const) {
  test(`origin_environment when ${name} is set, without calling the CLI`, async () => {
    const { exec, calls } = fakeExec(() => reply("{}"));
    const client = createPohunekClient(CONFIG, { exec, env });
    const results = [await client.listProjects(), await client.listSessions(), await client.listNotifications()];
    for (const result of results) {
      const failure = failureOf(result);
      expect(failure.code).toBe("origin_environment");
      expect(failure.message).toContain("POHUNEK_SESSION_ID");
      expect(failure.message).toContain("POHUNEK_DAEMON_ID");
      expect(failure.message).toContain("Nothing was unset");
    }
    expect(calls).toHaveLength(0);
  });
}

for (const [name, env] of [
  ["both set", { POHUNEK_SESSION_ID: "ses_x", POHUNEK_DAEMON_ID: "dmn_x" }],
  ["neither set", {}],
] as const) {
  test(`no origin failure when ${name}`, async () => {
    const body = await fixture("project-list.json");
    const { exec, calls } = fakeExec(() => reply(body));
    const result = await createPohunekClient(CONFIG, { exec, env }).listProjects();
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.hasEnv).toBe(false);
  });
}

test("protocol outside the offered range is protocol_mismatch", async () => {
  expect(SUPPORTED_PROTOCOL_VERSION).toBe(3);
  const body = await fixture("protocol-mismatch.json");
  const { exec } = fakeExec(() => reply(body));
  const failure = failureOf(await createPohunekClient(CONFIG, { exec, env: {} }).listProjects());
  expect(failure.code).toBe("protocol_mismatch");
  expect(failure.message).toContain("4-5");
});

test("err incomplete_origin_environment maps to origin_environment", async () => {
  const body = await fixture("err-origin-environment.json");
  const { exec } = fakeExec(() => reply(body, 2));
  const failure = failureOf(await createPohunekClient(CONFIG, { exec, env: {} }).listSessions());
  expect(failure.code).toBe("origin_environment");
  expect(failure.message).toContain("POHUNEK_SESSION_ID");
  expect(failure.message).toContain("POHUNEK_DAEMON_ID");
});

test("err framing maps to unavailable and names the code", async () => {
  const body = await fixture("err-framing.json");
  const { exec } = fakeExec(() => reply(body, 2));
  const failure = failureOf(await createPohunekClient(CONFIG, { exec, env: {} }).listNotifications());
  expect(failure.code).toBe("unavailable");
  expect(failure.message).toContain("framing");
});

test("timeout maps to timeout", async () => {
  const { exec } = fakeExec(() => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }));
  const failure = failureOf(await createPohunekClient(CONFIG, { exec, env: {} }).listProjects());
  expect(failure.code).toBe("timeout");
});

test("SpawnError maps to unavailable", async () => {
  const exec: Exec = () => Promise.reject(new SpawnError("/fake/pohunek", new Error("ENOENT")));
  const failure = failureOf(await createPohunekClient(CONFIG, { exec, env: {} }).listProjects());
  expect(failure.code).toBe("unavailable");
});

test("malformed JSON is invalid_response, with exit 0 and non-zero", async () => {
  for (const exitCode of [0, 2]) {
    const { exec } = fakeExec(() => reply("not json {", exitCode));
    const failure = failureOf(await createPohunekClient(CONFIG, { exec, env: {} }).listProjects());
    expect(failure.code).toBe("invalid_response");
  }
});

test("envelope violations are invalid_response", async () => {
  const bodies = [
    "[]",
    JSON.stringify({ protocol: { minimum: 3, maximum: 3 }, ok: [] }),
    JSON.stringify({ cli_version: "1", protocol: { minimum: "3", maximum: 3 }, ok: [] }),
    JSON.stringify({ cli_version: "1", protocol: { minimum: 3, maximum: 3 } }),
    JSON.stringify({ cli_version: "1", protocol: { minimum: 3, maximum: 3 }, ok: [], err: {} }),
  ];
  for (const body of bodies) {
    const { exec } = fakeExec(() => reply(body));
    const failure = failureOf(await createPohunekClient(CONFIG, { exec, env: {} }).listProjects());
    expect(failure.code).toBe("invalid_response");
  }
});

test("a missing required field names the field path", async () => {
  const body = JSON.stringify({
    cli_version: "0.31.6",
    protocol: { minimum: 3, maximum: 3 },
    ok: [{ id: "prj_1", label: "widgets" }, { label: "no-id" }],
  });
  const { exec } = fakeExec(() => reply(body));
  const failure = failureOf(await createPohunekClient(CONFIG, { exec, env: {} }).listProjects());
  expect(failure.code).toBe("invalid_response");
  expect(failure.message).toContain("$.ok[1].id");
});

test("wrong types and wrong payload shapes are invalid_response", async () => {
  const wrap = (ok: unknown): string =>
    JSON.stringify({ cli_version: "0.31.6", protocol: { minimum: 3, maximum: 3 }, ok });
  const cases: readonly [string, string, string][] = [
    ["session", wrap([{ id: "s", state: 5 }]), "$.ok[0].state"],
    ["session", wrap([{ id: "s", state: "running", metadata: { k: 1 } }]), "$.ok[0].metadata.k"],
    ["session", wrap({ not: "an array" }), "$.ok"],
    ["notifications", wrap({ notifications: "x" }), "$.ok.notifications"],
    ["notifications", wrap({ notifications: [{ kind: "error", status: "unread", created_at: "t" }] }), "$.ok.notifications[0].id"],
    ["notifications", wrap({ notifications: [{ id: "n", status: "unread", created_at: "t" }] }), "$.ok.notifications[0].kind"],
    ["notifications", wrap({ notifications: [{ id: "n", kind: "agent_blocked", status: null, created_at: "t" }] }), "$.ok.notifications[0].status"],
    ["notifications", wrap({ notifications: [{ id: "n", kind: "agent_blocked", status: "pending", created_at: "t" }] }), "$.ok.notifications[0].status"],
  ];
  for (const [kind, body, path] of cases) {
    const { exec } = fakeExec(() => reply(body));
    const client = createPohunekClient(CONFIG, { exec, env: {} });
    const result = kind === "session" ? await client.listSessions() : await client.listNotifications();
    const failure = failureOf(result);
    expect(failure.code).toBe("invalid_response");
    expect(failure.message).toContain(path);
  }
});

test("argv carries only fixed tokens, numbers and the pohunek cursor", async () => {
  const body = await fixture("notifications-unread-page2.json");
  const { exec, calls } = fakeExec(() => reply(body));
  await createPohunekClient(CONFIG, { exec, env: {} }).listNotifications();
  for (const call of calls) {
    expect(call.argv[0]).toBe("/fake/pohunek");
    for (const token of call.argv) {
      expect(token).not.toContain("Synthetic");
      expect(token).not.toMatch(/\s/);
    }
  }
});

test("parseOriginRepo", () => {
  const table: readonly [string, string | null][] = [
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["git@github.com:acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets", "acme/widgets"],
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["https://github.com/acme/widgets/", "acme/widgets"],
    ["ssh://git@github.com/acme/widgets.git", "acme/widgets"],
    ["ssh://git@github.com:22/acme/widgets", "acme/widgets"],
    ["https://github.com/acme/my.repo-x.git", "acme/my.repo-x"],
    ["git@gitlab.com:acme/widgets.git", null],
    ["https://example.com/acme/widgets", null],
    ["https://github.com/acme", null],
    ["https://github.com/acme/widgets/extra", null],
    ["/local/path/widgets", null],
    ["", null],
  ];
  for (const [input, expected] of table) {
    expect(parseOriginRepo(input)).toBe(expected);
  }
});
