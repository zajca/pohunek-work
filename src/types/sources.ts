// Normalized source data. Sources translate provider payloads into these
// types; rules and join work on nothing else. Provider free text other than
// titles is never carried (no comment or review bodies).

export type SourceName = "github" | "linear" | "pohunek";

/** Stable, provider-independent failure codes shown in `sources` and `on_turn.reason`. */
export type SourceErrorCode =
  | "timeout"
  | "unauthenticated"
  | "rate_limited"
  | "unavailable"
  | "truncated"
  | "invalid_response"
  | "protocol_mismatch"
  | "origin_environment"
  | "not_configured";

export interface SourceFailure {
  readonly ok: false;
  readonly source: SourceName;
  readonly code: SourceErrorCode;
  /** Human-readable detail; never contains a secret or provider free text. */
  readonly message: string;
  readonly durationMs: number;
}

export interface SourceSuccess<T> {
  readonly ok: true;
  readonly source: SourceName;
  readonly data: T;
  readonly durationMs: number;
}

export type SourceResult<T> = SourceSuccess<T> | SourceFailure;

// ---------------------------------------------------------------- GitHub

export type ReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** How the authenticated owner relates to the pull request. */
export type PullRequestRelation = "authored" | "review_requested";

export interface Actor {
  /** Login without any `[bot]` suffix. */
  readonly login: string;
  readonly isBot: boolean;
}

export interface Review {
  readonly id: string;
  readonly author: Actor | null;
  readonly state: ReviewState;
  /** ISO-8601; null for a pending review. */
  readonly submittedAt: string | null;
}

export interface ThreadComment {
  readonly author: Actor | null;
  readonly createdAt: string;
}

export interface Thread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  /** Oldest first. */
  readonly comments: readonly ThreadComment[];
}

export type TimelineEventKind = "commit" | "force_push";

export interface TimelineEvent {
  readonly kind: TimelineEventKind;
  /** ISO-8601 commit committedDate or force push createdAt. */
  readonly at: string;
}

/** A review request is either a user or a team. */
export type ReviewRequest =
  | { readonly kind: "user"; readonly login: string }
  | { readonly kind: "team"; readonly slug: string };

export type CheckOutcome = "success" | "failure" | "pending" | "neutral";

export interface Check {
  /** CheckRun name or StatusContext context, exactly as GitHub reports it. */
  readonly name: string;
  readonly outcome: CheckOutcome;
}

export interface PullRequest {
  /** `owner/name#number`. */
  readonly id: string;
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly author: Actor | null;
  readonly relation: PullRequestRelation;
  readonly isDraft: boolean;
  readonly headRefName: string;
  /** Commit SHA of the branch head. */
  readonly headSha: string;
  readonly baseRefName: string;
  readonly reviewDecision: ReviewDecision | null;
  readonly mergeable: Mergeable;
  readonly reviews: readonly Review[];
  readonly threads: readonly Thread[];
  readonly timeline: readonly TimelineEvent[];
  readonly reviewRequests: readonly ReviewRequest[];
  /** Latest-commit checks; empty when the commit has no checks. */
  readonly checks: readonly Check[];
  readonly updatedAt: string;
}

// ---------------------------------------------------------------- Linear

export type LinearStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export interface LinearCycle {
  readonly number: number;
  readonly name: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface LinearAttachment {
  readonly url: string;
}

export interface LinearIssue {
  /** Team-scoped identifier, e.g. `DMD-2188`. */
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly stateName: string;
  readonly stateType: LinearStateType;
  readonly teamKey: string;
  readonly assigneeIsMe: boolean;
  readonly cycle: LinearCycle | null;
  readonly attachments: readonly LinearAttachment[];
}

// --------------------------------------------------------------- Pohunek

export type SessionState = "running" | "stopped" | "done" | (string & {});

export type SessionActivity = "working" | "idle" | (string & {});

export interface PohunekSession {
  readonly id: string;
  readonly name: string | null;
  readonly projectLabel: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  /** Working directory of the session; null when pohunek omits it. */
  readonly cwd: string | null;
  readonly state: SessionState;
  readonly activity: SessionActivity | null;
  /** `runtime.state` (for example `lost`); null when the runtime block is absent. */
  readonly runtimeState: string | null;
  /** Empty when the session has no metadata (pohunek omits the field). */
  readonly metadata: Readonly<Record<string, string>>;
}

export type NotificationKind =
  | "agent_blocked"
  | "approval_required"
  | "turn_completed"
  | "session_finished"
  | "error"
  | "system";

export type NotificationStatus =
  | "unread"
  | "read"
  | "acknowledged"
  | "archived"
  | "deleted";

export interface PohunekNotification {
  readonly id: string;
  readonly kind: NotificationKind | (string & {});
  readonly status: NotificationStatus;
  readonly sessionId: string | null;
  readonly createdAt: string;
}

export interface PohunekProject {
  readonly id: string;
  readonly label: string;
  readonly originUrl: string | null;
  readonly defaultBaseBranch: string | null;
}

/** Everything the rules need from pohunek. */
export interface PohunekSnapshot {
  readonly sessions: readonly PohunekSession[];
  readonly notifications: readonly PohunekNotification[];
}
