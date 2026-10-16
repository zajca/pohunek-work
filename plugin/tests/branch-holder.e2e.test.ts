// End-to-end scenarios of the branch-holder diagnosis against a real pohunekd from the pinned core release.
// `do <key> rebase` adopts the owner's conflicting pull request (answered by helpers/github-provider.ts) into a
// fresh worktree of its head branch, so it refuses while another worktree holds that branch and says what the
// owner can do about the holder. A session without `work.*` metadata is not linked to the row, so the plugin
// finds it through the session list (`adoptRefusal`); a worktree made by hand only appears in `project show`
// (`requireHeadBranchFree`). A finished holder is released only when every `cleanup` check passes on evidence read
// from real git, with the project's origin rewritten to a local bare repository, and `do` itself removes nothing.
import { afterEach, expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, runPlugin, type CliResult, type PluginFixture } from "./helpers/core-daemon.ts";
import {
  exists,
  git,
  IDLE_TIMEOUT_MS,
  inspect,
  ISSUE,
  ISSUE_BRANCH,
  PROJECT_LABEL,
  QUIET_PROFILE,
  releaseResources,
  routeOriginToBare,
  ROW_KEY,
  scenarioResources,
  sessions,
  setUpIssueProject,
  startSession,
  stopAndCheckWorkers,
  stopSession,
  waitForSession,
  writeIssueConfig,
  type Setup,
} from "./helpers/issue-session.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const EXIT_ERROR = 2;
/** The adopting action: its precondition holds for a pull request of the owner that conflicts with its base. */
const ACTION = "rebase";
/** The owner's conflicting pull request on the issue's branch; `branch_pattern` joins it to the issue's row. */
const PULL_REQUEST = {
  number: 12,
  title: ISSUE.title,
  headRefName: ISSUE_BRANCH,
  authorLogin: "alice",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  baseRefName: "main",
};
/** Display name of the session that holds the branch; it carries no `work.*` metadata. */
const HOLDER_NAME = "holder";
/** `[actions] holder_entries_listed`: the refusal lists this many dirty entries and counts the rest. */
const ENTRIES_LISTED = 3;
/**
 * `[actions] holder_entry_max_length`: quoted strings of the refusal are cut after this many characters. It also
 * bounds the holder's path, so it is longer than any worktree path below the daemon's private root.
 */
const ENTRY_MAX_LENGTH = 200;
/** An untracked file whose name is longer than `ENTRY_MAX_LENGTH`; a file name may have up to 255 bytes. */
const LONG_ENTRY = `a-${"x".repeat(ENTRY_MAX_LENGTH + 20)}`;
const ELLIPSIS = "...";
/** Ignored by the `.gitignore` the clean holder commits; it is lost with the worktree. */
const IGNORED_ENTRY = "build.log";
const NO_RELEASE = "No removal command is offered";
/** Name of the configuration whose `git_bin` starts a writer in the holder's worktree during the diagnosis. */
const STALE_CONFIG = "stale";
/** Display name of the session that starts in the holder's worktree while the evidence is read. */
const WRITER_NAME = "writer";

const resources = scenarioResources();

afterEach(async () => {
  await releaseResources(resources);
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

/** The bounds of the listed entries, which every configuration of these scenarios sets. */
const HOLDER_OVERRIDES = { "actions.holder_entries_listed": ENTRIES_LISTED, "actions.holder_entry_max_length": ENTRY_MAX_LENGTH };

async function setUp(): Promise<Setup> {
  return setUpIssueProject(resources, { pullRequest: PULL_REQUEST, overrides: HOLDER_OVERRIDES });
}

/** Starts the unlinked holder session on the issue's branch and waits until it is running and idle. */
async function startHolder(state: Setup): Promise<void> {
  const { id, worktree } = await startSession(state.core, ["--project", PROJECT_LABEL, "--branch", ISSUE_BRANCH, "--name", HOLDER_NAME]);
  state.sessionId = id;
  state.worktree = worktree;
  await waitForSession(state.core, id, (s) => s.state === "running" && s.activity === "idle", IDLE_TIMEOUT_MS);
}

async function push(state: Setup): Promise<void> {
  await git(state.worktree, ["push", "-q", state.origin, `${ISSUE_BRANCH}:${ISSUE_BRANCH}`]);
}

async function commit(state: Setup, path: string, text: string): Promise<void> {
  await writeFile(join(state.worktree, path), text);
  await git(state.worktree, ["add", path]);
  await git(state.worktree, ["commit", "-q", "-m", `Add ${path}`]);
}

async function sessionIds(state: Setup): Promise<string[]> {
  return (await sessions(state.core)).map((s) => s.id).sort();
}

async function adopt(fixture: PluginFixture): Promise<CliResult> {
  return runPlugin(fixture, ["do", ROW_KEY, ACTION, "--profile", QUIET_PROFILE, "--yes", "--json"], PROCESS_TIMEOUT_MS);
}

/** The message of the refusal `result` carries; fails unless it is a `precondition_failed` refusal. */
function refusal(result: CliResult): string {
  expect(result.code).toBe(EXIT_ERROR);
  const err = (JSON.parse(result.out) as { err: { code: string; msg: string } }).err;
  expect(err.code).toBe("precondition_failed");
  return err.msg;
}

/** The text the diagnosis starts with for a holder at `path`. */
function checkedOutIn(path: string): string {
  return `${ACTION} refused: ${JSON.stringify(ISSUE_BRANCH)} is already checked out in ${JSON.stringify(path)}`;
}

function heldBy(state: Setup, sessionState: string): string {
  return `${checkedOutIn(state.worktree)} by session ${JSON.stringify(state.sessionId)} (${JSON.stringify(sessionState)})`;
}

/** The worktree and the branch are still in place: `git worktree list` names the path and the branch resolves. */
async function expectWorktreeKept(state: Setup, path: string): Promise<void> {
  expect(await exists(path)).toBe(true);
  expect(await git(state.repo, ["worktree", "list", "--porcelain"])).toContain(`worktree ${path}\n`);
  await git(state.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${ISSUE_BRANCH}`]);
}

/** A finished holder that `do` saw stopped is still stopped, listed and holding its worktree. */
async function expectHolderKept(state: Setup, before: readonly string[]): Promise<void> {
  expect(await sessionIds(state)).toEqual([...before]);
  expect((await inspect(state.core, state.sessionId)).state).toBe("stopped");
  await expectWorktreeKept(state, state.worktree);
}

test("a worktree made by hand holds the branch: no session owns it and no release is offered", async () => {
  const state = await setUp();
  const manual = join(state.core.root, "manual-worktree");
  await git(state.repo, ["worktree", "add", "-q", "-b", ISSUE_BRANCH, manual]);
  await routeOriginToBare(state);

  const result = await adopt(state.fixture);

  expect(state.github.unexpectedOperations).toEqual([]);
  const msg = refusal(result);
  expect(msg).toContain(`${checkedOutIn(manual)}, which no pohunek session owns`);
  expect(msg).toContain("It is never offered for release.");
  expect(msg).not.toContain("pohunek session rm");
  expect(await sessionIds(state)).toEqual([]);
  await expectWorktreeKept(state, manual);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("a live session holds the branch: the refusal names it and advises attaching", async () => {
  const state = await setUp();
  await startHolder(state);
  await routeOriginToBare(state);
  const before = await sessionIds(state);

  const result = await adopt(state.fixture);

  expect(state.github.unexpectedOperations).toEqual([]);
  const msg = refusal(result);
  expect(msg).toBe(`${heldBy(state, "running")}; the session is live: attach with \`pohunek attach ${state.sessionId}\``);
  expect(await sessionIds(state)).toEqual(before);
  expect((await inspect(state.core, state.sessionId)).state).toBe("running");
  await expectWorktreeKept(state, state.worktree);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("a finished, clean and pushed session holds the branch: the release is offered and nothing is removed", async () => {
  const state = await setUp();
  await startHolder(state);
  await commit(state, ".gitignore", "*.log\n");
  await push(state);
  await writeFile(join(state.worktree, IGNORED_ENTRY), "ignored\n");
  await stopSession(state.core, state.sessionId);
  await routeOriginToBare(state);
  const before = await sessionIds(state);

  const result = await adopt(state.fixture);

  expect(state.github.unexpectedOperations).toEqual([]);
  const msg = refusal(result);
  expect(msg).toContain(`${heldBy(state, "stopped")}; when this was read the session was finished, its worktree clean and in sync with origin`);
  expect(msg).toContain(`so it can be released with \`pohunek session rm ${state.sessionId}\` (1 ignored entries are lost with the worktree)`);
  expect(msg).toContain("`do` itself removes nothing.");
  expect(msg).not.toContain("failed checks");
  await expectHolderKept(state, before);
  expect(await exists(join(state.worktree, IGNORED_ENTRY))).toBe(true);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("a finished session with uncommitted and untracked entries holds the branch: worktree_clean fails with a bounded list", async () => {
  const state = await setUp();
  await startHolder(state);
  await commit(state, "tracked.txt", "committed\n");
  await push(state);
  await writeFile(join(state.worktree, "tracked.txt"), "changed\n");
  const untracked = [LONG_ENTRY, "b-untracked.txt", "c-untracked.txt", "d-untracked.txt", "e-untracked.txt"];
  for (const name of untracked) await writeFile(join(state.worktree, name), "new\n");
  await stopSession(state.core, state.sessionId);
  await routeOriginToBare(state);
  const before = await sessionIds(state);

  const result = await adopt(state.fixture);

  expect(state.github.unexpectedOperations).toEqual([]);
  const msg = refusal(result);
  // git status lists tracked changes before untracked paths, each group in path order.
  const total = 1 + untracked.length;
  const shown = ["tracked.txt", `${LONG_ENTRY.slice(0, ENTRY_MAX_LENGTH)}${ELLIPSIS}`, "b-untracked.txt"].map((entry) => JSON.stringify(entry));
  expect(msg).toBe(
    `${heldBy(state, "stopped")}; it cannot be released safely, failed checks: ` +
      `worktree_clean (${JSON.stringify(`${String(total)} uncommitted or untracked entries; 0 ignored`)}). ` +
      `Uncommitted or untracked entries: ${shown.join(", ")} and ${String(total - ENTRIES_LISTED)} more. ` +
      `${NO_RELEASE}: commit and push or clean the worktree by hand, then retry.`,
  );
  expect(msg).not.toContain(LONG_ENTRY);
  await expectHolderKept(state, before);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("a finished session with an unpushed commit holds the branch: branch_in_sync fails and no release is offered", async () => {
  const state = await setUp();
  await startHolder(state);
  await push(state);
  await commit(state, "unpushed.txt", "local only\n");
  await stopSession(state.core, state.sessionId);
  await routeOriginToBare(state);
  const before = await sessionIds(state);

  const result = await adopt(state.fixture);

  expect(state.github.unexpectedOperations).toEqual([]);
  const msg = refusal(result);
  expect(msg).toContain(`${heldBy(state, "stopped")}; it cannot be released safely, failed checks: branch_in_sync ("1 ahead, 0 behind origin").`);
  expect(msg).toContain(NO_RELEASE);
  expect(msg).not.toContain("worktree_clean");
  expect(msg).not.toContain("pohunek session rm");
  await expectHolderKept(state, before);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

test("a finished session whose origin cannot be read holds the branch: the diagnosis fails closed", async () => {
  const state = await setUp();
  await startHolder(state);
  await push(state);
  await stopSession(state.core, state.sessionId);
  // The project's GitHub origin leads to a path that holds no repository, so the fetch fails without any network.
  await routeOriginToBare(state, join(state.core.root, "missing-origin.git"));
  const before = await sessionIds(state);

  const result = await adopt(state.fixture);

  expect(state.github.unexpectedOperations).toEqual([]);
  const msg = refusal(result);
  expect(msg).toContain(`${heldBy(state, "stopped")}; it cannot be released safely, failed checks: branch_in_sync ("fetching the branch from origin failed: git exited with code `);
  expect(msg).toContain(NO_RELEASE);
  expect(msg).not.toContain("pohunek session rm");
  await expectHolderKept(state, before);
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `[actions] git_bin` for the stale re-read: real git, except that the diagnosis's `rev-list` (its last git call,
 * after `session_finished`, `worktree_owned` and `worktree_not_shared` read the holder's worktree as unshared)
 * first starts a second session in that worktree through the pohunek CLI. Every check then passes on the
 * evidence, and only the re-read of the session list sees the new writer. Its `session new` answer is written to
 * `log`, so a failed start is reported as such.
 */
async function writerStartingGit(state: Setup, log: string): Promise<string> {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git is not on PATH");
  const pohunek = join(state.core.coreDir, "pohunek");
  const path = join(state.core.root, "writer-starting-git");
  const start = [pohunek, "session", "new", "--agent", QUIET_PROFILE, "--cwd", state.worktree, "--name", WRITER_NAME, "--json"];
  const script = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    `  if [ "$arg" = rev-list ] && [ ! -e ${shellQuote(log)} ]; then`,
    `    ${start.map(shellQuote).join(" ")} > ${shellQuote(log)} 2>&1`,
    "  fi",
    "done",
    `exec ${shellQuote(realGit)} "$@"`,
    "",
  ].join("\n");
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

test("a writer that starts in the finished holder's worktree before the re-read makes the evidence stale", async () => {
  const state = await setUp();
  await startHolder(state);
  await push(state);
  await stopSession(state.core, state.sessionId);
  const log = join(state.core.root, "writer.json");
  const gitBin = await writerStartingGit(state, log);
  const fixture = await writeIssueConfig(state.core, state.github, { ...HOLDER_OVERRIDES, "actions.git_bin": gitBin }, STALE_CONFIG);
  await routeOriginToBare(state);
  const before = await sessionIds(state);

  const result = await adopt(fixture);

  expect(state.github.unexpectedOperations).toEqual([]);
  const started = await Bun.file(log).text();
  const created = (JSON.parse(started) as { ok?: { id?: unknown; cwd?: unknown } }).ok;
  const writer = created?.id;
  if (typeof writer !== "string") throw new Error(`the writer session did not start: ${started}`);
  // The daemon records the writer's cwd at creation, so the re-read that follows already lists it as a sharer.
  expect(created?.cwd).toBe(state.worktree);
  const msg = refusal(result);
  const stale = `worktree_not_shared: 1 other session(s) that are not finished use the worktree: ${JSON.stringify(writer)}`;
  expect(msg).toContain(`${heldBy(state, "stopped")}; it cannot be released safely, failed checks: evidence_stale (${JSON.stringify(stale)}).`);
  expect(msg).toContain(NO_RELEASE);
  expect(msg).not.toContain("pohunek session rm");
  await expectHolderKept(state, [...before, writer].sort());
  await stopAndCheckWorkers(state.core);
}, SCENARIO_TIMEOUT_MS);
