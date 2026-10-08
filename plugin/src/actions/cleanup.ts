// `cleanup`: stops and removes a finished session together with its worktree.
// `session rm` force-removes the worktree, so every check reads evidence first,
// fails closed on anything uncertain, and runs again after the stop, because the
// agent can write until it has stopped. Messages are static or carry numbers:
// git and pohunek output never reaches them.
import { isAbsolute } from "node:path";
import type { CollectedRow } from "../commands/list.ts";
import type { PohunekClient } from "../sources/pohunek.ts";
import type { PluginConfig } from "../types/config.ts";
import type { PohunekSession, SourceResult } from "../types/sources.ts";
import { SpawnError, type Exec } from "../util/exec.ts";
import { ActionError } from "./types.ts";

/** A session id as pohunek prints it; never an option, since it is passed as an argv value. */
const SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

/** A branch that is safe inside a refspec and as an argv value: no option, no refspec or glob syntax. */
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const TERMINAL_STATES: readonly string[] = ["stopped", "done", "failed"];

export const CHECK_NAMES = [
  "session_finished",
  "worktree_owned",
  "worktree_clean",
  "branch_in_sync",
  "worktree_not_shared",
  "not_awaiting_owner",
  "diff_complete",
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

export interface CleanupCheck {
  readonly name: CheckName;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CleanupSharer {
  readonly sessionId: string;
  readonly state: string;
}

export interface CleanupInventory {
  /** Ignored files of the worktree; they are lost with it. */
  readonly ignored: readonly string[];
  /** Commits only the worktree has; null when not measured. */
  readonly ahead: number | null;
  /** Commits only the remote has; null when not measured. */
  readonly behind: number | null;
  /** Base of `session diff`; null when the diff was not read. */
  readonly base: string | null;
  readonly diffBytes: number | null;
  /** Other sessions whose worktree or cwd is the worktree of the target. */
  readonly sharers: readonly CleanupSharer[];
}

export interface CleanupPlan {
  readonly action: "cleanup";
  readonly key: string;
  readonly project: string;
  readonly sessionId: string;
  readonly state: string;
  readonly worktreePath: string;
  readonly branch: string;
  /** Every check holds. */
  readonly eligible: boolean;
  readonly checks: readonly CleanupCheck[];
  readonly inventory: CleanupInventory;
  readonly stopArgv: readonly string[];
  readonly removeArgv: readonly string[];
}

export interface CleanupResult {
  readonly sessionId: string;
  /** `session stop` ran because the session was still running. */
  readonly stopped: boolean;
  readonly removed: true;
  readonly worktreesRemoved: number;
  readonly verifiedAbsent: true;
}

export interface CleanupDeps {
  readonly pohunek: PohunekClient;
  /** Runs git. */
  readonly exec: Exec;
}

interface Evidence {
  readonly checks: readonly CleanupCheck[];
  readonly inventory: CleanupInventory;
}

interface Target {
  readonly id: string;
  readonly project: string;
  readonly worktreePath: string;
  readonly branch: string;
}

function isTerminal(state: string): boolean {
  return TERMINAL_STATES.includes(state);
}

function describeFailure(result: { readonly ok: false; readonly code: string }): string {
  return `pohunek did not answer (${result.code})`;
}

// ------------------------------------------------------------------- git

type GitOutcome = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string };

async function git(deps: CleanupDeps, config: PluginConfig, worktreePath: string, args: readonly string[], timeoutMs: number): Promise<GitOutcome> {
  const argv = [config.global.actions.gitBin, "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", worktreePath, ...args];
  try {
    const result = await deps.exec(argv, { timeoutMs });
    if (result.timedOut) return { ok: false, reason: `git timed out after ${String(timeoutMs)} ms` };
    if (result.exitCode !== 0) return { ok: false, reason: `git exited with code ${String(result.exitCode)}` };
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    if (error instanceof SpawnError) return { ok: false, reason: "git could not start" };
    throw error;
  }
}

interface StatusEntries {
  readonly dirty: number;
  readonly ignored: readonly string[];
}

/**
 * Parses `git status --porcelain=v1 -z`: records are `XY path` separated by NUL, and a
 * rename or copy record is followed by one extra field (its origin path). Null when the
 * output is not exactly that format.
 */
export function parseStatus(stdout: string): StatusEntries | null {
  if (stdout === "") return { dirty: 0, ignored: [] };
  if (!stdout.endsWith("\0")) return null;
  const fields = stdout.slice(0, -1).split("\0");
  let dirty = 0;
  const ignored: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field.length < 4 || field[2] !== " ") return null;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code === "!!") {
      ignored.push(path);
      continue;
    }
    dirty += 1;
    if (code.includes("R") || code.includes("C")) {
      index += 1;
      if (index >= fields.length) return null;
    }
  }
  return { dirty, ignored };
}

// ---------------------------------------------------------------- checks

function sessionFinished(session: PohunekSession): CleanupCheck {
  const { state, activity } = session;
  if (isTerminal(state)) return { name: "session_finished", ok: true, detail: `session state is ${state}` };
  if (state === "running" && activity === "idle") {
    return { name: "session_finished", ok: true, detail: "session is running and idle; it is stopped first" };
  }
  return { name: "session_finished", ok: false, detail: `session state is ${state} with activity ${activity ?? "none"}; only a finished or idle session is cleaned up` };
}

async function worktreeOwned(target: Target, deps: CleanupDeps): Promise<CleanupCheck> {
  const name = "worktree_owned";
  const worktrees = await deps.pohunek.listWorktrees(target.project);
  if (!worktrees.ok) return { name, ok: false, detail: describeFailure(worktrees) };
  const owned = worktrees.data.some((w) => w.path === target.worktreePath && w.sessionId === target.id);
  return owned
    ? { name, ok: true, detail: "project show lists the worktree as owned by the session" }
    : { name, ok: false, detail: "project show does not list the worktree as owned by the session" };
}

async function worktreeClean(target: Target, config: PluginConfig, deps: CleanupDeps): Promise<{ check: CleanupCheck; ignored: readonly string[] }> {
  const name = "worktree_clean";
  // A worktree whose own `.git` is gone would be read through a parent repository.
  const prefix = await git(deps, config, target.worktreePath, ["rev-parse", "--show-prefix"], config.global.actions.gitTimeoutMs);
  if (!prefix.ok) return { check: { name, ok: false, detail: `git rev-parse failed: ${prefix.reason}` }, ignored: [] };
  if (prefix.stdout.replace(/\n$/, "") !== "") {
    return { check: { name, ok: false, detail: "the path is only a subdirectory of another repository, not a worktree root" }, ignored: [] };
  }
  const status = await git(deps, config, target.worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"], config.global.actions.gitTimeoutMs);
  if (!status.ok) return { check: { name, ok: false, detail: `git status failed: ${status.reason}` }, ignored: [] };
  const entries = parseStatus(status.stdout);
  if (entries === null) return { check: { name, ok: false, detail: "git status output could not be parsed" }, ignored: [] };
  if (entries.dirty > 0) {
    return {
      check: { name, ok: false, detail: `${String(entries.dirty)} uncommitted or untracked entries; ${String(entries.ignored.length)} ignored` },
      ignored: entries.ignored,
    };
  }
  return { check: { name, ok: true, detail: `no uncommitted or untracked entries; ${String(entries.ignored.length)} ignored entries are lost with the worktree` }, ignored: entries.ignored };
}

async function branchInSync(
  target: Target,
  config: PluginConfig,
  deps: CleanupDeps,
): Promise<{ check: CleanupCheck; ahead: number | null; behind: number | null }> {
  const name = "branch_in_sync";
  const { gitTimeoutMs, cleanupTimeoutMs, cleanupRemote: remote } = config.global.actions;
  const unmeasured = (detail: string): { check: CleanupCheck; ahead: null; behind: null } => ({ check: { name, ok: false, detail }, ahead: null, behind: null });

  const head = await git(deps, config, target.worktreePath, ["symbolic-ref", "--short", "HEAD"], gitTimeoutMs);
  if (!head.ok) return unmeasured(`cannot read the worktree branch (detached head or git failure): ${head.reason}`);
  if (head.stdout.replace(/\n$/, "") !== target.branch) return unmeasured("the worktree branch differs from the session branch");

  const fetched = await git(
    deps,
    config,
    target.worktreePath,
    ["fetch", remote, `+refs/heads/${target.branch}:refs/remotes/${remote}/${target.branch}`],
    cleanupTimeoutMs,
  );
  if (!fetched.ok) return unmeasured(`fetching the branch from ${remote} failed: ${fetched.reason}`);

  const counts = await git(deps, config, target.worktreePath, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/${remote}/${target.branch}`], gitTimeoutMs);
  if (!counts.ok) return unmeasured(`comparing with ${remote} failed: ${counts.reason}`);
  const match = /^(\d+)\t(\d+)\n?$/.exec(counts.stdout);
  if (match === null) return unmeasured("git rev-list output could not be parsed");
  const ahead = Number(match[1]);
  const behind = Number(match[2]);
  const detail = `${String(ahead)} ahead, ${String(behind)} behind ${remote}`;
  return { check: { name, ok: ahead === 0 && behind === 0, detail }, ahead, behind };
}

function within(path: string, directory: string): boolean {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return path === directory || path.startsWith(prefix);
}

function sharersOf(target: Target, sessions: readonly PohunekSession[]): readonly PohunekSession[] {
  return sessions.filter(
    (s) =>
      s.id !== target.id &&
      ((s.worktreePath !== null && within(s.worktreePath, target.worktreePath)) || (s.cwd !== null && within(s.cwd, target.worktreePath))),
  );
}

function worktreeNotShared(sharers: readonly PohunekSession[]): CleanupCheck {
  const name = "worktree_not_shared";
  const live = sharers.filter((s) => !isTerminal(s.state));
  if (live.length > 0) {
    return { name, ok: false, detail: `${String(live.length)} other session(s) that are not finished use the worktree: ${live.map((s) => s.id).join(", ")}` };
  }
  if (sharers.length > 0) {
    return { name, ok: true, detail: `only finished sessions also point at the worktree: ${sharers.map((s) => s.id).join(", ")}` };
  }
  return { name, ok: true, detail: "no other session uses the worktree" };
}

async function notAwaitingOwner(session: PohunekSession, sharers: readonly PohunekSession[], deps: CleanupDeps): Promise<CleanupCheck> {
  const name = "not_awaiting_owner";
  if (session.activity === "blocked") return { name, ok: false, detail: "the session is blocked and waits for the owner" };
  const notifications = await deps.pohunek.listNotifications();
  if (!notifications.ok) return { name, ok: false, detail: describeFailure(notifications) };
  const ids = new Set([session.id, ...sharers.map((s) => s.id)]);
  const pending = notifications.data.filter(
    (n) =>
      n.sessionId !== null &&
      ids.has(n.sessionId) &&
      (n.kind === "agent_blocked" || n.kind === "approval_required") &&
      (n.status === "unread" || n.status === "read"),
  );
  return pending.length > 0
    ? { name, ok: false, detail: `${String(pending.length)} agent_blocked or approval_required notification(s) name the session or a session sharing its worktree` }
    : { name, ok: true, detail: "no pending notification names the session" };
}

async function diffComplete(target: Target, config: PluginConfig, deps: CleanupDeps): Promise<{ check: CleanupCheck; base: string | null; diffBytes: number | null }> {
  const name = "diff_complete";
  const diff = await deps.pohunek.diffSession(target.id, config.global.actions.cleanupTimeoutMs);
  if (!diff.ok) return { check: { name, ok: false, detail: `session diff failed: ${describeFailure(diff)}` }, base: null, diffBytes: null };
  const { base, truncated, diffBytes } = diff.data;
  return {
    check: truncated
      ? { name, ok: false, detail: `session diff is truncated at ${String(diffBytes)} bytes, so it does not show every change` }
      : { name, ok: true, detail: `session diff is complete (${String(diffBytes)} bytes)` },
    base,
    diffBytes,
  };
}

/** Runs every check against fresh reads; no check is skipped when another failed. */
async function gatherEvidence(
  session: PohunekSession,
  target: Target,
  sessions: readonly PohunekSession[],
  config: PluginConfig,
  deps: CleanupDeps,
): Promise<Evidence> {
  const finished = sessionFinished(session);
  const owned = await worktreeOwned(target, deps);
  const clean = await worktreeClean(target, config, deps);
  const sync = await branchInSync(target, config, deps);
  const sharers = sharersOf(target, sessions);
  const notShared = worktreeNotShared(sharers);
  const awaiting = await notAwaitingOwner(session, sharers, deps);
  const diff = await diffComplete(target, config, deps);
  return {
    checks: [finished, owned, clean.check, sync.check, notShared, awaiting, diff.check],
    inventory: {
      ignored: clean.ignored,
      ahead: sync.ahead,
      behind: sync.behind,
      base: diff.base,
      diffBytes: diff.diffBytes,
      sharers: sharers.map((s) => ({ sessionId: s.id, state: s.state })),
    },
  };
}

// ------------------------------------------------------------------ plan

function validTarget(session: PohunekSession, project: string): Target {
  const { worktreePath, branch } = session;
  if (!SESSION_ID.test(session.id)) {
    throw new ActionError("invalid_value", `session id ${JSON.stringify(session.id)} is not a pohunek session id`);
  }
  if (worktreePath === null || !isAbsolute(worktreePath) || CONTROL_CHARACTER.test(worktreePath)) {
    throw new ActionError("invalid_value", `the worktree path of session ${session.id} is not an absolute path`);
  }
  if (branch === null || !BRANCH.test(branch) || branch.includes("..") || branch.includes("//") || /[/.]$/.test(branch) || branch.endsWith(".lock")) {
    throw new ActionError("invalid_value", `the branch of session ${session.id} is missing or not a plain branch name`);
  }
  return { id: session.id, project, worktreePath, branch };
}

/** Reads the evidence for the one linked session that owns a worktree; changes nothing. */
export async function planCleanup(
  row: CollectedRow,
  sessions: readonly PohunekSession[],
  config: PluginConfig,
  deps: CleanupDeps,
): Promise<CleanupPlan> {
  const pohunek = row.listItem.sources.pohunek;
  // Without pohunek data the row has no sessions, which is not the same as no session.
  if (pohunek !== "ok") {
    throw new ActionError("source_unavailable", `cleanup refused: pohunek did not answer (${pohunek})`);
  }
  const owners = row.item.sessions.filter((s) => s.worktreePath !== null);
  const [only] = owners;
  if (only === undefined) {
    throw new ActionError("no_session", `cleanup refused: no linked session of ${row.listItem.key} owns a worktree`);
  }
  if (owners.length > 1) {
    throw new ActionError(
      "ambiguous_session",
      `cleanup refused: several linked sessions of ${row.listItem.key} own a worktree (${owners.map((s) => s.id).join(", ")}); remove one with \`pohunek session rm <id>\``,
    );
  }
  const project = row.project.pohunekLabel;
  const target = validTarget(only, project);
  const evidence = await gatherEvidence(only, target, sessions, config, deps);
  const bin = config.global.pohunek.bin;
  return {
    action: "cleanup",
    key: row.listItem.key,
    project,
    sessionId: target.id,
    state: only.state,
    worktreePath: target.worktreePath,
    branch: target.branch,
    eligible: evidence.checks.every((c) => c.ok),
    checks: evidence.checks,
    inventory: evidence.inventory,
    stopArgv: [bin, "session", "stop", target.id, "--json"],
    removeArgv: [bin, "session", "rm", target.id, "--json"],
  };
}

// --------------------------------------------------------------- execute

function failedNames(checks: readonly CleanupCheck[]): string {
  return checks.filter((c) => !c.ok).map((c) => c.name).join(", ");
}

function sourceError(what: string, result: Extract<SourceResult<unknown>, { ok: false }>): ActionError {
  if (result.code === "timeout") {
    return new ActionError("command_timed_out", `${what} did not finish in time; the state of the session is unknown, check \`pohunek session list\` before retrying`);
  }
  return new ActionError("command_failed", `${what} failed (${result.code})`);
}

async function rereadSessions(pohunek: PohunekClient, stoppedAlready: boolean): Promise<readonly PohunekSession[]> {
  const listed = await pohunek.listSessions();
  if (!listed.ok) {
    const state = stoppedAlready ? "the session is stopped" : "the session was not touched";
    throw new ActionError("verification_failed", `cannot re-read the session list (${listed.code}); ${state} and nothing was removed`);
  }
  return listed.data;
}

/**
 * Stops the session when it still runs, re-reads the evidence, and removes it only
 * when every check still holds. Never passes `--accept-unconfirmed-cleanup`.
 */
export async function executeCleanup(plan: CleanupPlan, deps: CleanupDeps, config: PluginConfig): Promise<CleanupResult> {
  const timeoutMs = config.global.actions.cleanupTimeoutMs;
  const failed = plan.checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new ActionError("precondition_failed", `cleanup refused: failed checks: ${failedNames(plan.checks)}; nothing was stopped or removed`);
  }

  let stopped = false;
  if (plan.state === "running") {
    const stop = await deps.pohunek.stopSession(plan.sessionId, timeoutMs);
    if (!stop.ok) throw sourceError("pohunek session stop", stop);
    stopped = true;
  }

  const sessions = await rereadSessions(deps.pohunek, stopped);
  const fresh = sessions.find((s) => s.id === plan.sessionId);
  if (fresh === undefined) {
    throw new ActionError("verification_failed", `session ${plan.sessionId} is no longer listed after the stop; nothing was removed`);
  }
  if (!isTerminal(fresh.state)) {
    throw new ActionError("verification_failed", `session ${plan.sessionId} is ${fresh.state} after the stop, not finished; nothing was removed`);
  }
  if (fresh.worktreePath !== plan.worktreePath || fresh.branch !== plan.branch) {
    throw new ActionError("verification_failed", `the worktree or branch of session ${plan.sessionId} changed since the plan; nothing was removed`);
  }

  const target = validTarget(fresh, plan.project);
  const evidence = await gatherEvidence(fresh, target, sessions, config, deps);
  const failedAgain = evidence.checks.filter((c) => !c.ok);
  if (failedAgain.length > 0) {
    const kept = stopped ? "the session stays stopped" : "the session was not touched";
    throw new ActionError("precondition_failed", `cleanup refused after the stop: failed checks: ${failedNames(evidence.checks)}; ${kept} and nothing was removed`);
  }

  const removal = await deps.pohunek.removeSession(plan.sessionId, timeoutMs);
  if (!removal.ok) throw sourceError("pohunek session rm", removal);
  if (!removal.data.removed) {
    throw new ActionError("command_failed", "pohunek session rm reported removed=false");
  }
  if (removal.data.worktreesFailed > 0) {
    throw new ActionError("command_failed", `pohunek session rm could not remove ${String(removal.data.worktreesFailed)} worktree(s); the session is removed, check the worktree on disk`);
  }

  if (removal.data.acceptedUnconfirmedProcesses > 0) {
    throw new ActionError(
      "command_unverified",
      `pohunek session rm reported ${String(removal.data.acceptedUnconfirmedProcesses)} unconfirmed process(es) although none was accepted; check ${plan.sessionId} and its processes`,
    );
  }

  const after = await deps.pohunek.listSessions();
  if (!after.ok) {
    throw new ActionError("command_unverified", `session rm succeeded but re-reading the session list failed (${after.code}); check that ${plan.sessionId} is gone`);
  }
  if (after.data.some((s) => s.id === plan.sessionId)) {
    throw new ActionError("command_unverified", `session rm succeeded but ${plan.sessionId} is still listed`);
  }
  return { sessionId: plan.sessionId, stopped, removed: true, worktreesRemoved: removal.data.worktreesRemoved, verifiedAbsent: true };
}
