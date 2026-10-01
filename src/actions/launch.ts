// Launch actions: build the `pohunek session new` invocation for one row from
// fresh data, refuse when the precondition no longer holds, run it and check
// the daemon's answer.
import type { CollectedRow } from "../commands/list.ts";
import { keyFromBranch } from "../join.ts";
import { isLiveSession, type PohunekClient } from "../sources/pohunek.ts";
import type { PluginConfig } from "../types/config.ts";
import type { PohunekSession } from "../types/sources.ts";
import { isIssueKey, slugify } from "./branch.ts";
import { dataBlock, readTemplate, renderTemplate } from "./prompt.ts";
import { ActionError, type ActionPlan, type ActionResult, type LaunchAction } from "./types.ts";

/** Rule of RFC section 8.1 that has to hold for `implement`: issue in progress, nothing runs. */
const IMPLEMENT_RULE = 8;

/** A profile name is a pohunek identifier, never an option. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ROLE_KEY = "work.role";

export interface PlanOptions {
  /** `--profile`; overrides the configured profile of the action. */
  readonly profile: string | null;
  /** Every session pohunek knows, linked or not: one worktree must not get a second writer. */
  readonly sessions: readonly PohunekSession[];
}

function profileFor(action: LaunchAction, row: CollectedRow, config: PluginConfig, override: string | null): string {
  const profile = override ?? (row.project.profiles ?? config.global.profiles)[action];
  if (profile === undefined) {
    throw new ActionError("no_profile", `no agent profile for ${action}: set [profiles] ${action} or pass --profile`);
  }
  if (!PROFILE_NAME.test(profile)) {
    throw new ActionError("invalid_value", `agent profile ${JSON.stringify(profile)} is not a valid profile name`);
  }
  return profile;
}

/** Refuses on `unknown` (a source failed) and on a changed turn, naming what was seen. */
function requireTurn(row: CollectedRow, action: LaunchAction, accepts: (actor: string, rule: number | null) => boolean, wanted: string): void {
  const { actor, reason, rule } = row.listItem.on_turn;
  if (actor === "unknown") {
    throw new ActionError("source_unavailable", `${action} refused: on_turn is unknown (${reason})`);
  }
  if (!accepts(actor, rule)) {
    const seen = rule === null ? actor : `${actor}, rule ${String(rule)}`;
    throw new ActionError("precondition_failed", `${action} refused: on_turn is ${seen} (${reason}); ${wanted}`);
  }
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

/** The worktree of the item: the session that owns one, the implementing session first. */
function worktreeOf(sessions: readonly PohunekSession[]): string | null {
  const owners = sessions.filter((s) => s.worktreePath !== null);
  const owner = owners.find((s) => s.metadata[ROLE_KEY] === "implement") ?? owners[0];
  return owner?.worktreePath ?? null;
}

/** The daemon accepts a second live session in a worktree, so the plugin refuses it, whoever started the first. */
function requireFreeWorktree(cwd: string, sessions: readonly PohunekSession[]): void {
  const occupant = sessions.find((s) => isLiveSession(s) && (s.cwd === cwd || s.worktreePath === cwd));
  if (occupant !== undefined) {
    throw new ActionError("already_running", `babysit refused: live session ${occupant.id} already runs in ${cwd}`);
  }
}

async function planBabysit(
  row: CollectedRow,
  config: PluginConfig,
  profile: string,
  sessions: readonly PohunekSession[],
): Promise<ActionPlan> {
  const pr = row.item.pullRequest;
  if (pr === null || pr.relation !== "authored") {
    throw new ActionError("precondition_failed", `babysit refused: ${row.listItem.key} has no pull request of yours`);
  }
  requireTurn(row, "babysit", (actor) => actor === "me" || actor === "reviewer", "it needs a pull request waiting on you or on a reviewer");
  requireNoLiveSession(row, "babysit");

  const cwd = worktreeOf(row.item.sessions);
  if (cwd === null) {
    throw new ActionError("no_worktree", `babysit refused: no linked session of ${row.listItem.key} owns a worktree to start in`);
  }
  if (!cwd.startsWith("/")) {
    throw new ActionError("invalid_value", `worktree path ${JSON.stringify(cwd)} is not absolute`);
  }
  requireFreeWorktree(cwd, sessions);

  const onIssue = row.listItem.key.startsWith("linear:");
  const linkId = onIssue ? issueKeyOf(row) : pr.id;
  const name = `${onIssue ? linkId : pr.id} babysit`;
  const metadata: Record<string, string> = {
    "work.link.provider": onIssue ? "linear" : "github",
    "work.link.kind": onIssue ? "issue" : "pull_request",
    "work.link.id": linkId,
    "work.link.url": pr.url,
    "work.link.branch": pr.headRefName,
    [ROLE_KEY]: "babysit",
    "work.rev": pr.headSha,
  };
  const prompt = renderTemplate(await readTemplate("work-babysit"), {
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    branch: pr.headRefName,
    pr_url: pr.url,
    pr_block: dataBlock("github", { id: pr.id, title: pr.title }),
  });
  return {
    action: "babysit",
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    profile,
    branch: null,
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

/** Builds the plan from one fresh row; throws an `ActionError` and has no side effect otherwise. */
export async function planLaunch(
  action: LaunchAction,
  row: CollectedRow,
  config: PluginConfig,
  options: PlanOptions,
): Promise<ActionPlan> {
  const profile = profileFor(action, row, config, options.profile);
  return action === "implement" ? planImplement(row, config, profile) : planBabysit(row, config, profile, options.sessions);
}

/** Argv shown to the owner and logged; the prompt travels on stdin. */
export function displayArgv(bin: string, plan: ActionPlan): string[] {
  return [bin, "session", "new", ...plan.args, "--json"];
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
  const result = await pohunek.launchSession({
    args: plan.args,
    stdin: plan.prompt,
    timeoutMs: config.global.actions.launchTimeoutMs + config.global.actions.launchKillMarginMs,
  });
  if (!result.ok) {
    if (result.code === "timeout") {
      throw new ActionError(
        "launch_timed_out",
        `${result.message}; the session may have been created, check \`pohunek session list\` before retrying`,
      );
    }
    throw new ActionError("launch_failed", `${result.code}: ${result.message}`);
  }
  const session = result.data;
  // The daemon's own record has to carry exactly the link that was planned.
  const mismatched = Object.entries(plan.metadata).filter(([key, value]) => session.metadata[key] !== value);
  if (mismatched.length > 0) {
    throw new ActionError(
      "launch_unverified",
      `session ${session.id} was created but its metadata differs from the plan for: ${mismatched.map(([key]) => key).join(", ")}`,
    );
  }
  return {
    sessionId: session.id,
    name: session.name,
    branch: session.branch,
    worktreePath: session.worktreePath,
    metadata: session.metadata,
  };
}
