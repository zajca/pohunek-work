// Launch actions: build the `pohunek session new` invocation for one row from
// fresh data, refuse when the precondition no longer holds, run it and check
// the daemon's answer.
import type { CollectedRow } from "../commands/list.ts";
import { configuredProfile } from "../config/profiles.ts";
import { keyFromBranch } from "../join.ts";
import { isGithubProject } from "../config/issue-source.ts";
import { isGithubIssueRowKey } from "../config/row-key.ts";
import { failingChecks } from "../rules.ts";
import type { GithubSource } from "../sources/github.ts";
import { isLiveSession, ROLE_KEY, worktreeOf, type PohunekClient } from "../sources/pohunek.ts";
import type { PluginConfig } from "../types/config.ts";
import type { Issue, PohunekSession, PullRequest } from "../types/sources.ts";
import { adoptRefusal, COMMIT_SHA, FETCHABLE_BRANCH } from "./adopt.ts";
import { isIssueKey, slugify } from "./branch.ts";
import { REPO, requireAuthoredPullRequest, requireGithub, requireTurn } from "./preconditions.ts";
import { dataBlock, readTemplate, renderTemplate, type PromptName } from "./prompt.ts";
import { ActionError, type ActionPlan, type ActionResult, type LaunchAction } from "./types.ts";

/** Rule of RFC section 8.1 that has to hold for `implement`: issue in progress, nothing runs. */
const IMPLEMENT_RULE = 8;
/** `work.rev` of an implement session: rule 8 holds only for a started issue. */
const IMPLEMENT_REV = "started";
/** Rule for a review requested from the owner. */
const REVIEW_RULE = 3;
/** Rule for a failing check or a merge conflict on the owner's pull request. */
const FIX_RULE = 5;

/** A profile name is a pohunek identifier, never an option. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PlanOptions {
  /** `--profile`; overrides the configured profile of the action. */
  readonly profile: string | null;
  /** Every session pohunek knows, linked or not: one worktree must not get a second writer. */
  readonly sessions: readonly PohunekSession[];
  /** Reads the issue body of a GitHub issue row; `implement` is the only action that does. */
  readonly github: GithubSource;
  /** Reads the worktrees of a project; adopting a pull request's head branch is the only plan that does. */
  readonly pohunek: Pick<PohunekClient, "listWorktrees">;
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

/** `<owner/name>#<n>` of a GitHub issue row; it has to name an issue of the project's own repository. */
function githubIssueKeyOf(row: CollectedRow): string {
  const key = row.item.issueKey;
  const prefix = `${row.project.repo}#`;
  if (key === null || !key.startsWith(prefix) || !/^[0-9]+$/.test(key.slice(prefix.length))) {
    throw new ActionError("invalid_value", `${JSON.stringify(key)} is not an issue of ${row.project.repo}`);
  }
  return key;
}

/** The `work.link.*` identity of the row a worktree action works on: its issue when it is an issue row, else the pull request. */
function linkOfRow(row: CollectedRow, pr: PullRequest): { provider: string; kind: string; id: string } {
  if (row.listItem.key.startsWith("linear:")) return { provider: "linear", kind: "issue", id: issueKeyOf(row) };
  if (isGithubIssueRowKey(row.listItem.key)) return { provider: "github", kind: "issue", id: githubIssueKeyOf(row) };
  return { provider: "github", kind: "pull_request", id: pr.id };
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

/** The branch of a launched issue has to join back to its row through the project's branch pattern. */
function requireBranchJoins(row: CollectedRow, branch: string, key: string, adjust: string): void {
  if (keyFromBranch(row.project.branchPattern, branch) !== key) {
    throw new ActionError(
      "invalid_value",
      `branch ${branch} does not match branch_pattern of project ${row.project.pohunekLabel}; adjust ${adjust}`,
    );
  }
}

/** The state `implement` needs from either issue provider, checked before the provider-specific plan. */
function requireImplementable(row: CollectedRow): Issue {
  const issue = row.item.issue;
  if (issue === null || row.item.pullRequest !== null) {
    throw new ActionError("precondition_failed", `implement refused: ${row.listItem.key} is not an issue without a pull request`);
  }
  requireTurn(row, "implement", (actor, rule) => actor === "me" && rule === IMPLEMENT_RULE, `it needs rule ${String(IMPLEMENT_RULE)} (nothing runs)`);
  requireNoLiveSession(row, "implement");
  requireNoWorktree(row);
  return issue;
}

function implementArgs(row: CollectedRow, config: PluginConfig, profile: string, branch: string, name: string, metadata: Readonly<Record<string, string>>): string[] {
  return [
    "--project", row.project.pohunekLabel,
    "--branch", branch,
    "--name", name,
    "--agent", profile,
    ...metaArgs(metadata),
    "--input-stdin",
    "--request-timeout-ms", String(config.global.actions.launchTimeoutMs),
  ];
}

function implementSlug(issue: Issue, key: string, config: PluginConfig): string {
  const slug = slugify(issue.title, config.global.actions.slugMaxLength);
  if (slug === "") {
    throw new ActionError("invalid_value", `implement refused: the title of ${key} has no ASCII letters or digits to build a branch name from`);
  }
  return slug;
}

async function planLinearImplement(row: CollectedRow, config: PluginConfig, profile: string, issue: Issue): Promise<ActionPlan> {
  const key = issueKeyOf(row);
  const slug = implementSlug(issue, key, config);
  const branch = `${config.global.actions.branchPrefix}/${key}/${slug}`;
  // The row has to find its session and pull request again through the project's branch pattern.
  requireBranchJoins(row, branch, key, "[actions] branch_prefix");

  const metadata: Record<string, string> = {
    "work.link.provider": "linear",
    "work.link.kind": "issue",
    "work.link.id": key,
    "work.link.url": issue.url,
    "work.link.branch": branch,
    [ROLE_KEY]: "implement",
    "work.rev": IMPLEMENT_REV,
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
    args: implementArgs(row, config, profile, branch, key, metadata),
    prompt,
  };
}

/** The issue number of `<owner/name>#<n>`; `githubIssueKeyOf` has checked the shape. */
function issueNumberOf(key: string): number {
  return Number(key.slice(key.indexOf("#") + 1));
}

/**
 * A GitHub issue: the branch is `<branch_prefix>/<issue_number_prefix><n>/<slug>`, and the body, which only
 * this lookup reads, goes into the prompt's data block next to the title.
 */
async function planGithubImplement(row: CollectedRow, config: PluginConfig, profile: string, issue: Issue, github: GithubSource): Promise<ActionPlan> {
  if (!isGithubProject(row.project)) {
    throw new ActionError("invalid_value", `${row.listItem.key} is a GitHub issue row of project ${row.project.pohunekLabel}, whose issues do not come from GitHub`);
  }
  const key = githubIssueKeyOf(row);
  const number = issueNumberOf(key);
  const slug = implementSlug(issue, key, config);
  const { branchPrefix, issueNumberPrefix, issueBodyMaxLength } = config.global.actions;
  const branch = `${branchPrefix}/${issueNumberPrefix}${String(number)}/${slug}`;
  requireBranchJoins(row, branch, String(number), "[actions] branch_prefix and issue_number_prefix, or the project's branch_pattern");
  if (!REPO.test(row.project.repo)) {
    throw new ActionError("invalid_value", `repository ${JSON.stringify(row.project.repo)} is not owner/name`);
  }

  const detail = await github.fetchIssueDetail(row.project, number);
  if (!detail.ok) {
    throw new ActionError("source_unavailable", `implement refused: reading ${key} failed (${detail.code}): ${detail.message}`);
  }
  if (!detail.data.open) {
    throw new ActionError("precondition_failed", `implement refused: ${key} is closed`);
  }

  const metadata: Record<string, string> = {
    "work.link.provider": "github",
    "work.link.kind": "issue",
    "work.link.id": key,
    "work.link.url": detail.data.url,
    "work.link.branch": branch,
    [ROLE_KEY]: "implement",
    "work.rev": IMPLEMENT_REV,
  };
  const prompt = renderTemplate(await readTemplate("work-implement-github"), {
    issue: key,
    number: String(number),
    repo: row.project.repo,
    project: row.project.pohunekLabel,
    branch,
    issue_block: dataBlock("github", { id: key, title: detail.data.title, url: detail.data.url }, { name: "body", value: detail.data.body, maxLength: issueBodyMaxLength }),
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
    args: implementArgs(row, config, profile, branch, key, metadata),
    prompt,
  };
}

async function planImplement(row: CollectedRow, config: PluginConfig, profile: string, github: GithubSource): Promise<ActionPlan> {
  const issue = requireImplementable(row);
  return isGithubIssueRowKey(row.listItem.key)
    ? planGithubImplement(row, config, profile, issue, github)
    : planLinearImplement(row, config, profile, issue);
}

/** The daemon accepts a second live session in a worktree, so the plugin refuses it, whoever started the first. */
function requireFreeWorktree(action: LaunchAction, cwd: string, sessions: readonly PohunekSession[]): void {
  const occupant = sessions.find((s) => isLiveSession(s) && (s.cwd === cwd || s.worktreePath === cwd));
  if (occupant !== undefined) {
    throw new ActionError("already_running", `${action} refused: live session ${occupant.id} already runs in ${cwd}`);
  }
}

/** How one action that works on the owner's own pull request differs from the others. */
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

/**
 * A pull request's head branch has to be free to check out: core refuses `--branch` for a branch that any
 * worktree holds (spike S2), including the project's primary checkout, which only `project show` lists.
 */
async function requireHeadBranchFree(action: LaunchAction, pr: PullRequest, project: string, pohunek: PlanOptions["pohunek"]): Promise<void> {
  const worktrees = await pohunek.listWorktrees(project);
  if (!worktrees.ok) {
    throw new ActionError("source_unavailable", `${action} refused: the worktrees of ${project} could not be read (${worktrees.code}: ${worktrees.message})`);
  }
  const holder = worktrees.data.find((w) => w.branch === pr.headRefName);
  if (holder !== undefined) {
    throw new ActionError(
      "precondition_failed",
      `${action} refused: ${pr.headRefName} is already checked out in ${holder.path}; start there or free the branch`,
    );
  }
}

/**
 * babysit, fix-ci and rebase: a second session in the worktree of the owner's pull request (spike S2), or,
 * when no linked session owns one, a fresh worktree that checks out the pull request's head branch itself
 * (spike S9, adoption).
 */
async function planInWorktree(
  action: Exclude<LaunchAction, "implement" | "review">,
  row: CollectedRow,
  config: PluginConfig,
  profile: string,
  options: PlanOptions,
): Promise<ActionPlan> {
  const spec = WORKTREE_SPECS[action];
  const pr = requireAuthoredPullRequest(row, action);
  spec.precondition(row, pr);
  requireNoLiveSession(row, action);

  const cwd = worktreeOf(row.item.sessions);
  if (cwd !== null) {
    if (!cwd.startsWith("/")) {
      throw new ActionError("invalid_value", `worktree path ${JSON.stringify(cwd)} is not absolute`);
    }
    requireFreeWorktree(action, cwd, options.sessions);
  } else {
    const project = row.project.pohunekLabel;
    const refusal = adoptRefusal(pr, options.sessions, project);
    if (refusal !== null) throw new ActionError(refusal.code, `${action} refused: ${refusal.reason}`);
    await requireHeadBranchFree(action, pr, project, options.pohunek);
  }

  const link = linkOfRow(row, pr);
  const name = `${link.id} ${action}`;
  const metadata: Record<string, string> = {
    "work.link.provider": link.provider,
    "work.link.kind": link.kind,
    "work.link.id": link.id,
    "work.link.url": pr.url,
    "work.link.branch": pr.headRefName,
    [ROLE_KEY]: action,
    "work.rev": pr.headSha,
  };
  const headCheck = cwd === null
    ? `${renderTemplate(await readTemplate("work-adopt-head-check"), { rev: pr.headSha, branch: pr.headRefName })}\n`
    : "";
  const prompt = renderTemplate(await readTemplate(spec.template), {
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    branch: pr.headRefName,
    pr_url: pr.url,
    head_check: headCheck,
    pr_block: dataBlock("github", { id: pr.id, title: pr.title, ...spec.fields(row, pr) }),
  });
  const placement = cwd === null
    ? ["--project", row.project.pohunekLabel, "--branch", pr.headRefName, "--base-branch", pr.headRefName]
    : ["--cwd", cwd];
  return {
    action,
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    profile,
    branch: cwd === null ? pr.headRefName : null,
    baseBranch: cwd === null ? pr.headRefName : null,
    expectedHead: cwd === null ? pr.headSha : null,
    cwd,
    name,
    metadata,
    args: [
      ...placement,
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
  // Checked before profile resolution: an external-review project needs no review profile.
  if (action === "review" && row.project.reviews === "external") {
    throw new ActionError(
      "not_supported",
      `review refused: project ${row.project.pohunekLabel} hands reviews to an external pipeline ([project] reviews = "external")`,
    );
  }
  const profile = profileFor(action, row, config, options.profile);
  switch (action) {
    case "implement":
      return planImplement(row, config, profile, options.github);
    case "review":
      return planReview(row, config, profile, options.sessions);
    default:
      return planInWorktree(action, row, config, profile, options);
  }
}

/** Argv shown to the owner and logged; the prompt travels on stdin. */
export function displayArgv(bin: string, plan: ActionPlan): string[] {
  return [bin, "session", "new", ...plan.args, "--json"];
}

/**
 * The session runs once the daemon answered, so a wrong checkout can only be
 * reported: the review and adoption prompts tell the agent to stop on a different HEAD.
 */
async function verifyHead(plan: ActionPlan, expected: string, result: ActionResult, pohunek: PohunekClient): Promise<void> {
  // A review branch exists only for the review; an adopted branch is the owner's and may hold unpushed commits.
  const cleanup = plan.action === "review"
    ? `the session runs; remove it with \`pohunek session rm ${result.sessionId}\` and delete the local branch ${String(plan.branch)}`
    : `the session runs; remove it with \`pohunek session rm ${result.sessionId}\` (the local branch ${String(plan.branch)} stays) and bring that branch to ${expected} before retrying`;
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
