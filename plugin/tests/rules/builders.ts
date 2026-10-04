// Synthetic builders for rule tests; every value is invented.
import type { IdentityConfig, IssueSource } from "../../src/types/config.ts";
import type { SourceStatuses, WorkItem } from "../../src/types/item.ts";
import type {
  Actor,
  Check,
  Issue,
  MergedPullRequest,
  PohunekNotification,
  PohunekSession,
  PullRequest,
  Review,
  ReviewRequest,
  Thread,
  TimelineEvent,
} from "../../src/types/sources.ts";
import type { RuleInput } from "../../src/rules.ts";

export const identity: IdentityConfig = {
  githubLogin: "owner-me",
  agentIdentities: ["agent-bot-me"],
  reviewTeams: ["acme/reviewers"],
};

export const project = { ignoredChecks: ["CD / Enqueue E2E"], policyChecks: ["Require label"], aiReviewers: ["ai-helper"], issueSource: { kind: "linear", team: "ABC", pausedStates: ["On hold"] } satisfies IssueSource };

export const allOk: SourceStatuses = { github: "ok", github_merged: "ok", linear: "ok", pohunek: "ok" };

export const T0 = "2026-05-01T10:00:00Z";
export const T1 = "2026-05-01T11:00:00Z";
export const T2 = "2026-05-01T12:00:00Z";
export const T3 = "2026-05-01T13:00:00Z";

export function actor(login: string, isBot = false): Actor {
  return { login, isBot };
}

export function review(
  login: string,
  state: Review["state"],
  submittedAt: string | null,
  isBot = false,
): Review {
  return { id: `r-${login}-${String(submittedAt)}`, author: actor(login, isBot), state, submittedAt };
}

export function thread(
  comments: readonly { login: string; at: string }[],
  isResolved = false,
): Thread {
  return {
    id: "t-1",
    isResolved,
    isOutdated: false,
    comments: comments.map((c) => ({ author: actor(c.login), createdAt: c.at })),
  };
}

export function commit(at: string): TimelineEvent {
  return { kind: "commit", at };
}

export function user(login: string): ReviewRequest {
  return { kind: "user", login };
}

export function check(name: string, outcome: Check["outcome"]): Check {
  return { name, outcome };
}

export function mergedPr(overrides: Partial<MergedPullRequest> = {}): MergedPullRequest {
  return {
    id: "acme/widgets#7",
    number: 7,
    url: "https://example.invalid/acme/widgets/pull/7",
    title: "Add widget cache",
    headRefName: "alice/ABC-1/widget-cache",
    mergedAt: "2026-10-02T10:00:00Z",
    ...overrides,
  };
}

export function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: "acme/widgets#12",
    repo: "acme/widgets",
    number: 12,
    url: "https://example.invalid/acme/widgets/pull/12",
    title: "Add widget cache",
    author: actor("owner-me"),
    relation: "authored",
    isDraft: false,
    isCrossRepository: false,
    headRefName: "abc-1-widget-cache",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    baseRefName: "main",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    reviews: [],
    threads: [],
    timeline: [],
    reviewRequests: [],
    checks: [],
    updatedAt: T3,
    ...overrides,
  };
}

export function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "ABC-1",
    title: "Widget cache",
    url: "https://example.invalid/issue/ABC-1",
    state: "In Progress",
    started: true,
    paused: false,
    assigneeIsMe: true,
    attachmentUrls: [],
    ...overrides,
  };
}

export function session(overrides: Partial<PohunekSession> = {}): PohunekSession {
  return {
    id: "s-1",
    name: "impl",
    projectLabel: "widgets",
    branch: null,
    worktreePath: null,
    cwd: null,
    state: "running",
    activity: "idle",
    runtimeState: "connected",
    metadata: {},
    ...overrides,
  };
}

export function notification(
  overrides: Partial<PohunekNotification> = {},
): PohunekNotification {
  return {
    id: "n-1",
    kind: "agent_blocked",
    status: "unread",
    sessionId: "s-1",
    createdAt: T1,
    ...overrides,
  };
}

export function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    key: "github:acme/widgets#12",
    project: "widgets",
    issue: null,
    pullRequest: pr(),
    mergedPullRequest: null,
    joinedBy: null,
    noIssue: true,
    issueKey: null,
    sessions: [],
    notifications: [],
    ...overrides,
  };
}

export function input(
  itemValue: WorkItem,
  sources: SourceStatuses = allOk,
  projectValue: RuleInput["project"] = project,
): RuleInput {
  return { item: itemValue, sources, identity, project: projectValue };
}

/** CHANGES_REQUESTED by `rev` at T1, fix at T2, thread answered at T2, re-requested, checks green. */
export function deliveredPr(overrides: Partial<PullRequest> = {}): PullRequest {
  return pr({
    reviewDecision: "CHANGES_REQUESTED",
    reviews: [review("rev-one", "CHANGES_REQUESTED", T1)],
    timeline: [commit(T2)],
    threads: [
      thread([
        { login: "rev-one", at: T1 },
        { login: "owner-me", at: T2 },
      ]),
    ],
    reviewRequests: [user("rev-one")],
    checks: [check("build", "success")],
    ...overrides,
  });
}
