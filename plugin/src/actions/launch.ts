// Launch actions: build the `pohunek session new` invocation for one row from
// fresh data, refuse when the precondition no longer holds, run it and check
// the daemon's answer.
import type { CollectedRow } from "../commands/list.ts";
import { configuredProfile } from "../config/profiles.ts";
import { keyFromBranch } from "../join.ts";
import { failingChecks } from "../rules.ts";
import { isLiveSession, ROLE_KEY, worktreeOf, type PohunekClient } from "../sources/pohunek.ts";
import type { PluginConfig } from "../types/config.ts";
import type { PohunekSession, PullRequest } from "../types/sources.ts";
import { isIssueKey, slugify } from "./branch.ts";
import { requireAuthoredPullRequest, requireGithub, requireTurn } from "./preconditions.ts";
import { dataBlock, readTemplate, renderTemplate, type PromptName } from "./prompt.ts";
import { ActionError, type ActionPlan, type ActionResult, type LaunchAction } from "./types.ts";

/** Rule of RFC section 8.1 that has to hold for `implement`: issue in progress, nothing runs. */
const IMPLEMENT_RULE = 8;
/** Rule for a review requested from the owner. */
const REVIEW_RULE = 3;
/** Rule for a failing check or a merge conflict on the owner's pull request. */
const FIX_RULE = 5;

/** A profile name is a pohunek identifier, never an option. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A full commit SHA as GitHub reports `headRefOid`. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** A branch name that can be passed as an argv value and fetched by name: no option, no `..`. */
const FETCHABLE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

export interface PlanOptions {
  /** `--profile`; overrides the configured profile of the action. */
  readonly profile: string | null;
  /** Every session pohunek knows, linked or not: one worktree must not get a second writer. */
  readonly sessions: readonly PohunekSession[];
}

function profileFor(action: LaunchAction, row: CollectedRow, config: PluginConfig, override: string | null): string {
  const profile = override ?? configuredProfile(action, row.project.profiles, config.global.profiles);
  if (profile === undefined) {
    throw new ActionError("no_profile", `no agent profile for ${action}: set [profiles] ${action} or pass --profile`);
  }
  if (!PROFILE_NAME.test(profile)) {
    throw new ActionError("invalid_value", `agent profile ${JSON.stringify(profile)} is not a valid profile name`);
  }
  return profile;
}

function requireNoLiveSession(row: CollectedRow, action: LaunchAction): void {
  const live = row.item.sessions.filter(isLiveSession);
  if (live.length > 0) {
    throw new ActionError(
      "already_running",
      `${action} refused: live linked session ${live.map((s) => s.id).join(", ")} already runs for ${row.listItem.key}`,
    );
  }
}

function issueKeyOf(row: CollectedRow): string {
  const key = row.item.issue?.id ?? row.listItem.key.slice(row.listItem.key.indexOf(":") + 1);
  if (!isIssueKey(key)) {
    throw new ActionError("invalid_value", `${JSON.stringify(key)} is not a Linear issue key`);
  }
  return key;
}

function metaArgs(metadata: Readonly<Record<string, string>>): string[] {
  return Object.entries(metadata).flatMap(([key, value]) => ["--meta", `${key}=${value}`]);
}

function requireCommitSha(pr: PullRequest): string {
  if (!COMMIT_SHA.test(pr.headSha)) {
    throw new ActionError("invalid_value", `head commit ${JSON.stringify(pr.headSha)} of ${pr.id} is not a full SHA`);
  }
  return pr.headSha;
}

/** A stopped session still holds its worktree and branch, so a new branch cannot be launched for the item. */
function requireNoWorktree(row: CollectedRow): void {
  const owner = row.item.sessions.find((s) => s.worktreePath !== null);
  if (owner !== undefined) {
    throw new ActionError(
      "precondition_failed",
      `implement refused: session ${owner.id} already owns a worktree for ${row.listItem.key}; use babysit or attach`,
    );
  }
}

async function planImplement(row: CollectedRow, config: PluginConfig, profile: string): Promise<ActionPlan> {
  const issue = row.item.issue;
  if (issue === null || row.item.pullRequest !== null) {
    throw new ActionError("precondition_failed", `implement refused: ${row.listItem.key} is not an issue without a pull request`);
  }
  requireTurn(row, "implement", (actor, rule) => actor === "me" && rule === IMPLEMENT_RULE, `it needs rule ${String(IMPLEMENT_RULE)} (nothing runs)`);
  requireNoLiveSession(row, "implement");
  requireNoWorktree(row);

  const key = issueKeyOf(row);
  const { branchPrefix, slugMaxLength } = config.global.actions;
  const slug = slugify(issue.title, slugMaxLength);
  if (slug === "") {
    throw new ActionError("invalid_value", `implement refused: the title of ${key} has no ASCII letters or digits to build a branch name from`);
  }
  const branch = `${branchPrefix}/${key}/${slug}`;
  // The row has to find its session and pull request again through the project's branch pattern.
  if (keyFromBranch(row.project.branchPattern, branch) !== key) {
    throw new ActionError(
      "invalid_value",
      `branch ${branch} does not match branch_pattern of project ${row.project.pohunekLabel}; adjust [actions] branch_prefix`,
    );
  }

  const metadata: Record<string, string> = {
    "work.link.provider": "linear",
    "work.link.kind": "issue",
    "work.link.id": key,
    "work.link.url": issue.url,
    "work.link.branch": branch,
    [ROLE_KEY]: "implement",
    "work.rev": issue.stateType,
  };
  const prompt = renderTemplate(await readTemplate("work-implement"), {
    key,
    project: row.project.pohunekLabel,
    branch,
    url: issue.url,
    issue_block: dataBlock("linear", { id: key, title: issue.title }),
  });
  return {
    action: "implement",
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    profile,
    branch,
    baseBranch: null,
    expectedHead: null,
    cwd: null,
    name: key,
    metadata,
    args: [
      "--project", row.project.pohunekLabel,
      "--branch", branch,
      "--name", key,
      "--agent", profile,
      ...metaArgs(metadata),
      "--input-stdin",
      "--request-timeout-ms", String(config.global.actions.launchTimeoutMs),
    ],
    prompt,
  };
}

/** The daemon accepts a second live session in a worktree, so the plugin refuses it, whoever started the first. */
function requireFreeWorktree(action: LaunchAction, cwd: string, sessions: readonly PohunekSession[]): void {
  const occupant = sessions.find((s) => isLiveSession(s) && (s.cwd === cwd || s.worktreePath === cwd));
  if (occupant !== undefined) {
    throw new ActionError("already_running", `${action} refused: live session ${occupant.id} already runs in ${cwd}`);
  }
}

/** How one action that works in the existing worktree of the owner's pull request differs from the others. */
interface WorktreeSpec {
  readonly template: PromptName;
  /** Turn check on the fresh row; throws an `ActionError`. */
  readonly precondition: (row: CollectedRow, pr: PullRequest) => void;
  /** Provider fields for the prompt's data block besides id and title. */
  readonly fields: (row: CollectedRow, pr: PullRequest) => Readonly<Record<string, string>>;
}

const WORKTREE_SPECS: Readonly<Record<Exclude<LaunchAction, "implement" | "review">, WorktreeSpec>> = {
  babysit: {
    template: "work-babysit",
    precondition: (row) => {
      requireTurn(row, "babysit", (actor) => actor === "me" || actor === "reviewer", "it needs a pull request waiting on you or on a reviewer");
    },
    fields: () => ({}),
  },
  "fix-ci": {
    template: "work-fix-ci",
    precondition: (row, pr) => {
      requireTurn(row, "fix-ci", (actor, rule) => actor === "me" && rule === FIX_RULE, `it needs rule ${String(FIX_RULE)} (fix CI)`);
      if (pr.mergeable === "CONFLICTING") {
        throw new ActionError("precondition_failed", `fix-ci refused: ${pr.id} conflicts with its base; rebase it first`);
      }
      const failing = failingChecks(pr.checks, row.project);
      if (failing.policy.length > 0 && failing.ci.length === 0) {
        throw new ActionError("precondition_failed", `fix-ci refused: only policy checks of ${pr.id} fail (${failing.policy.join(", ")}); they need the owner`);
      }
      if (failing.ci.length === 0) {
        throw new ActionError("precondition_failed", `fix-ci refused: no check of ${pr.id} is failing`);
      }
    },
    fields: (row, pr) => ({ failing_checks: failingChecks(pr.checks, row.project).ci.join(", ") }),
  },
  rebase: {
    template: "work-rebase",
    precondition: (row, pr) => {
      requireTurn(row, "rebase", (actor, rule) => actor === "me" && rule === FIX_RULE, `it needs rule ${String(FIX_RULE)} (rebase)`);
      if (pr.mergeable !== "CONFLICTING") {
        throw new ActionError("precondition_failed", `rebase refused: ${pr.id} has no merge conflict (mergeable ${pr.mergeable})`);
      }
    },
    fields: (_row, pr) => ({ base_branch: pr.baseRefName }),
  },
};

/** babysit, fix-ci and rebase: a second session in the worktree of the owner's pull request (spike S2). */
async function planInWorktree(
  action: Exclude<LaunchAction, "implement" | "review">,
  row: CollectedRow,
  config: PluginConfig,
  profile: string,
  sessions: readonly PohunekSession[],
): Promise<ActionPlan> {
  const spec = WORKTREE_SPECS[action];
  const pr = requireAuthoredPullRequest(row, action);
  spec.precondition(row, pr);
  requireNoLiveSession(row, action);

  const cwd = worktreeOf(row.item.sessions);
  if (cwd === null) {
    throw new ActionError("no_worktree", `${action} refused: no linked session of ${row.listItem.key} owns a worktree to start in`);
  }
  if (!cwd.startsWith("/")) {
    throw new ActionError("invalid_value", `worktree path ${JSON.stringify(cwd)} is not absolute`);
  }
  requireFreeWorktree(action, cwd, sessions);

  const onIssue = row.listItem.key.startsWith("linear:");
  const linkId = onIssue ? issueKeyOf(row) : pr.id;
  const name = `${linkId} ${action}`;
  const metadata: Record<string, string> = {
    "work.link.provider": onIssue ? "linear" : "github",
    "work.link.kind": onIssue ? "issue" : "pull_request",
    "work.link.id": linkId,
    "work.link.url": pr.url,
    "work.link.branch": pr.headRefName,
    [ROLE_KEY]: action,
    "work.rev": pr.headSha,
  };
  const prompt = renderTemplate(await readTemplate(spec.template), {
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    branch: pr.headRefName,
    pr_url: pr.url,
    pr_block: dataBlock("github", { id: pr.id, title: pr.title, ...spec.fields(row, pr) }),
  });
  return {
    action,
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    profile,
    branch: null,
    baseBranch: null,
    expectedHead: null,
    cwd,
    name,
    metadata,
    args: [
      "--cwd", cwd,
      "--name", name,
      "--agent", profile,
      ...metaArgs(metadata),
      "--input-stdin",
      "--request-timeout-ms", String(config.global.actions.launchTimeoutMs),
    ],
    prompt,
  };
}

/**
 * review: a new worktree of someone else's pull request. Per spike S8 only
 * `--base-branch <head branch>` fetches the head from origin, and an existing
 * local branch is checked out unchanged, so the local branch name carries the
 * head SHA: a leftover branch of that name can only point at the same commit.
 */
async function planReview(
  row: CollectedRow,
  config: PluginConfig,
  profile: string,
  sessions: readonly PohunekSession[],
): Promise<ActionPlan> {
  requireGithub(row, "review");
  const pr = row.item.pullRequest;
  if (pr === null || pr.relation !== "review_requested") {
    throw new ActionError("precondition_failed", `review refused: ${row.listItem.key} has no pull request waiting for your review`);
  }
  requireTurn(row, "review", (actor, rule) => actor === "me" && rule === REVIEW_RULE, `it needs rule ${String(REVIEW_RULE)} (review)`);
  if (pr.isCrossRepository) {
    throw new ActionError("precondition_failed", `review refused: the head branch of ${pr.id} lives in a fork, not on origin`);
  }
  requireNoLiveSession(row, "review");
  const head = requireCommitSha(pr);
  if (!FETCHABLE_BRANCH.test(pr.headRefName) || pr.headRefName.includes("..")) {
    throw new ActionError("invalid_value", `head branch of ${pr.id} cannot be fetched by name safely`);
  }

  const { branchPrefix, reviewBranchSegment } = config.global.actions;
  const branch = `${branchPrefix}/${reviewBranchSegment}/${String(pr.number)}-${head}`;
  // A review branch matched by branch_pattern would join the review session to an issue row.
  if (keyFromBranch(row.project.branchPattern, branch) !== null) {
    throw new ActionError(
      "invalid_value",
      `review branch ${branch} matches branch_pattern of project ${row.project.pohunekLabel}; adjust [actions] review_branch_segment`,
    );
  }
  const holder = sessions.find((s) => s.branch === branch && s.worktreePath !== null);
  if (holder !== undefined) {
    throw new ActionError(
      "precondition_failed",
      `review refused: session ${holder.id} already holds a worktree of this head (${branch}); attach to it or remove it`,
    );
  }

  const name = `${pr.id} review`;
  const metadata: Record<string, string> = {
    "work.link.provider": "github",
    "work.link.kind": "pull_request",
    "work.link.id": pr.id,
    "work.link.url": pr.url,
    "work.link.branch": pr.headRefName,
    [ROLE_KEY]: "review",
    "work.rev": head,
  };
  const prompt = renderTemplate(await readTemplate("work-review"), {
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    pr_url: pr.url,
    rev: head,
    branch,
    pr_block: dataBlock("github", { id: pr.id, title: pr.title, head_branch: pr.headRefName, base_branch: pr.baseRefName }),
  });
  return {
    action: "review",
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    profile,
    branch,
    baseBranch: pr.headRefName,
    expectedHead: head,
    cwd: null,
    name,
    metadata,
    args: [
      "--project", row.project.pohunekLabel,
      "--branch", branch,
      "--base-branch", pr.headRefName,
      "--name", name,
      "--agent", profile,
      ...metaArgs(metadata),
      "--input-stdin",
      "--request-timeout-ms", String(config.global.actions.launchTimeoutMs),
    ],
    prompt,
  };
}

/** Builds the plan from one fresh row; throws an `ActionError` and has no side effect otherwise. */
export async function planLaunch(
  action: LaunchAction,
  row: CollectedRow,
  config: PluginConfig,
  options: PlanOptions,
): Promise<ActionPlan> {
  const profile = profileFor(action, row, config, options.profile);
  switch (action) {
    case "implement":
      return planImplement(row, config, profile);
    case "review":
      return planReview(row, config, profile, options.sessions);
    default:
      return planInWorktree(action, row, config, profile, options.sessions);
  }
}

/** Argv shown to the owner and logged; the prompt travels on stdin. */
export function displayArgv(bin: string, plan: ActionPlan): string[] {
  return [bin, "session", "new", ...plan.args, "--json"];
}

/**
 * The session runs once the daemon answered, so a wrong checkout can only be
 * reported: the review prompt tells the agent to stop on a different HEAD.
 */
async function verifyHead(plan: ActionPlan, expected: string, result: ActionResult, pohunek: PohunekClient): Promise<void> {
  const cleanup = `the session runs; remove it with \`pohunek session rm ${result.sessionId}\` and delete the local branch ${String(plan.branch)}`;
  if (result.warnings.length > 0) {
    throw new ActionError(
      "launch_unverified",
      `session ${result.sessionId} was created with daemon warnings (${result.warnings.join(", ")}), so its worktree may not hold ${expected}; ${cleanup}`,
    );
  }
  const worktrees = await pohunek.listWorktrees(plan.project);
  if (!worktrees.ok) {
    throw new ActionError(
      "launch_unverified",
      `session ${result.sessionId} was created but its worktree could not be re-read (${worktrees.code}: ${worktrees.message}); check that it holds ${expected}`,
    );
  }
  const worktree = worktrees.data.find((w) => w.sessionId === result.sessionId || (result.worktreePath !== null && w.path === result.worktreePath));
  if (worktree?.head !== expected) {
    const seen = worktree === undefined ? "no worktree of the session was listed" : `the worktree holds ${worktree.head}`;
    throw new ActionError("launch_unverified", `session ${result.sessionId} was created but ${seen} instead of ${expected}; ${cleanup}`);
  }
}

/**
 * Runs the plan once. The process gets `launchKillMarginMs` more than the
 * daemon so the daemon's own timeout answer arrives first. A timeout is not
 * retried: the session may exist, so the error tells the owner to look at
 * `pohunek session list`.
 */
export async function executePlan(
  plan: ActionPlan,
  pohunek: PohunekClient,
  config: PluginConfig,
): Promise<ActionResult> {
  const launched = await pohunek.launchSession({
    args: plan.args,
    stdin: plan.prompt,
    timeoutMs: config.global.actions.launchTimeoutMs + config.global.actions.launchKillMarginMs,
  });
  if (!launched.ok) {
    if (launched.code === "timeout") {
      throw new ActionError(
        "launch_timed_out",
        `${launched.message}; the session may have been created, check \`pohunek session list\` before retrying`,
      );
    }
    throw new ActionError("launch_failed", `${launched.code}: ${launched.message}`);
  }
  const { session, warnings } = launched.data;
  // The daemon's own record has to carry exactly the link that was planned.
  const mismatched = Object.entries(plan.metadata).filter(([key, value]) => session.metadata[key] !== value);
  if (mismatched.length > 0) {
    throw new ActionError(
      "launch_unverified",
      `session ${session.id} was created but its metadata differs from the plan for: ${mismatched.map(([key]) => key).join(", ")}`,
    );
  }
  const result: ActionResult = {
    sessionId: session.id,
    name: session.name,
    branch: session.branch,
    worktreePath: session.worktreePath,
    metadata: session.metadata,
    warnings,
  };
  if (plan.expectedHead !== null) {
    await verifyHead(plan, plan.expectedHead, result, pohunek);
  }
  return result;
}
