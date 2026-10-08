// Shared types of the write actions (`pohunek-work do`).

/** Version of the `do --json` contract; bumped on any incompatible change. */
export const DO_CONTRACT_VERSION = 1;

/** Actions that start a pohunek session. */
export type LaunchAction = "implement" | "babysit" | "fix-ci" | "rebase" | "review";

export const LAUNCH_ACTIONS: readonly LaunchAction[] = ["implement", "babysit", "fix-ci", "rebase", "review"];

/** Every action `do` accepts; `merge` is only accepted to refuse it (merging stays manual). */
export type DoAction = LaunchAction | "ready" | "attach" | "cleanup" | "merge";

export const DO_ACTIONS: readonly DoAction[] = [...LAUNCH_ACTIONS, "ready", "attach", "cleanup", "merge"];

export function isLaunchAction(action: DoAction): action is LaunchAction {
  return LAUNCH_ACTIONS.some((name) => name === action);
}

export type RefusalCode =
  | "unknown_item"
  | "ambiguous_item"
  | "source_unavailable"
  | "precondition_failed"
  | "already_running"
  | "no_profile"
  | "invalid_value"
  | "confirmation_required"
  | "launch_failed"
  | "launch_timed_out"
  | "launch_unverified"
  | "not_supported"
  | "not_draft"
  | "no_session"
  | "ambiguous_session"
  | "no_terminal"
  | "command_failed"
  | "command_timed_out"
  | "verification_failed"
  | "command_unverified";

/** A typed refusal or failure; no side effect happened unless the code says otherwise. */
export class ActionError extends Error {
  public readonly code: RefusalCode;

  public constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
  }
}

/** Everything one launch will do, computed from fresh data before anything runs. */
export interface ActionPlan {
  readonly action: LaunchAction;
  readonly key: string;
  readonly project: string;
  readonly profile: string;
  /** Branch of the new worktree (implement, review, an adopted pull request head); null when the session starts in an existing worktree. */
  readonly branch: string | null;
  /** Branch the daemon fetches from origin and creates `branch` from when it does not exist locally (review, adoption); null otherwise. */
  readonly baseBranch: string | null;
  /** Commit the new worktree must hold after the launch (review, adoption); null when it is not checked. */
  readonly expectedHead: string | null;
  /** Existing worktree (babysit, fix-ci, rebase on a row whose linked session owns one); null when the daemon creates one. */
  readonly cwd: string | null;
  readonly name: string;
  readonly metadata: Readonly<Record<string, string>>;
  /** Arguments after `pohunek session new`, without `--json`. */
  readonly args: readonly string[];
  /** Prompt sent on stdin; never part of argv. */
  readonly prompt: string;
}

export interface ActionResult {
  readonly sessionId: string;
  readonly name: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  /** Kinds of the daemon's launch warnings; empty when the launch went as requested. */
  readonly warnings: readonly string[];
  /**
   * Adoption only: the worktree head read after the launch differs from the pull request head. The agent
   * may have legitimately advanced the branch since the launch, so it is reported, not treated as a failure.
   */
  readonly headMismatch: { readonly expected: string; readonly actual: string } | null;
}

/** `gh pr ready` for one draft pull request, and the read that confirms it. */
export interface ReadyPlan {
  readonly action: "ready";
  readonly key: string;
  readonly project: string;
  /** `owner/name#number`. */
  readonly pullRequest: string;
  readonly argv: readonly string[];
  readonly verifyArgv: readonly string[];
}

/** `pohunek attach` to the one live linked session of a row. */
export interface AttachPlan {
  readonly action: "attach";
  readonly key: string;
  readonly project: string;
  readonly sessionId: string;
  readonly argv: readonly string[];
}
