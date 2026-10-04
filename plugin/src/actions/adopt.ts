// Adoption of an existing pull request: babysit, fix-ci and rebase on a row whose linked sessions own no
// worktree start in a fresh worktree that checks out the pull request's head branch itself.
import type { PohunekSession, PullRequest } from "../types/sources.ts";

/** A full commit SHA as GitHub reports `headRefOid`. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/;
/** A branch name that can be passed as an argv value and fetched by name: no option, no `..`. */
export const FETCHABLE_BRANCH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

export interface AdoptRefusal {
  readonly code: "precondition_failed" | "invalid_value";
  /** Reason without the action name; the caller prefixes `<action> refused: `. */
  readonly reason: string;
}

/**
 * Why the head branch of `pr` cannot be adopted, decided from data `list` and `do` both hold: the pull
 * request itself and every session of the project (a session of another project cannot hold the branch).
 * A branch checked out by a worktree pohunek did not create is only visible to `project show`, so `do`
 * checks that one itself.
 */
export function adoptRefusal(pr: PullRequest, sessions: readonly PohunekSession[], projectLabel: string): AdoptRefusal | null {
  if (pr.isCrossRepository) {
    return { code: "precondition_failed", reason: `the head branch of ${pr.id} lives in a fork, not on origin` };
  }
  if (!COMMIT_SHA.test(pr.headSha)) {
    return { code: "invalid_value", reason: `head commit ${JSON.stringify(pr.headSha)} of ${pr.id} is not a full SHA` };
  }
  if (!FETCHABLE_BRANCH.test(pr.headRefName) || pr.headRefName.includes("..")) {
    return { code: "invalid_value", reason: `head branch of ${pr.id} cannot be fetched by name safely` };
  }
  const holder = sessions.find((s) => s.projectLabel === projectLabel && s.branch === pr.headRefName && s.worktreePath !== null);
  if (holder !== undefined) {
    return {
      code: "precondition_failed",
      reason: `session ${holder.id} (not linked to this row) already holds a worktree on ${pr.headRefName}; link or remove it`,
    };
  }
  return null;
}
