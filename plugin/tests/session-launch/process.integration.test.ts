import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionLauncher, LaunchError, type LaunchRequest, type SessionLauncher } from "../../src/session-launch/index.ts";

type Scenario = "success" | "assistant" | "warnings" | "explicit-error" | "timeout" | "malformed";
type Trace = { readonly argv: readonly string[]; readonly stdin: string };

const directories: string[] = [];
const remoteHost = `netbird:peer~${Buffer.from("peer-1").toString("base64url")}@4827`;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function cli(scenario: Scenario): Promise<{ bin: string; trace: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-session-launch-"));
  directories.push(directory);
  const bin = join(directory, "pohunek");
  const trace = join(directory, "trace.jsonl");
  const source = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const scenario = ${JSON.stringify(scenario)};
const trace = ${JSON.stringify(trace)};
const argv = process.argv.slice(2);
const input = argv.includes("--input-stdin") ? await Bun.stdin.text() : "";
const prior = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
appendFileSync(trace, JSON.stringify({ argv, stdin: input }) + "\\n");
const ok = (payload) => console.log(JSON.stringify({ cli_version: "0.33.1", protocol: { minimum: 4, maximum: 4 }, ok: payload }));
const fail = (code) => { console.log(JSON.stringify({ cli_version: "0.33.1", protocol: { minimum: 4, maximum: 4 }, err: { class: "request", code, msg: "rejected" } })); process.exit(2); };
if (argv[0] === "host" && argv[1] === "list") ok([
  { name: "devbox", fqdn: "devbox.example.test", peer_id: "peer-1", address: null, overlay: "netbird", port: 4827, classification: "reachable_daemon" },
  { name: "nameless-route", fqdn: null, peer_id: null, address: null, overlay: "netbird", port: 4827, classification: "reachable_daemon" },
  { name: "offline", fqdn: "offline.example.test", peer_id: null, address: null, overlay: "netbird", port: 4827, classification: "unreachable" }
]);
else if (argv[0] === "project" && argv[1] === "list") ok([{ id: "p-1", label: argv.some((arg) => arg.startsWith("netbird:peer~")) ? "remote" : "local-repo" }]);
else if (argv[0] === "project" && argv[1] === "actions") ok({ actions: [
  { name: "review", provider: "none", template: "review-prompt", layer: "in_repo" },
  { name: "issue", provider: "linear_issue", template: "issue-prompt", layer: "host" }
] });
else if (argv[0] === "project" && argv[1] === "action") ok({
  provider: argv.includes("issue") ? "linear_issue" : "none",
  agent: "codex", branch: "review/topic", base_branch: "main", prompt_name: "review-prompt",
  prompt_content: argv.includes("variable") ? "Review \${title}" : "Review the selected project\\n",
});
else if (argv[0] === "host" && argv[1] === "inspect") ok({ runtimes: [
  { agent: "shell", agent_base: "shell", available: true },
  { agent: "codex", agent_base: "codex", available: true, supported: true },
  { agent: "broken", agent_base: "claude", available: false },
  { agent: "old", agent_base: "claude", available: true, supported: false }
] });
else if (argv[0] === "session" && argv[1] === "new") {
  if (scenario === "timeout") await Bun.sleep(500);
  if (scenario === "malformed") console.log("not-json");
  else if (scenario === "explicit-error" && !prior.some((entry) => entry.argv[0] === "session")) fail("project_not_found");
  else ok({ id: "s-session", ...(scenario === "warnings" ? { warnings: [{ kind: "base_branch_fallback", message: "private branch detail" }] } : {}) });
}
else if (argv[0] === "assistant") ok({ session: { id: "s-assistant" }, assistant: { intent: "debug" } });
else if (argv[0] === "attach") process.exit(prior.filter((entry) => entry.argv[0] === "attach").length === 0 ? 7 : 0);
else fail("unknown_command");
`;
  await writeFile(bin, source, { mode: 0o700 });
  await chmod(bin, 0o700);
  return { bin, trace };
}

async function calls(path: string): Promise<readonly Trace[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Trace);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function launcher(bin: string, launchTimeoutMs = 1500): SessionLauncher {
  return createSessionLauncher({ bin, queryTimeoutMs: 1500, launchTimeoutMs, launchKillMarginMs: 100 });
}

async function expectFailure(operation: Promise<unknown>, code: LaunchError["code"]): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof LaunchError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} failure`);
}

function sessionRequest(): Extract<LaunchRequest, { kind: "session" }> {
  return { kind: "session", host: "local", project: null, agent: null, name: null, prompt: null, branch: null, baseBranch: null };
}

test("loads live host, project, and available agent choices through the CLI", async () => {
  const { bin, trace } = await cli("success");
  const service = launcher(bin);
  const local = await service.loadOptions();
  expect(local.warning).toBeNull();
  expect(local.hosts).toEqual([{ id: "local", label: "Local" }, { id: remoteHost, label: "devbox" }]);
  expect(local.projects).toEqual([{ id: "p-1", label: "local-repo" }]);
  expect(local.agents).toEqual([
    { id: "shell", label: "shell", assistantCapable: false },
    { id: "codex", label: "codex", assistantCapable: true },
  ]);
  const remote = await service.loadOptions(remoteHost);
  expect(remote.projects).toEqual([{ id: "p-1", label: "remote" }]);
  expect((await calls(trace)).filter((call) => call.argv[0] === "project").at(-1)?.argv).toEqual(["project", "list", "--host", remoteHost, "--json"]);
});

test("creates a blank local session once and retries attach on the same terminal", async () => {
  const { bin, trace } = await cli("success");
  const service = launcher(bin);
  const [first, second] = await Promise.all([service.createSession(sessionRequest()), service.createSession(sessionRequest())]);
  expect(first).toEqual(second);
  expect(first.sessionId).toBe("s-session");
  expect(service.status()).toEqual({ phase: "created", session: first });
  expect((await service.attachSession()).exitCode).toBe(7);
  expect((await service.attachSession()).exitCode).toBe(0);
  expect((await service.createSession(sessionRequest())).sessionId).toBe("s-session");
  const traceLines = await calls(trace);
  expect(traceLines.filter((call) => call.argv[0] === "session")).toHaveLength(1);
  expect(traceLines.filter((call) => call.argv[0] === "attach")).toEqual([
    { argv: ["attach", "--host", "local", "s-session"], stdin: "" },
    { argv: ["attach", "--host", "local", "s-session"], stdin: "" },
  ]);
  const create = traceLines.find((call) => call.argv[0] === "session");
  expect(create?.argv).toContain("--json");
  expect(create?.argv).not.toContain("--input-stdin");
});

test("retains launch warning kinds with the created identity", async () => {
  const { bin } = await cli("warnings");
  const service = launcher(bin);
  const result = await service.createSession(sessionRequest());
  expect(result).toEqual({ sessionId: "s-session", host: "local", kind: "session", warnings: ["base_branch_fallback"] });
  expect(service.status()).toEqual({ phase: "created", session: result });
});

test("creates a remote session with prompt on stdin and confirms the target", async () => {
  const { bin, trace } = await cli("success");
  const service = launcher(bin);
  const request: LaunchRequest = {
    kind: "session", host: remoteHost, project: "p-1", agent: "codex", name: "Review", prompt: "Review this branch\nsecond line",
    branch: "review/issue", baseBranch: "main", cols: 120, rows: 40,
  };
  const created = await service.createSession(request);
  expect(created.host).toBe(remoteHost);
  const create = (await calls(trace)).find((call) => call.argv[0] === "session");
  expect(create?.stdin).toBe("Review this branch\nsecond line");
  expect(create?.argv).toContain("--yes");
  expect(create?.argv).toContain("--input-stdin");
  expect(create?.argv).toContain("--branch");
  expect(create?.argv).not.toContain("Review this branch\nsecond line");
});

test("lists static project actions and resolves their editable launch recipe on the selected host", async () => {
  const { bin, trace } = await cli("success");
  const service = launcher(bin);
  expect(await service.loadActions(remoteHost, "p-1")).toEqual([
    { id: "review", label: "review", template: "review-prompt" },
  ]);
  const resolved = await service.resolveAction(remoteHost, "p-1", "review");
  expect(resolved).toEqual({ agent: "codex", branch: "review/topic", baseBranch: "main", prompt: "Review the selected project\n" });
  const created = await service.createSession({
    ...sessionRequest(), host: remoteHost, project: "p-1", agent: resolved.agent,
    branch: resolved.branch, baseBranch: resolved.baseBranch, prompt: resolved.prompt,
  });
  expect(created.sessionId).toBe("s-session");
  const traceLines = await calls(trace);
  expect(traceLines.find((call) => call.argv[1] === "actions")?.argv).toEqual(["project", "actions", "--host", remoteHost, "p-1", "--json"]);
  expect(traceLines.find((call) => call.argv[1] === "action")?.argv).toEqual(["project", "action", "--host", remoteHost, "p-1", "review", "--json"]);
  const creation = traceLines.find((call) => call.argv[0] === "session");
  expect(creation?.stdin).toBe(resolved.prompt);
  expect(creation?.argv).not.toContain(resolved.prompt);
});

test("refuses provider actions and unrenderable static templates", async () => {
  const { bin, trace } = await cli("success");
  const service = launcher(bin);
  await expectFailure(service.resolveAction("local", "p-1", "issue"), "invalid_request");
  await expectFailure(service.resolveAction("local", "p-1", "variable"), "invalid_request");
  expect((await calls(trace)).some((call) => call.argv[0] === "session")).toBe(false);
});

test("reads the assistant session ID from the nested CLI response", async () => {
  const { bin, trace } = await cli("assistant");
  const service = launcher(bin);
  const created = await service.createSession({
    kind: "assistant", host: "local", project: "p-1", branch: null, baseBranch: null,
    intent: "debug", agent: null, request: null, noSnapshot: true, degraded: false,
  });
  expect(created.sessionId).toBe("s-assistant");
  const assistant = (await calls(trace)).find((call) => call.argv[0] === "assistant");
  expect(assistant?.argv).toEqual(["assistant", "--host", "local", "--project", "p-1", "--intent", "debug", "--no-snapshot", "--json"]);
  expect((await service.attachSession()).sessionId).toBe("s-assistant");
});

test("rejects assistant request text before spawning the CLI", async () => {
  const { bin, trace } = await cli("assistant");
  const service = launcher(bin);
  await expectFailure(service.createSession({
    kind: "assistant", host: "local", project: null, branch: null, baseBranch: null,
    intent: "help", agent: null, request: "Private request", noSnapshot: false, degraded: false,
  }), "invalid_request");
  expect(service.status()).toEqual({ phase: "ready" });
  expect(await calls(trace)).toEqual([]);
});

test("an explicit refusal permits another create attempt but a timed-out attempt does not", async () => {
  const refused = await cli("explicit-error");
  const retryable = launcher(refused.bin);
  await expectFailure(retryable.createSession(sessionRequest()), "cli_failed");
  expect(retryable.status()).toEqual({ phase: "ready" });
  await retryable.createSession(sessionRequest());
  expect((await calls(refused.trace)).filter((call) => call.argv[0] === "session")).toHaveLength(2);

  const timedOut = await cli("timeout");
  const uncertain = launcher(timedOut.bin, 100);
  await expectFailure(uncertain.createSession(sessionRequest()), "creation_unknown");
  expect(uncertain.status().phase).toBe("unknown");
  await expectFailure(uncertain.createSession(sessionRequest()), "creation_unknown");
  expect((await calls(timedOut.trace)).filter((call) => call.argv[0] === "session")).toHaveLength(1);
});

test("malformed success is ambiguous, and invalid remote form never starts the CLI", async () => {
  const { bin, trace } = await cli("malformed");
  const service = launcher(bin);
  await expectFailure(service.createSession(sessionRequest()), "creation_unknown");
  expect(service.status().phase).toBe("unknown");
  const invalid = launcher(bin);
  await expectFailure(invalid.createSession({ ...sessionRequest(), host: "remote" }), "invalid_request");
  expect(invalid.status()).toEqual({ phase: "ready" });
  expect((await calls(trace)).filter((call) => call.argv[0] === "session")).toHaveLength(1);
});
