// Checks shared by every action: the fresh row has to be on the expected turn,
// and the pull request the action works on has to be the expected kind.
import type { CollectedRow } from "../commands/list.ts";
import type { PullRequest } from "../types/sources.ts";
import { ActionError, type DoAction } from "./types.ts";

/** Refuses on `unknown` (a source failed) and on a changed turn, naming what was seen. */
export function requireTurn(
  row: CollectedRow,
  action: DoAction,
  accepts: (actor: string, rule: number | null) => boolean,
  wanted: string,
): void {
  const { actor, reason, rule } = row.listItem.on_turn;
  if (actor === "unknown") {
    throw new ActionError("source_unavailable", `${action} refused: on_turn is unknown (${reason})`);
  }
  if (!accepts(actor, rule)) {
    const seen = rule === null ? actor : `${actor}, rule ${String(rule)}`;
    throw new ActionError("precondition_failed", `${action} refused: on_turn is ${seen} (${reason}); ${wanted}`);
  }
}

/** The pull request of the row when the owner authored it. */
export function requireAuthoredPullRequest(row: CollectedRow, action: DoAction): PullRequest {
  const pr = row.item.pullRequest;
  if (pr === null || pr.relation !== "authored") {
    throw new ActionError("precondition_failed", `${action} refused: ${row.listItem.key} has no pull request of yours`);
  }
  return pr;
}

/** `owner/name`; also never an option, since it is passed as an argv value. */
const REPO = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*\/[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

/** The repository and number of a pull request, checked before they reach an argv. */
export function pullRequestTarget(pr: PullRequest): { repo: string; number: string } {
  if (!REPO.test(pr.repo)) {
    throw new ActionError("invalid_value", `repository ${JSON.stringify(pr.repo)} is not owner/name`);
  }
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0) {
    throw new ActionError("invalid_value", `pull request number ${String(pr.number)} is not a positive integer`);
  }
  return { repo: pr.repo, number: String(pr.number) };
}
