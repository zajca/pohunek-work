// End-to-end scenarios of `pohunek-work do <key> cleanup` against a real pohunekd from the pinned core release.
// The issue's session is a shell-like session (profile `quiet`) in a worktree the daemon creates, linked to the
// GitHub issue through its metadata. `do` reads the issue from the local GraphQL server
// (helpers/github-provider.ts); the branch is pushed to a bare repository under the daemon's root, and git
// rewrites the project's GitHub origin to that repository for the fetch cleanup makes. Core drops `session_id`
// from a worktree's entry in `project show` once its session stops, and these scenarios run the ownership check
// after such a real stop.
import { afterEach, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";
import {
  DAEMON_STOP_HOOK_TIMEOUT_MS,
  installAgentProfile,
  runPlugin,
  startCoreDaemon,
  workersBelow,
  writePluginConfig,
  type CliResult,
  type CoreDaemon,
  type PluginFixture,
} from "./helpers/core-daemon.ts";
import { GITHUB_ISSUE_PROJECT, startGithubProvider, type GithubIssue, type GithubProvider } from "./helpers/github-provider.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const GIT_TIMEOUT_MS = 30_000;
/** Upper bound for a shell session to report activity `idle`, which cleanup requires before it stops the session. */
const IDLE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
/**
 * Host agent profile of the sessions: it prints a prompt and then sleeps, so the session reports activity `idle`.
 * A plain shell session stays `working`, and cleanup only stops a session that is finished or idle.
 */
const QUIET_PROFILE = "quiet";
/** How long the quiet agent sleeps; longer than any scenario, the daemon's stop ends it. */
const QUIET_SLEEP_SECS = 3600;
const EXIT_ERROR = 2;
const ISSUE: GithubIssue = { repo: "acme/widgets", number: 7, title: "Cache widgets", body: "Cache the widgets." };
const ISSUE_KEY = `${ISSUE.repo}#${String(ISSUE.number)}`;
const ROW_KEY = `github-issue:${ISSUE_KEY}`;
/** `<branch_prefix>/<issue_number_prefix><n>/<slug of the title>` of the fixture configuration. */
const ISSUE_BRANCH = "alice/issue-7/cache-widgets";
/** A session that is not linked to the issue but starts in the same worktree, so it claims the path. */
const SQUATTER_NAME = "squatter";

interface DaemonSession {
  readonly id: string;
  readonly name?: string;
  readonly state: string;
  readonly activity?: string;
  readonly worktree_path?: string | null;
  readonly cwd?: string | null;
}

interface Setup {
  readonly core: CoreDaemon;
  readonly fixture: PluginFixture;
  readonly github: GithubProvider;
  /** The bare repository the branch is pushed to, which the project's origin is rewritten to before cleanup. */
  readonly origin: string;
  /** The worktree of the issue's session, once `startIssueSession` created it. */
  worktree: string;
  /** The issue's session, once `startIssueSession` created it. */
  sessionId: string;
}

/** Resources of the running scenario, registered as soon as each one starts so that `afterEach` releases them on failure. */
let daemon: CoreDaemon | null = null;
let github: GithubProvider | null = null;

afterEach(async () => {
  try {
    await github?.stop();
  } finally {
    github = null;
    await daemon?.stop();
    daemon = null;
  }
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

/** A daemon with project widgets whose origin is a local bare repository holding `main`, and the GitHub issue. */
async function setUp(): Promise<Setup> {
  const core = await startCoreDaemon();
  daemon = core;
  await core.registerProject("widgets", ISSUE.repo);
  await installQuietAgent(core);
  const repo = join(core.root, "repos", "widgets");
  const origin = join(core.root, "origin.git");
  await git(core.root, ["init", "-q", "--bare", "-b", "main", origin]);
  await git(repo, ["push", "-q", origin, "HEAD:refs/heads/main"]);
  const provider = await startGithubProvider(join(core.root, "github"), ISSUE);
  github = provider;
  const fixture = await writePluginConfig(core, [{ label: "widgets", repo: ISSUE.repo, template: GITHUB_ISSUE_PROJECT }], {
    overrides: { "github.endpoint": provider.endpoint, "github.gh_bin": provider.ghBin },
  });
  return {
    core,
    fixture: { ...fixture, env: { ...fixture.env, NODE_EXTRA_CA_CERTS: provider.caFile } },
    github: provider,
    origin,
    worktree: "",
    sessionId: "",
  };
}

async function installQuietAgent(core: CoreDaemon): Promise<void> {
  const sleep = Bun.which("sleep");
  if (sleep === null) throw new Error("sleep is not on PATH; the quiet agent profile needs it");
  await installAgentProfile(core, QUIET_PROFILE, `#!/bin/sh\nprintf 'ready\\n$ '\nexec ${sleep} ${String(QUIET_SLEEP_SECS)}\n`);
}

function issueMetadata(github: GithubProvider): string[] {
  const metadata = {
    "work.link.provider": "github",
    "work.link.kind": "issue",
    "work.link.id": ISSUE_KEY,
    "work.link.url": github.issueUrl,
    "work.link.branch": ISSUE_BRANCH,
    "work.role": "implement",
    "work.rev": "started",
  };
  return Object.entries(metadata).flatMap(([key, value]) => ["--meta", `${key}=${value}`]);
}

async function inspect(core: CoreDaemon, sessionId: string): Promise<DaemonSession> {
  const inspected = await core.pohunek(["session", "inspect", sessionId, "--json"]);
  const envelope = JSON.parse(inspected.stdout) as { ok?: DaemonSession };
  if (envelope.ok === undefined) throw new Error(`session inspect failed: ${inspected.stdout}${inspected.stderr}`);
  return envelope.ok;
}

async function sessions(core: CoreDaemon): Promise<DaemonSession[]> {
  const listed = await core.pohunek(["session", "list", "--json"]);
  const envelope = JSON.parse(listed.stdout) as { ok?: DaemonSession[] };
  if (envelope.ok === undefined) throw new Error(`session list failed: ${listed.stdout}${listed.stderr}`);
  return envelope.ok;
}

/** Polls until `predicate` holds for the session, or fails with the last state read. */
async function waitForSession(core: CoreDaemon, sessionId: string, predicate: (session: DaemonSession) => boolean, timeoutMs: number): Promise<DaemonSession> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await inspect(core, sessionId);
    if (predicate(current)) return current;
    if (Date.now() > deadline) throw new Error(`session ${sessionId} did not reach the expected state: ${JSON.stringify(current)}`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

/** Starts the issue's shell session in a worktree on `ISSUE_BRANCH`, pushes the branch and records its worktree. */
async function startIssueSession(state: Setup): Promise<void> {
  const created = await state.core.pohunek([
    "session", "new", "--agent", QUIET_PROFILE, "--project", "widgets", "--branch", ISSUE_BRANCH, "--name", ISSUE_KEY,
    ...issueMetadata(state.github), "--json",
  ]);
  const id = (JSON.parse(created.stdout) as { ok?: { id?: unknown } }).ok?.id;
  if (typeof id !== "string") throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  const current = await inspect(state.core, id);
  if (current.worktree_path === undefined || current.worktree_path === null) throw new Error(`session ${id} has no worktree`);
  const worktree = current.worktree_path;
  await git(worktree, ["push", "-q", state.origin, `${ISSUE_BRANCH}:${ISSUE_BRANCH}`]);
  state.sessionId = id;
  state.worktree = worktree;
}

/** Waits until the issue's session is running and idle, the state `do cleanup` accepts without stopping it first. */
async function waitForIdle(state: Setup): Promise<void> {
  await waitForSession(state.core, state.sessionId, (s) => s.state === "running" && s.activity === "idle", IDLE_TIMEOUT_MS);
}

async function stopSession(core: CoreDaemon, sessionId: string): Promise<void> {
  const stopped = await core.pohunek(["session", "stop", sessionId, "--json"]);
  if (!stopped.stdout.includes('"stopped": true')) throw new Error(`session stop failed: ${stopped.stdout}${stopped.stderr}`);
  await waitForSession(core, sessionId, (s) => s.state === "stopped", STOP_TIMEOUT_MS);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Rewrites the project's GitHub origin to the bare repository, which cleanup fetches the branch from. It is done
 * just before cleanup because the daemon records the origin again when a session starts in the repository
 * (`session new --cwd` does), and the plugin only lists projects whose recorded origin is a GitHub URL.
 */
async function routeOriginToBare(state: Setup): Promise<void> {
  const repo = join(state.core.root, "repos", "widgets");
  await git(repo, ["config", `url.${state.origin}.insteadOf`, `git@github.com:${ISSUE.repo}.git`]);
}

async function cleanup(state: Setup, extra: readonly string[]): Promise<CliResult> {
  await routeOriginToBare(state);
  return runPlugin(state.fixture, ["do", ROW_KEY, "cleanup", ...extra, "--json"], PROCESS_TIMEOUT_MS);
}

/** Stops the daemon and checks that no session worker outlived it. */
async function stopAndCheckWorkers(core: CoreDaemon): Promise<void> {
  await core.stop();
  expect(await workersBelow(core.runtimeDir)).toEqual([]);
}

test("cleanup of an idle session stops it and removes its worktree", async () => {
  const state = await setUp();
  await startIssueSession(state);
  await waitForIdle(state);

  const result = await cleanup(state, ["--yes"]);

  expect(state.github.unexpectedOperations).toEqual([]);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.out) as { ok: { result: { removed: boolean } } };
  expect(envelope.ok.result.removed).toBe(true);
  expect(await exists(state.worktree)).toBe(false);
  expect((await sessions(state.core)).map((s) => s.id)).not.toContain(state.sessionId);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("cleanup of a session that is already stopped removes its worktree", async () => {
  const state = await setUp();
  await startIssueSession(state);
  await waitForIdle(state);
  await stopSession(state.core, state.sessionId);

  const result = await cleanup(state, ["--yes"]);

  expect(state.github.unexpectedOperations).toEqual([]);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.out) as { ok: { result: { removed: boolean } } };
  expect(envelope.ok.result.removed).toBe(true);
  expect(await exists(state.worktree)).toBe(false);
  expect((await sessions(state.core)).map((s) => s.id)).not.toContain(state.sessionId);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("cleanup refuses after the stop when another stopped session also claims the worktree, and removes nothing", async () => {
  const state = await setUp();
  await startIssueSession(state);
  await waitForIdle(state);
  // A second session that starts in the same worktree without the issue's link, so the row still has one owner.
  const squatter = await state.core.pohunek(["session", "new", "--agent", QUIET_PROFILE, "--cwd", state.worktree, "--name", SQUATTER_NAME, "--json"]);
  const squatterId = (JSON.parse(squatter.stdout) as { ok?: { id?: unknown } }).ok?.id;
  if (typeof squatterId !== "string") throw new Error(`session new --cwd failed: ${squatter.stdout}${squatter.stderr}`);
  await waitForSession(state.core, squatterId, (s) => s.cwd === state.worktree, IDLE_TIMEOUT_MS);
  await stopSession(state.core, squatterId);

  const result = await cleanup(state, ["--yes"]);

  expect(result.code).toBe(EXIT_ERROR);
  const err = (JSON.parse(result.out) as { err: { code: string; msg: string } }).err;
  expect(err.code).toBe("precondition_failed");
  expect(err.msg).toContain("worktree_owned");
  expect(err.msg).toContain("the session stays stopped and nothing was removed");
  expect(await exists(state.worktree)).toBe(true);
  expect((await inspect(state.core, state.sessionId)).state).toBe("stopped");
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);


