// End-to-end scenarios of the evidence checks of `pohunek-work do <key> cleanup` against a real pohunekd from the
// pinned core release. The issue's session runs in a worktree the daemon creates, linked to GitHub issue
// acme/widgets#7 (helpers/issue-session.ts), and every check reads real git and the real daemon. Each scenario
// makes one check fail, reads the check's detail from `--dry-run`, and asserts that `--yes` refuses with exactly
// the failed checks and removes nothing: the session stays listed in its state, its worktree and branch stay.
// The removal of a session whose checks all pass is covered by cleanup-stopped-owner.e2e.test.ts.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, installAgentProfile, runPlugin, type CliResult, type CoreDaemon, type PluginFixture } from "./helpers/core-daemon.ts";
import {
  exists,
  git,
  IDLE_TIMEOUT_MS,
  inspect,
  ISSUE_BRANCH,
  QUIET_PROFILE,
  releaseResources,
  routeOriginToBare,
  ROW_KEY,
  scenarioResources,
  sessions,
  setUpIssueProject,
  startIssueSession,
  stopAndCheckWorkers,
  waitForIdle,
  waitForSession,
  writeIssueConfig,
  type Setup,
} from "./helpers/issue-session.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 100;
const EXIT_ERROR = 2;
/**
 * Host agent profile based on `claude` whose program shows claude's tool-approval prompt and then sleeps. The
 * daemon's claude screen detection reports such a session as activity `blocked`, and after its attention debounce
 * it records an unread `agent_blocked` notification for it.
 */
const APPROVAL_PROFILE = "approval";
const APPROVAL_PROMPT = "Do you want to proceed?\\n\\u276f 1. Yes\\n  2. No, and tell Claude what to do differently (esc)\\n";
/** How long the approval agent sleeps; longer than any scenario, the daemon's stop ends it. */
const APPROVAL_SLEEP_SECS = 3600;
/** Upper bound for the daemon to report the approval session blocked and to record its notification. */
const BLOCKED_TIMEOUT_MS = 30_000;
/** `session diff` stops at 512 KiB and reports itself truncated; a committed file larger than that exceeds it. */
const LARGE_FILE_BYTES = 600 * 1024;
/** Exit status of the `git status` the failing git wrapper refuses. */
const STATUS_EXIT = 3;
/** Display name of a session that starts in the issue's worktree without being linked to the issue. */
const SHARER_NAME = "sharer";
/** Name of the configurations whose `git_bin` is a wrapper; they share the daemon and the GitHub server. */
const WRAPPED_CONFIG = "wrapped-git";

interface CheckJson {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const resources = scenarioResources();

afterEach(async () => {
  await releaseResources(resources);
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

/** The issue's quiet session, pushed to origin and idle, so every check passes until a scenario breaks one. */
async function idleIssueSession(): Promise<Setup> {
  const state = await setUpIssueProject(resources);
  await startIssueSession(state);
  await waitForIdle(state);
  return state;
}

async function commit(state: Setup, path: string, text: string): Promise<void> {
  await writeFile(join(state.worktree, path), text);
  await git(state.worktree, ["add", path]);
  await git(state.worktree, ["commit", "-q", "-m", `Add ${path}`]);
}

async function push(state: Setup): Promise<void> {
  await git(state.worktree, ["push", "-q", state.origin, `${ISSUE_BRANCH}:${ISSUE_BRANCH}`]);
}

async function cleanup(fixture: PluginFixture, mode: "--dry-run" | "--yes"): Promise<CliResult> {
  return runPlugin(fixture, ["do", ROW_KEY, "cleanup", mode, "--json"], PROCESS_TIMEOUT_MS);
}

/** The checks of the plan `--dry-run` prints, after asserting that it is not eligible. */
async function plannedChecks(fixture: PluginFixture): Promise<readonly CheckJson[]> {
  const result = await cleanup(fixture, "--dry-run");
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const plan = (JSON.parse(result.out) as { ok: { plan: { eligible: boolean; checks: CheckJson[] } } }).ok.plan;
  expect(plan.eligible).toBe(false);
  return plan.checks;
}

function failing(checks: readonly CheckJson[]): Record<string, string> {
  return Object.fromEntries(checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]));
}

/** The message of the refusal `result` carries; fails unless it is a `precondition_failed` refusal. */
function refusal(result: CliResult): string {
  expect(result.code).toBe(EXIT_ERROR);
  const err = (JSON.parse(result.out) as { err: { code: string; msg: string } }).err;
  expect(err.code).toBe("precondition_failed");
  return err.msg;
}

function refusedBeforeStop(names: readonly string[]): string {
  return `cleanup refused: failed checks: ${names.join(", ")}; nothing was stopped or removed`;
}

async function sessionIds(core: CoreDaemon): Promise<string[]> {
  return (await sessions(core)).map((s) => s.id).sort();
}

/** Nothing was removed: the same sessions are listed, the issue's session is in `sessionState`, its worktree and branch stay. */
async function expectNothingRemoved(state: Setup, before: readonly string[], sessionState: string): Promise<void> {
  expect(await sessionIds(state.core)).toEqual([...before]);
  expect((await inspect(state.core, state.sessionId)).state).toBe(sessionState);
  expect(await exists(state.worktree)).toBe(true);
  expect(await git(state.repo, ["worktree", "list", "--porcelain"])).toContain(`worktree ${state.worktree}\n`);
  await git(state.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${ISSUE_BRANCH}`]);
}

/**
 * Runs `--dry-run` and `--yes` against a session whose checks `expected` (name to detail) fail and no other, and
 * asserts the refusal and that nothing was removed or stopped.
 */
async function expectRefusedBeforeStop(state: Setup, expected: Readonly<Record<string, string>>, fixture: PluginFixture = state.fixture): Promise<void> {
  const before = await sessionIds(state.core);
  const sessionState = (await inspect(state.core, state.sessionId)).state;

  expect(failing(await plannedChecks(fixture))).toEqual(expected);
  const msg = refusal(await cleanup(fixture, "--yes"));

  expect(state.github.unexpectedOperations).toEqual([]);
  expect(msg).toBe(refusedBeforeStop(Object.keys(expected)));
  await expectNothingRemoved(state, before, sessionState);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Writes `[actions] git_bin` as a `/bin/sh` wrapper of real git: before git runs, `hook` (shell text) runs when the
 * arguments contain `trigger`, on its `nth` such call across every process the configuration runs, or on every
 * one. It is a timing hook, not a fake: git is real, and the hook acts through real git, the file system or the
 * pinned pohunek CLI at a deterministic point of the evidence.
 */
async function wrappedGit(state: Setup, name: string, trigger: string, nth: number | "every", hook: string): Promise<string> {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git is not on PATH");
  const path = join(state.core.root, name);
  const counter = join(state.core.root, `${name}.count`);
  const script = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    `  if [ "$arg" = ${shellQuote(trigger)} ]; then`,
    "    seen=0",
    `    [ -e ${shellQuote(counter)} ] && read -r seen < ${shellQuote(counter)}`,
    "    seen=$((seen + 1))",
    `    echo "$seen" > ${shellQuote(counter)}`,
    `    if ${nth === "every" ? "true" : `[ "$seen" -eq ${String(nth)} ]`}; then`,
    `      ${hook}`,
    "    fi",
    "    break",
    "  fi",
    "done",
    `exec ${shellQuote(realGit)} "$@"`,
    "",
  ].join("\n");
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function wrappedConfig(state: Setup, gitBin: string): Promise<PluginFixture> {
  return writeIssueConfig(state.core, state.github, { "actions.git_bin": gitBin }, WRAPPED_CONFIG);
}

/** Starts a session of agent profile `agent` with its cwd in the issue's worktree and no link to the issue. */
async function startSharer(state: Setup, agent: string): Promise<string> {
  const created = await state.core.pohunek(["session", "new", "--agent", agent, "--cwd", state.worktree, "--name", SHARER_NAME, "--json"]);
  const id = (JSON.parse(created.stdout) as { ok?: { id?: unknown } }).ok?.id;
  if (typeof id !== "string") throw new Error(`session new --cwd failed: ${created.stdout}${created.stderr}`);
  await waitForSession(state.core, id, (s) => s.cwd === state.worktree, IDLE_TIMEOUT_MS);
  return id;
}

async function installApprovalAgent(core: CoreDaemon): Promise<void> {
  const sleep = Bun.which("sleep");
  if (sleep === null) throw new Error("sleep is not on PATH; the approval agent profile needs it");
  await installAgentProfile(core, APPROVAL_PROFILE, `#!/bin/sh\nprintf '${APPROVAL_PROMPT}'\nexec ${sleep} ${String(APPROVAL_SLEEP_SECS)}\n`, "claude");
}

/** Polls until the daemon lists an unread `agent_blocked` notification of `sessionId`. */
async function waitForBlockedNotification(core: CoreDaemon, sessionId: string): Promise<void> {
  const deadline = Date.now() + BLOCKED_TIMEOUT_MS;
  for (;;) {
    const listed = await core.pohunek(["notifications", "list", "--status", "unread", "--json"]);
    const envelope = JSON.parse(listed.stdout) as { ok?: { notifications: { kind: string; session_id?: string }[] } };
    if (envelope.ok === undefined) throw new Error(`notifications list failed: ${listed.stdout}${listed.stderr}`);
    if (envelope.ok.notifications.some((n) => n.kind === "agent_blocked" && n.session_id === sessionId)) return;
    if (Date.now() > deadline) throw new Error(`no unread agent_blocked notification of ${sessionId}: ${listed.stdout}`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

test("worktree_clean fails for an uncommitted change and an untracked file", async () => {
  const state = await idleIssueSession();
  await commit(state, "tracked.txt", "committed\n");
  await push(state);
  await writeFile(join(state.worktree, "tracked.txt"), "changed\n");
  await writeFile(join(state.worktree, "untracked.txt"), "new\n");
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, { worktree_clean: "2 uncommitted or untracked entries; 0 ignored" });
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("worktree_clean fails for an entry marked assume-unchanged, whose edit status does not show", async () => {
  const state = await idleIssueSession();
  await commit(state, "tracked.txt", "committed\n");
  await push(state);
  await git(state.worktree, ["update-index", "--assume-unchanged", "tracked.txt"]);
  await writeFile(join(state.worktree, "tracked.txt"), "hidden edit\n");
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, {
    worktree_clean: "1 tracked entries are marked assume-unchanged or skip-worktree, so status cannot show their edits",
  });
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("worktree_clean fails for a submodule, whose state is not verified", async () => {
  const state = await idleIssueSession();
  const head = (await git(state.worktree, ["rev-parse", "HEAD"])).trim();
  // The empty directory is what a checkout of a repository with an uninitialized submodule holds.
  await mkdir(join(state.worktree, "vendor", "lib"), { recursive: true });
  await git(state.worktree, ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/lib`]);
  await git(state.worktree, ["commit", "-q", "-m", "Add a submodule entry"]);
  await push(state);
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, { worktree_clean: "the worktree contains submodules; their state is not verified" });
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("branch_in_sync fails for a commit that is not pushed", async () => {
  const state = await idleIssueSession();
  await commit(state, "unpushed.txt", "local only\n");
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, { branch_in_sync: "1 ahead, 0 behind origin" });
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("branch_in_sync fails when someone else pushed to the branch", async () => {
  const state = await idleIssueSession();
  const other = join(state.core.root, "other-clone");
  await git(state.core.root, ["clone", "-q", "--branch", ISSUE_BRANCH, state.origin, other]);
  await writeFile(join(other, "theirs.txt"), "pushed by someone else\n");
  await git(other, ["add", "theirs.txt"]);
  await git(other, ["commit", "-q", "-m", "Add theirs.txt"]);
  await git(other, ["push", "-q", "origin", `${ISSUE_BRANCH}:${ISSUE_BRANCH}`]);
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, { branch_in_sync: "0 ahead, 1 behind origin" });
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("branch_in_sync fails closed when the origin cannot be fetched", async () => {
  const state = await idleIssueSession();
  // The project's GitHub origin leads to a path that holds no repository, so the fetch fails without any network.
  await routeOriginToBare(state, join(state.core.root, "missing-origin.git"));

  await expectRefusedBeforeStop(state, { branch_in_sync: "fetching the branch from origin failed: git exited with code 128" });
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("worktree_not_shared fails for a second session that runs in the worktree", async () => {
  const state = await idleIssueSession();
  const sharer = await startSharer(state, QUIET_PROFILE);
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, {
    worktree_not_shared: `1 other session(s) that are not finished use the worktree: ${JSON.stringify(sharer)}`,
  });
  expect((await inspect(state.core, sharer)).state).toBe("running");
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("not_awaiting_owner fails for a session that waits on an approval", async () => {
  const state = await setUpIssueProject(resources);
  await installApprovalAgent(state.core);
  await startIssueSession(state, APPROVAL_PROFILE);
  await waitForSession(state.core, state.sessionId, (s) => s.state === "running" && s.activity === "blocked", BLOCKED_TIMEOUT_MS);
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, {
    session_finished: 'session state is "running" with activity "blocked"; only a finished or idle session is cleaned up',
    not_awaiting_owner: "the session is blocked and waits for the owner",
  });
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("not_awaiting_owner fails for a pending agent_blocked notification of a session sharing the worktree", async () => {
  const state = await idleIssueSession();
  await installApprovalAgent(state.core);
  const sharer = await startSharer(state, APPROVAL_PROFILE);
  await waitForBlockedNotification(state.core, sharer);
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, {
    worktree_not_shared: `1 other session(s) that are not finished use the worktree: ${JSON.stringify(sharer)}`,
    not_awaiting_owner: "1 agent_blocked or approval_required notification(s) name the session or a session sharing its worktree",
  });
  expect((await inspect(state.core, sharer)).state).toBe("running");
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("diff_complete fails when the session diff is truncated", async () => {
  const state = await idleIssueSession();
  await commit(state, "large.txt", `${"x".repeat(LARGE_FILE_BYTES - 1)}\n`);
  await push(state);
  await routeOriginToBare(state);

  const before = await sessionIds(state.core);
  const failed = failing(await plannedChecks(state.fixture));
  expect(Object.keys(failed)).toEqual(["diff_complete"]);
  expect(failed["diff_complete"]).toMatch(/^session diff is truncated at \d+ bytes, so it does not show every change$/);
  expect(refusal(await cleanup(state.fixture, "--yes"))).toBe(refusedBeforeStop(["diff_complete"]));
  expect(state.github.unexpectedOperations).toEqual([]);
  await expectNothingRemoved(state, before, "running");
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("a git_bin that cannot start fails worktree_clean and branch_in_sync closed", async () => {
  const state = await idleIssueSession();
  const fixture = await wrappedConfig(state, join(state.core.root, "missing", "git"));
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, {
    worktree_clean: "git rev-parse failed: git could not start",
    branch_in_sync: "cannot read the worktree branch (detached head or git failure): git could not start",
  }, fixture);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("a failing git status fails worktree_clean closed", async () => {
  const state = await idleIssueSession();
  const gitBin = await wrappedGit(state, "status-failing-git", "status", "every", `exit ${String(STATUS_EXIT)}`);
  const fixture = await wrappedConfig(state, gitBin);
  await routeOriginToBare(state);

  await expectRefusedBeforeStop(state, { worktree_clean: `git status failed: git exited with code ${String(STATUS_EXIT)}` }, fixture);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("a file written after the plan read the worktree is caught by the checks after the stop", async () => {
  const state = await idleIssueSession();
  // The plan's `rev-list` runs after its `git status`, so the file appears after the plan saw a clean worktree.
  const late = join(state.worktree, "late.txt");
  const gitBin = await wrappedGit(state, "late-writer-git", "rev-list", 1, `echo late > ${shellQuote(late)}`);
  const fixture = await wrappedConfig(state, gitBin);
  await routeOriginToBare(state);
  const before = await sessionIds(state.core);

  const msg = refusal(await cleanup(fixture, "--yes"));

  expect(state.github.unexpectedOperations).toEqual([]);
  expect(msg).toBe("cleanup refused after the stop: failed checks: worktree_clean; the session stays stopped and nothing was removed");
  await expectNothingRemoved(state, before, "stopped");
  expect(await exists(late)).toBe(true);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("a session that starts in the worktree after the checks after the stop is caught right before the removal", async () => {
  const state = await idleIssueSession();
  // The second `rev-list` belongs to the checks after the stop; the writer starts after they read the session list.
  const log = join(state.core.root, "writer.json");
  const pohunek = join(state.core.coreDir, "pohunek");
  const start = [pohunek, "session", "new", "--agent", QUIET_PROFILE, "--cwd", state.worktree, "--name", SHARER_NAME, "--json"];
  const gitBin = await wrappedGit(state, "writer-starting-git", "rev-list", 2, `${start.map(shellQuote).join(" ")} > ${shellQuote(log)} 2>&1`);
  const fixture = await wrappedConfig(state, gitBin);
  await routeOriginToBare(state);
  const before = await sessionIds(state.core);

  const msg = refusal(await cleanup(fixture, "--yes"));

  expect(state.github.unexpectedOperations).toEqual([]);
  const started = await Bun.file(log).text();
  const created = (JSON.parse(started) as { ok?: { id?: unknown; cwd?: unknown } }).ok;
  const writer = created?.id;
  if (typeof writer !== "string") throw new Error(`the writer session did not start: ${started}`);
  // The daemon records the writer's cwd at creation, so the re-read that follows already lists it as a sharer.
  expect(created?.cwd).toBe(state.worktree);
  expect(msg).toBe(
    `cleanup refused just before the removal: worktree_not_shared: 1 other session(s) that are not finished use the worktree: ${JSON.stringify(writer)}; ` +
      "the session stays stopped and nothing was removed",
  );
  await expectNothingRemoved(state, [...before, writer].sort(), "stopped");
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);
