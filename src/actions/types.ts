// Shared types of the write actions (`pohunek-work do`).

/** Version of the `do --json` contract; bumped on any incompatible change. */
export const DO_CONTRACT_VERSION = 1;

export type LaunchAction = "implement" | "babysit";

export const LAUNCH_ACTIONS: readonly LaunchAction[] = ["implement", "babysit"];

export type RefusalCode =
  | "unknown_item"
  | "ambiguous_item"
  | "source_unavailable"
  | "precondition_failed"
  | "already_running"
  | "no_worktree"
  | "no_profile"
  | "invalid_value"
  | "confirmation_required"
  | "launch_failed"
  | "launch_timed_out"
  | "launch_unverified";

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
  /** New branch (implement); null when the session starts in an existing worktree. */
  readonly branch: string | null;
  /** Existing worktree (babysit); null when the daemon creates one. */
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
}
