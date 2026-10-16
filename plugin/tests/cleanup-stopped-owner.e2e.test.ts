// End-to-end scenarios of `pohunek-work do <key> cleanup` against a real pohunekd from the pinned core release.
// The issue's session is a shell-like session (profile `quiet`) in a worktree the daemon creates, linked to the
// GitHub issue through its metadata. `do` reads the issue from the local GraphQL server
// (helpers/github-provider.ts); the branch is pushed to a bare repository under the daemon's root, and git
// rewrites the project's GitHub origin to that repository for the fetch cleanup makes. Core drops `session_id`
// from a worktree's entry in `project show` once its session stops, and these scenarios run the ownership check
// after such a real stop. The shared setup lives in helpers/issue-session.ts.
import { afterEach, expect, test } from "bun:test";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, runPlugin, type CliResult } from "./helpers/core-daemon.ts";
import {
  exists,
  IDLE_TIMEOUT_MS,
  inspect,
  QUIET_PROFILE,
  releaseResources,
  routeOriginToBare,
  ROW_KEY,
  scenarioResources,
  sessions,
  setUpIssueProject,
  startIssueSession,
  stopAndCheckWorkers,
  stopSession,
  waitForIdle,
  waitForSession,
  type Setup,
} from "./helpers/issue-session.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 180_000;
const EXIT_ERROR = 2;
/** A session that is not linked to the issue but starts in the same worktree, so it claims the path. */
const SQUATTER_NAME = "squatter";

const resources = scenarioResources();

afterEach(async () => {
  await releaseResources(resources);
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

/** A daemon with project widgets whose origin is a local bare repository holding `main`, and the GitHub issue. */
async function setUp(): Promise<Setup> {
  return setUpIssueProject(resources);
}

async function cleanup(state: Setup, extra: readonly string[]): Promise<CliResult> {
  await routeOriginToBare(state);
  return runPlugin(state.fixture, ["do", ROW_KEY, "cleanup", ...extra, "--json"], PROCESS_TIMEOUT_MS);
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


