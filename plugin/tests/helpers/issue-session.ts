// A real pohunekd with project widgets for scenarios of `pohunek-work do` on GitHub issue acme/widgets#7: the
// project's origin is a local bare repository holding `main`, the local GraphQL server (github-provider.ts)
// answers the issue and optionally a pull request on the issue's branch, and sessions run the host profile
// `quiet`, which reports activity `idle`. Each test file owns a `ScenarioResources` and releases it in its own
// `afterEach`, so a failed setup never leaks a daemon or a server.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "bun:test";
import { exec } from "../../src/util/exec.ts";
import { installAgentProfile, startCoreDaemon, workersBelow, writePluginConfig, type CoreDaemon, type PluginFixture } from "./core-daemon.ts";
import { GITHUB_ISSUE_PROJECT, startGithubProvider, type GithubIssue, type GithubProvider, type GithubPullRequest } from "./github-provider.ts";

const GIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
/**
 * Host agent profile of the sessions: it prints a prompt and then sleeps, so the session reports activity `idle`.
 * A plain shell session stays `working`, and cleanup only stops a session that is finished or idle.
 */
export const QUIET_PROFILE = "quiet";
/** How long the quiet agent sleeps; longer than any scenario, the daemon's stop ends it. */
const QUIET_SLEEP_SECS = 3600;
/** Upper bound for a shell session to report activity `idle`, which cleanup requires before it stops the session. */
export const IDLE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 30_000;
export const ISSUE: GithubIssue = { repo: "acme/widgets", number: 7, title: "Cache widgets", body: "Cache the widgets." };
export const ISSUE_KEY = `${ISSUE.repo}#${String(ISSUE.number)}`;
export const ROW_KEY = `github-issue:${ISSUE_KEY}`;
/** `<branch_prefix>/<issue_number_prefix><n>/<slug of the title>` of the fixture configuration. */
export const ISSUE_BRANCH = "alice/issue-7/cache-widgets";
/** Label of the daemon project and of the plugin project file. */
export const PROJECT_LABEL = "widgets";

export interface DaemonSession {
  readonly id: string;
  readonly name?: string;
  readonly state: string;
  readonly activity?: string;
  readonly worktree_path?: string | null;
  readonly cwd?: string | null;
}

/** Resources of the running scenario, registered as soon as each one starts so that `afterEach` releases them on failure. */
export interface ScenarioResources {
  daemon: CoreDaemon | null;
  github: GithubProvider | null;
}

export function scenarioResources(): ScenarioResources {
  return { daemon: null, github: null };
}

/** Stops the GitHub server and the daemon of the scenario; safe when setup failed part way. */
export async function releaseResources(resources: ScenarioResources): Promise<void> {
  try {
    await resources.github?.stop();
  } finally {
    resources.github = null;
    await resources.daemon?.stop();
    resources.daemon = null;
  }
}

export interface Setup {
  readonly core: CoreDaemon;
  readonly fixture: PluginFixture;
  readonly github: GithubProvider;
  /** The bare repository the branch is pushed to, which the project's origin is rewritten to before `do`. */
  readonly origin: string;
  /** The project's primary checkout. */
  readonly repo: string;
  /** The worktree of the issue's session, once `startIssueSession` created it. */
  worktree: string;
  /** The issue's session, once `startIssueSession` created it. */
  sessionId: string;
}

export interface SetupOptions {
  /** The pull request the GraphQL server answers, joined to the issue by its head branch; none when absent. */
  readonly pullRequest?: GithubPullRequest;
  /** Values of global configuration keys, as `writePluginConfig` takes them. */
  readonly overrides?: Readonly<Record<string, string | number>>;
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await exec(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout;
}

/** A daemon with project widgets whose origin is a local bare repository holding `main`, and the GitHub issue. */
export async function setUpIssueProject(resources: ScenarioResources, options: SetupOptions = {}): Promise<Setup> {
  const core = await startCoreDaemon();
  resources.daemon = core;
  await core.registerProject(PROJECT_LABEL, ISSUE.repo);
  await installQuietAgent(core);
  const repo = join(core.root, "repos", PROJECT_LABEL);
  const origin = join(core.root, "origin.git");
  await git(core.root, ["init", "-q", "--bare", "-b", "main", origin]);
  await git(repo, ["push", "-q", origin, "HEAD:refs/heads/main"]);
  const provider = await startGithubProvider(join(core.root, "github"), ISSUE, options.pullRequest ?? null);
  resources.github = provider;
  return {
    core,
    fixture: await writeIssueConfig(core, provider, options.overrides ?? {}),
    github: provider,
    origin,
    repo,
    worktree: "",
    sessionId: "",
  };
}

/**
 * Writes a plugin configuration for the daemon and the GitHub server, with `overrides` of global keys. `name`
 * gives a second configuration of the same daemon its own directories.
 */
export async function writeIssueConfig(
  core: CoreDaemon,
  provider: GithubProvider,
  overrides: Readonly<Record<string, string | number>>,
  name?: string,
): Promise<PluginFixture> {
  const fixture = await writePluginConfig(core, [{ label: PROJECT_LABEL, repo: ISSUE.repo, template: GITHUB_ISSUE_PROJECT }], {
    ...(name === undefined ? {} : { name }),
    overrides: { "github.endpoint": provider.endpoint, "github.gh_bin": provider.ghBin, ...overrides },
  });
  return { ...fixture, env: { ...fixture.env, NODE_EXTRA_CA_CERTS: provider.caFile } };
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

export async function inspect(core: CoreDaemon, sessionId: string): Promise<DaemonSession> {
  const inspected = await core.pohunek(["session", "inspect", sessionId, "--json"]);
  const envelope = JSON.parse(inspected.stdout) as { ok?: DaemonSession };
  if (envelope.ok === undefined) throw new Error(`session inspect failed: ${inspected.stdout}${inspected.stderr}`);
  return envelope.ok;
}

export async function sessions(core: CoreDaemon): Promise<DaemonSession[]> {
  const listed = await core.pohunek(["session", "list", "--json"]);
  const envelope = JSON.parse(listed.stdout) as { ok?: DaemonSession[] };
  if (envelope.ok === undefined) throw new Error(`session list failed: ${listed.stdout}${listed.stderr}`);
  return envelope.ok;
}

/** Polls until `predicate` holds for the session, or fails with the last state read. */
export async function waitForSession(core: CoreDaemon, sessionId: string, predicate: (session: DaemonSession) => boolean, timeoutMs: number): Promise<DaemonSession> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await inspect(core, sessionId);
    if (predicate(current)) return current;
    if (Date.now() > deadline) throw new Error(`session ${sessionId} did not reach the expected state: ${JSON.stringify(current)}`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

/** Starts a quiet session with `args` after `session new --agent quiet` and returns its id and worktree. */
export async function startSession(core: CoreDaemon, args: readonly string[]): Promise<{ id: string; worktree: string }> {
  const created = await core.pohunek(["session", "new", "--agent", QUIET_PROFILE, ...args, "--json"]);
  const id = (JSON.parse(created.stdout) as { ok?: { id?: unknown } }).ok?.id;
  if (typeof id !== "string") throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  const current = await inspect(core, id);
  if (current.worktree_path === undefined || current.worktree_path === null) throw new Error(`session ${id} has no worktree`);
  return { id, worktree: current.worktree_path };
}

/** Starts the issue's shell session in a worktree on `ISSUE_BRANCH`, pushes the branch and records its worktree. */
export async function startIssueSession(state: Setup): Promise<void> {
  const { id, worktree } = await startSession(state.core, [
    "--project", PROJECT_LABEL, "--branch", ISSUE_BRANCH, "--name", ISSUE_KEY, ...issueMetadata(state.github),
  ]);
  await git(worktree, ["push", "-q", state.origin, `${ISSUE_BRANCH}:${ISSUE_BRANCH}`]);
  state.sessionId = id;
  state.worktree = worktree;
}

/** Waits until the issue's session is running and idle, the state `do cleanup` accepts without stopping it first. */
export async function waitForIdle(state: Setup): Promise<void> {
  await waitForSession(state.core, state.sessionId, (s) => s.state === "running" && s.activity === "idle", IDLE_TIMEOUT_MS);
}

export async function stopSession(core: CoreDaemon, sessionId: string): Promise<void> {
  const stopped = await core.pohunek(["session", "stop", sessionId, "--json"]);
  if (!stopped.stdout.includes('"stopped": true')) throw new Error(`session stop failed: ${stopped.stdout}${stopped.stderr}`);
  await waitForSession(core, sessionId, (s) => s.state === "stopped", STOP_TIMEOUT_MS);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Rewrites the project's GitHub origin to `target` (by default the bare repository), which cleanup fetches the
 * branch from. It is done just before `do` because the daemon records the origin again when a session starts in
 * the repository (`session new --cwd` does), and the plugin only lists projects whose recorded origin is a GitHub URL.
 */
export async function routeOriginToBare(state: Setup, target: string = state.origin): Promise<void> {
  await git(state.repo, ["config", `url.${target}.insteadOf`, `git@github.com:${ISSUE.repo}.git`]);
}

/** Stops the daemon and checks that no session worker outlived it. */
export async function stopAndCheckWorkers(core: CoreDaemon): Promise<void> {
  await core.stop();
  expect(await workersBelow(core.runtimeDir)).toEqual([]);
}
