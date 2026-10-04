// The `on_turn` rules of RFC section 8: a pure function over normalized data.
import type { IdentityConfig, ProjectConfig } from "./types/config.ts";
import {
  POLICY_CHECK_REASON_PREFIX,
  type ChangesRequestedProgress,
  type MeReason,
  type OnTurn,
  type RuleNumber,
  type SourceStatuses,
  type WorkItem,
} from "./types/item.ts";
import type {
  Actor,
  Check,
  PohunekSession,
  PullRequest,
  Review,
  SourceName,
} from "./types/sources.ts";

export interface RuleInput {
  readonly item: WorkItem;
  readonly sources: SourceStatuses;
  readonly identity: IdentityConfig;
  readonly project: Pick<ProjectConfig, "ignoredChecks" | "policyChecks" | "aiReviewers" | "pausedStates">;
}

export interface RuleResult {
  readonly onTurn: OnTurn;
  /** Aggregate of the rule 4 sub-conditions; null when no reviewer requested changes or github is not ok. */
  readonly progress: ChangesRequestedProgress | null;
}

export type ChecksSummary = "success" | "failure" | "pending" | "none";

const BOT_SUFFIX = /\[bot\]$/i;

/** Lowercased login without a `[bot]` suffix, the form used for every login comparison. */
function normalizeLogin(login: string): string {
  return login.replace(BOT_SUFFIX, "").toLowerCase();
}

/** A session is live when it runs and its runtime is not lost (an absent runtime block counts as not lost). */
export function isLiveSession(session: PohunekSession): boolean {
  return session.state === "running" && session.runtimeState !== "lost";
}

/** Check names in `ignoredChecks` are removed by exact match before summarizing. */
export function summarizeChecks(
  checks: readonly Check[],
  ignoredChecks: readonly string[],
): ChecksSummary {
  const relevant = checks.filter((check) => !ignoredChecks.includes(check.name));
  if (relevant.length === 0) return "none";
  if (relevant.some((check) => check.outcome === "failure")) return "failure";
  if (relevant.some((check) => check.outcome === "pending")) return "pending";
  return "success";
}

/** Names of failing checks, each listed once; ignored checks are left out. */
export interface FailingChecks {
  /** Checks an agent can fix, in the order GitHub reports them. */
  readonly ci: readonly string[];
  /** Failing `policyChecks` entries, in configuration order. */
  readonly policy: readonly string[];
}

/** Splits the failing checks into CI and policy failures by exact name. */
export function failingChecks(
  checks: readonly Check[],
  project: Pick<ProjectConfig, "ignoredChecks" | "policyChecks">,
): FailingChecks {
  const failed = new Set(
    checks
      .filter((check) => check.outcome === "failure" && !project.ignoredChecks.includes(check.name))
      .map((check) => check.name),
  );
  return {
    ci: [...failed].filter((name) => !project.policyChecks.includes(name)),
    policy: project.policyChecks.filter((name) => failed.has(name)),
  };
}

export function isAiReviewer(actor: Actor | null, aiReviewers: readonly string[]): boolean {
  if (actor === null) return false;
  const login = normalizeLogin(actor.login);
  return aiReviewers.some((configured) => normalizeLogin(configured) === login);
}

function instant(iso: string | null): number {
  return iso === null ? Number.NaN : Date.parse(iso);
}

/** True when `iso` is a valid instant strictly after `reference`; unparsable values never count. */
function isAfter(iso: string, reference: number): boolean {
  return instant(iso) > reference;
}

/**
 * Reviews that decide whether a reviewer still blocks the PR: PENDING reviews
 * have no submit time and COMMENTED reviews do not change a requested change.
 */
function isDecisiveReview(review: Review): boolean {
  return (
    review.author !== null &&
    review.state !== "PENDING" &&
    review.state !== "COMMENTED" &&
    !Number.isNaN(instant(review.submittedAt))
  );
}

/** Latest decisive review per human, non-AI reviewer, kept only when it is CHANGES_REQUESTED. */
function changesRequestedReviews(
  pr: PullRequest,
  aiReviewers: readonly string[],
): readonly Review[] {
  const latest = new Map<string, Review>();
  for (const review of pr.reviews) {
    const author = review.author;
    if (!isDecisiveReview(review) || author === null) continue;
    if (author.isBot || isAiReviewer(author, aiReviewers)) continue;
    const key = normalizeLogin(author.login);
    const current = latest.get(key);
    if (current === undefined || instant(review.submittedAt) >= instant(current.submittedAt)) {
      latest.set(key, review);
    }
  }
  return [...latest.values()].filter((review) => review.state === "CHANGES_REQUESTED");
}

function evaluateReview(
  review: Review,
  pr: PullRequest,
  identity: IdentityConfig,
): ChangesRequestedProgress {
  const submitted = instant(review.submittedAt);
  const reviewer = normalizeLogin(review.author?.login ?? "");

  const fixDelivered = pr.timeline.some((event) => isAfter(event.at, submitted));

  const answerers = new Set<string>(identity.agentIdentities.map(normalizeLogin));
  if (pr.author !== null) answerers.add(normalizeLogin(pr.author.login));
  const threadsAnswered = pr.threads
    .filter(
      (thread) =>
        !thread.isResolved &&
        thread.comments.some(
          (comment) =>
            comment.author !== null && normalizeLogin(comment.author.login) === reviewer,
        ),
    )
    .every((thread) => {
      const last = thread.comments.at(-1);
      return (
        last?.author !== undefined &&
        last.author !== null &&
        answerers.has(normalizeLogin(last.author.login)) &&
        isAfter(last.createdAt, submitted)
      );
    });

  // A newer APPROVED or DISMISSED review replaces R in changesRequestedReviews, and a
  // COMMENTED review does not hand the turn back, so only a new request counts here.
  const rerequested = pr.reviewRequests.some(
    (request) => request.kind === "user" && normalizeLogin(request.login) === reviewer,
  );
  return { fixDelivered, threadsAnswered, rerequested };
}

/** Rule 4 evaluation; null when no reviewer requested changes. */
function evaluateChangesRequested(
  pr: PullRequest,
  identity: IdentityConfig,
  aiReviewers: readonly string[],
): ChangesRequestedProgress | null {
  const reviews = changesRequestedReviews(pr, aiReviewers);
  if (reviews.length === 0) return null;
  const parts = reviews.map((review) => evaluateReview(review, pr, identity));
  return {
    fixDelivered: parts.every((part) => part.fixDelivered),
    threadsAnswered: parts.every((part) => part.threadsAnswered),
    rerequested: parts.every((part) => part.rerequested),
  };
}

function failedSources(
  sources: SourceStatuses,
  needed: readonly SourceName[],
): string | null {
  const failed = needed.flatMap((name) => {
    const status = sources[name];
    return status === "ok" ? [] : [`${name}:${status}`];
  });
  return failed.length === 0 ? null : failed.join(", ");
}

function me(reason: MeReason, rule: RuleNumber): OnTurn {
  return { actor: "me", reason, rule };
}

/**
 * Evaluates the rules in RFC 8.1 order (1, 2, 12, 3 to 8, 13, 11, 9, 10); the first
 * rule that holds decides.
 */
export function evaluateOnTurn(input: RuleInput): RuleResult {
  const { item, sources, identity, project } = input;
  const pr = item.pullRequest;
  const authored = pr !== null && pr.relation === "authored" ? pr : null;

  const progress =
    authored !== null && sources.github === "ok"
      ? evaluateChangesRequested(authored, identity, project.aiReviewers)
      : null;
  const result = (onTurn: OnTurn): RuleResult => ({ onTurn, progress });
  const unknown = (reason: string): RuleResult =>
    result({ actor: "unknown", reason, rule: null });

  // Rules 1 and 2: pohunek.
  const pohunekFailure = failedSources(sources, ["pohunek"]);
  if (pohunekFailure !== null) return unknown(pohunekFailure);

  const linkedIds = new Set(item.sessions.map((session) => session.id));
  const blocked = item.notifications.some(
    (notification) =>
      notification.sessionId !== null &&
      linkedIds.has(notification.sessionId) &&
      (notification.kind === "agent_blocked" || notification.kind === "approval_required") &&
      (notification.status === "unread" || notification.status === "read"),
  );
  if (blocked) return result(me("answer agent", 1));

  const liveSessions = item.sessions.filter(isLiveSession);
  if (liveSessions.some((session) => session.activity === "working")) {
    return result({ actor: "agent", reason: "working", rule: 2 });
  }

  // Rule 12: linear. A row joined to an issue key whose issue Linear did not
  // return may be paused, so it is unknown while Linear is down.
  if (project.pausedStates.length > 0) {
    if (item.issue === null && item.joinedBy !== null) {
      const linearFailure = failedSources(sources, ["linear"]);
      if (linearFailure !== null) return unknown(linearFailure);
    }
    if (item.issue !== null && project.pausedStates.includes(item.issue.stateName)) {
      return result({ actor: "paused", reason: "paused", rule: 12 });
    }
  }

  // Rules 3 to 7 and 9: github.
  const githubFailure = failedSources(sources, ["github"]);
  if (githubFailure !== null) return unknown(githubFailure);

  if (pr !== null && pr.relation === "review_requested") return result(me("review", 3));

  if (authored !== null) {
    if (progress !== null && !(progress.fixDelivered && progress.threadsAnswered && progress.rerequested)) {
      return result(me("respond", 4));
    }
    // A rebase reruns every check, so a conflict comes before any failure.
    if (authored.mergeable === "CONFLICTING") return result(me("rebase", 5));
    const failing = failingChecks(authored.checks, project);
    if (failing.ci.length > 0) return result(me("fix CI", 5));
    if (failing.policy.length > 0) {
      return result(me(`${POLICY_CHECK_REASON_PREFIX}${failing.policy.join(", ")}`, 5));
    }
    if (authored.isDraft) return result(me("leave draft", 6));
    if (
      authored.reviewDecision === "APPROVED" &&
      ["success", "none"].includes(summarizeChecks(authored.checks, project.ignoredChecks))
    ) {
      if (authored.mergeable === "MERGEABLE") return result(me("merge", 7));
      // GitHub has not computed mergeability yet; the row cannot be called merge-ready or waiting.
      return unknown("github:mergeable_unknown");
    }
  }

  // Rule 8: github and pohunek, plus linear when the row has an issue.
  const issue = item.issue;
  if (issue !== null) {
    const linearFailure = failedSources(sources, ["linear"]);
    if (linearFailure !== null) return unknown(linearFailure);
    if (issue.stateType === "started" && issue.assigneeIsMe && pr === null) {
      if (liveSessions.length === 0) {
        // A merged pull request already delivered the work; a new implementation would duplicate it.
        if (item.mergedPullRequest !== null) return result(me("close or follow up", 13));
        return result(me("nothing runs", 8));
      }
      // Rule 2 did not hold, so every live session is idle: the agent ended its turn and no PR exists yet.
      return result(me("check agent", 11));
    }
  }

  if (
    authored !== null &&
    authored.reviewRequests.length === 0 &&
    (authored.reviewDecision === null || authored.reviewDecision === "REVIEW_REQUIRED")
  ) {
    return result(me("request review", 9));
  }

  return result({ actor: "reviewer", reason: "waiting", rule: 10 });
}
