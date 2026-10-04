// Joined work items, the `on_turn` verdict and the `list --json` contract.
import type {
  Mergeable,
  PohunekNotification,
  PohunekSession,
  PullRequest,
  ReviewDecision,
  SourceErrorCode,
  SourceName,
  LinearIssue,
  MergedPullRequest,
} from "./sources.ts";

/** Version of the `list --json` contract; bumped on any incompatible change. */
export const LIST_CONTRACT_VERSION = 1;

/** Per-source availability for one poll: `ok` or the stable failure code. */
export type SourceStatus = "ok" | SourceErrorCode;
/**
 * `github_merged` is the merged pull request lookup behind rule 13; it is kept
 * apart from `github` so its failure only affects the rows that rule decides.
 */
export type SourceStatuses = Readonly<Record<SourceName | "github_merged", SourceStatus>>;

/** `paused`: the joined issue is in a configured paused state, so the row is on nobody's turn. */
export type TurnActor = "me" | "agent" | "reviewer" | "paused" | "unknown";

/** Rule numbers of RFC section 8.1. */
export type RuleNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

/** Prefix of the rule 5 reason for a pull request whose only failures are policy checks. */
export const POLICY_CHECK_REASON_PREFIX = "policy check: ";

export type MeReason =
  | "answer agent"
  | "review"
  | "respond"
  | "fix CI"
  /** Names the failing `policy_checks` entries, e.g. `policy check: Require label`. */
  | `${typeof POLICY_CHECK_REASON_PREFIX}${string}`
  | "rebase"
  | "leave draft"
  | "merge"
  | "nothing runs"
  | "check agent"
  | "close or follow up"
  | "request review";

export type OnTurn =
  | { readonly actor: "me"; readonly reason: MeReason; readonly rule: RuleNumber }
  | { readonly actor: "agent"; readonly reason: "working"; readonly rule: 2 }
  | { readonly actor: "reviewer"; readonly reason: "waiting"; readonly rule: 10 }
  | { readonly actor: "paused"; readonly reason: "paused"; readonly rule: 12 }
  /** `reason` lists the failed sources, e.g. `github:rate_limited`. */
  | { readonly actor: "unknown"; readonly reason: string; readonly rule: null };

/** Rule 4 sub-conditions (RFC 8.2); null when rule 4 had no reviewer to evaluate. */
export interface ChangesRequestedProgress {
  readonly fixDelivered: boolean;
  readonly threadsAnswered: boolean;
  readonly rerequested: boolean;
}

export type JoinMatch = "session_link" | "linear_attachment" | "branch_pattern";

/** One table row before rules run. */
export interface WorkItem {
  /** `linear:DMD-2188` or `github:keboola/connection#8605`. */
  readonly key: string;
  /** Pohunek project label. */
  readonly project: string;
  readonly issue: LinearIssue | null;
  readonly pullRequest: PullRequest | null;
  /**
   * Merged pull request that resolves to the issue of a row without an open
   * pull request (RFC 7.3 precedence); null otherwise.
   */
  readonly mergedPullRequest: MergedPullRequest | null;
  /** How the pull request was attached to the issue; null without a join. */
  readonly joinedBy: JoinMatch | null;
  /** A pull request without a Linear issue. */
  readonly noIssue: boolean;
  /** Sessions linked to this item, in pohunek order. */
  readonly sessions: readonly PohunekSession[];
  /** Notifications of the linked sessions. */
  readonly notifications: readonly PohunekNotification[];
}

export interface UnlinkedSession {
  readonly id: string;
  readonly name: string | null;
  readonly project: string;
  readonly state: string;
  readonly activity: string | null;
}

export interface OrphanedSession {
  readonly id: string;
  readonly name: string | null;
  readonly linkId: string;
}

// ----------------------------------------------------- list --json contract

export interface ListIssue {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly url: string;
}

export interface ListPullRequest {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly draft: boolean;
  /** ISO-8601 time of the last change on GitHub. */
  readonly updated_at: string;
  readonly review_decision: ReviewDecision | null;
  /** `success`, `failure`, `pending` or `none` after ignored checks are removed. */
  readonly checks: "success" | "failure" | "pending" | "none";
  readonly mergeable: Mergeable;
  /** Null when the item has no changes-requested reviewer. */
  readonly fix_delivered: boolean | null;
  readonly threads_answered: boolean | null;
  readonly rerequested: boolean | null;
}

export interface ListSession {
  readonly id: string;
  readonly name: string | null;
  readonly role: string | null;
  readonly state: string;
  readonly activity: string | null;
}

export interface ListAction {
  readonly name: string;
  readonly delegable: boolean;
  readonly profile?: string;
}

export interface ListOnTurn {
  readonly actor: TurnActor;
  readonly reason: string;
  readonly rule: RuleNumber | null;
}

export interface ListItem {
  readonly key: string;
  readonly project: string;
  readonly issue: ListIssue | null;
  readonly pull_request: ListPullRequest | null;
  readonly no_issue: boolean;
  readonly sessions: readonly ListSession[];
  readonly on_turn: ListOnTurn;
  readonly actions: readonly ListAction[];
  readonly sources: SourceStatuses;
}

/** Source availability of one project's poll, independent of any row filter. */
export interface ListProjectStatus {
  readonly project: string;
  readonly sources: SourceStatuses;
}

export interface ListPayload {
  readonly items: readonly ListItem[];
  readonly orphaned_sessions: readonly OrphanedSession[];
  /** Live sessions without a work link; `gc --adopt` links them later. */
  readonly unlinked_sessions: readonly UnlinkedSession[];
  readonly projects: readonly ListProjectStatus[];
}

export interface ListError {
  readonly class: string;
  readonly code: string;
  readonly msg: string;
  readonly recover?: string;
}

/** Envelope shaped like the pohunek CLI one; `protocol` carries the plugin contract version. */
export type ListEnvelope =
  | {
      readonly cli_version: string;
      readonly protocol: { readonly minimum: number; readonly maximum: number };
      readonly ok: ListPayload;
    }
  | {
      readonly cli_version: string;
      readonly protocol: { readonly minimum: number; readonly maximum: number };
      readonly err: ListError;
    };
