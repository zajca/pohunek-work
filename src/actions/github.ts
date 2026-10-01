// `ready`: marks the owner's draft pull request ready for review with `gh pr
// ready`, then re-reads the pull request, because the exit code alone does not
// prove the draft state changed.
import type { CollectedRow } from "../commands/list.ts";
import type { PluginConfig } from "../types/config.ts";
import { SpawnError, type Exec, type ExecResult } from "../util/exec.ts";
import { pullRequestTarget, requireAuthoredPullRequest, requireTurn } from "./preconditions.ts";
import { ActionError, type ReadyPlan } from "./types.ts";

/** Rule for the owner's draft pull request with nothing else to do. */
const READY_RULE = 6;

export function planReady(row: CollectedRow, config: PluginConfig): ReadyPlan {
  const pr = requireAuthoredPullRequest(row, "ready");
  // Checked before the turn: a pull request that is no longer a draft never holds rule 6.
  if (!pr.isDraft) {
    throw new ActionError("not_draft", `ready refused: ${pr.id} is no longer a draft`);
  }
  requireTurn(row, "ready", (actor, rule) => actor === "me" && rule === READY_RULE, `it needs rule ${String(READY_RULE)} (leave draft)`);
  const { repo, number } = pullRequestTarget(pr);
  const gh = config.global.github.ghBin;
  return {
    action: "ready",
    key: row.listItem.key,
    project: row.project.pohunekLabel,
    pullRequest: pr.id,
    argv: [gh, "pr", "ready", number, "-R", repo],
    verifyArgv: [gh, "pr", "view", number, "-R", repo, "--json", "isDraft"],
  };
}

async function run(exec: Exec, argv: readonly string[], timeoutMs: number): Promise<ExecResult | null> {
  try {
    return await exec(argv, { timeoutMs });
  } catch (error) {
    if (error instanceof SpawnError) return null;
    throw error;
  }
}

/** `isDraft` of `gh pr view --json isDraft`; null when the output is not exactly that shape. */
function parseIsDraft(stdout: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const isDraft = (parsed as Record<string, unknown>)["isDraft"];
  return typeof isDraft === "boolean" ? isDraft : null;
}

/**
 * Runs `gh pr ready` once and confirms the result with a fresh read. Messages
 * are static: `gh` output can quote the pull request title.
 */
export async function executeReady(plan: ReadyPlan, exec: Exec, config: PluginConfig): Promise<void> {
  const timeoutMs = config.global.github.timeoutMs;
  const ready = await run(exec, plan.argv, timeoutMs);
  if (ready === null) {
    throw new ActionError("command_failed", `cannot start ${String(plan.argv[0])}`);
  }
  if (ready.timedOut) {
    throw new ActionError(
      "command_timed_out",
      `gh pr ready did not finish within ${String(timeoutMs)} ms; the draft state of ${plan.pullRequest} is unknown, check it before retrying`,
    );
  }
  if (ready.exitCode !== 0) {
    throw new ActionError("command_failed", `gh pr ready exited with code ${String(ready.exitCode)} for ${plan.pullRequest}`);
  }

  const view = await run(exec, plan.verifyArgv, timeoutMs);
  if (view === null || view.timedOut || view.exitCode !== 0) {
    const why = view === null ? "could not start" : view.timedOut ? "timed out" : `exited with code ${String(view.exitCode)}`;
    throw new ActionError("verification_failed", `gh pr ready succeeded but re-reading ${plan.pullRequest} ${why}; check its draft state`);
  }
  const isDraft = parseIsDraft(view.stdout);
  if (isDraft === null) {
    throw new ActionError("verification_failed", `gh pr ready succeeded but gh pr view returned no isDraft for ${plan.pullRequest}`);
  }
  if (isDraft) {
    throw new ActionError("command_unverified", `gh pr ready succeeded but ${plan.pullRequest} is still a draft`);
  }
}
