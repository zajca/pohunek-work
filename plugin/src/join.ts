// Joins normalized source data into table rows (RFC section 7).
import {
  isSourceFailure,
  type JoinMatch,
  type OrphanedSession,
  type SourceStatuses,
  type WorkItem,
} from "./types/item.ts";
import { isLinearProject, pausedStatesOf } from "./config/issue-source.ts";
import type { ProjectConfig } from "./types/config.ts";
import { isLiveSession } from "./sources/pohunek.ts";
import type {
  LinearIssue,
  MergedPullRequest,
  PohunekNotification,
  PohunekSession,
  PullRequest,
} from "./types/sources.ts";

export interface JoinInput {
  readonly project: ProjectConfig;
  readonly issues: readonly LinearIssue[];
  readonly pullRequests: readonly PullRequest[];
  /** Merged pull requests of the owner; they explain issue-only rows and never form rows. */
  readonly mergedPullRequests: readonly MergedPullRequest[];
  readonly sessions: readonly PohunekSession[];
  readonly notifications: readonly PohunekNotification[];
  readonly sources: SourceStatuses;
}

export interface JoinResult {
  readonly items: WorkItem[];
  readonly orphanedSessions: OrphanedSession[];
  /** Live sessions of the project without any link; never attached to a row by guessing. */
  readonly unlinkedSessions: PohunekSession[];
}

// Plugin namespace and the namespace written by pohunek's own provider launch path.
const PLUGIN_KEYS = { provider: "work.link.provider", id: "work.link.id", branch: "work.link.branch" } as const;
const LEGACY_KEYS = { provider: "link.provider", id: "link.id", branch: "link.branch" } as const;

interface LinkedSession {
  readonly session: PohunekSession;
  readonly provider: string | null;
  readonly linkId: string;
  readonly branch: string | null;
}

interface PrResolution {
  readonly key: string;
  readonly joinedBy: JoinMatch;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/**
 * Link of a session: `work.link.*` wins; otherwise the legacy `link.*` keys. The
 * namespaces are never mixed field by field. A legacy GitHub pull request id is
 * the bare number, which becomes `owner/name#number` for the project.
 */
function linkOf(project: ProjectConfig, session: PohunekSession): Omit<LinkedSession, "session"> | null {
  const plugin = nonEmpty(session.metadata[PLUGIN_KEYS.id]);
  const keys = plugin !== null ? PLUGIN_KEYS : LEGACY_KEYS;
  const id = plugin ?? nonEmpty(session.metadata[LEGACY_KEYS.id]);
  if (id === null) return null;
  const provider = nonEmpty(session.metadata[keys.provider]);
  const linkId =
    keys === LEGACY_KEYS && provider === "github" && /^\d+$/.test(id) ? `${project.repo}#${id}` : id;
  return { provider, linkId, branch: nonEmpty(session.metadata[keys.branch]) };
}

/** Sessions of the project that carry a link id; the rest never take part in the join. */
function linkedSessionsOf(
  project: ProjectConfig,
  sessions: readonly PohunekSession[],
): LinkedSession[] {
  const linked: LinkedSession[] = [];
  for (const session of sessions) {
    if (session.projectLabel !== project.pohunekLabel) continue;
    const link = linkOf(project, session);
    if (link !== null) linked.push({ session, ...link });
  }
  return linked;
}

/** Group `key` of the branch pattern; the regex is reset so a global or sticky flag cannot skip matches. */
export function keyFromBranch(pattern: RegExp, headRefName: string): string | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(headRefName);
  pattern.lastIndex = 0;
  const key = match?.groups?.["key"];
  return key === undefined || key === "" ? null : key;
}

/** First match of RFC 7.3 precedence: session link, Linear attachment, branch pattern. */
function resolveIssueKey(
  pr: Pick<PullRequest, "url" | "headRefName">,
  project: ProjectConfig,
  issues: readonly LinearIssue[],
  linked: readonly LinkedSession[],
): PrResolution | null {
  // A github-provider link carries no Linear key, so this level yields nothing for it.
  const bySession = linked.find(
    (l) => l.provider === "linear" && l.branch !== null && l.branch === pr.headRefName,
  );
  if (bySession !== undefined) {
    return { key: bySession.linkId, joinedBy: "session_link" };
  }

  const byAttachment = issues.find((issue) =>
    issue.attachments.some((attachment) => attachment.url === pr.url),
  );
  if (byAttachment !== undefined) {
    return { key: byAttachment.id, joinedBy: "linear_attachment" };
  }

  const byBranch = keyFromBranch(project.branchPattern, pr.headRefName);
  if (byBranch !== null) {
    return { key: byBranch, joinedBy: "branch_pattern" };
  }
  return null;
}

interface RowDraft {
  readonly key: string;
  readonly issue: LinearIssue | null;
  /** Key sessions attach to; null on a secondary pull request row, which no session may claim by key. */
  readonly issueKey: string | null;
  /** Issue key the row resolved to, including on a secondary pull request row; null without a match. */
  readonly resolvedKey: string | null;
  readonly pullRequest: PullRequest | null;
  readonly mergedPullRequest: MergedPullRequest | null;
  readonly joinedBy: JoinMatch | null;
  readonly noIssue: boolean;
}

const RANK: Readonly<Record<JoinMatch, number>> = {
  session_link: 0,
  linear_attachment: 1,
  branch_pattern: 2,
};

interface Candidate {
  readonly pr: PullRequest;
  readonly resolution: PrResolution | null;
}

/**
 * Per issue key, the pull request with the strongest precedence level wins;
 * ties go to the lowest pull request number, so the choice does not depend on
 * the order GitHub returns the search results in.
 */
function claimWinners(candidates: readonly Candidate[]): Map<string, PullRequest> {
  const winners = new Map<string, { pr: PullRequest; rank: number }>();
  for (const { pr, resolution } of candidates) {
    if (resolution === null) continue;
    const rank = RANK[resolution.joinedBy];
    const current = winners.get(resolution.key);
    if (current === undefined || rank < current.rank || (rank === current.rank && pr.number < current.pr.number)) {
      winners.set(resolution.key, { pr, rank });
    }
  }
  return new Map([...winners].map(([key, value]) => [key, value.pr]));
}

/**
 * Per issue key, the most recently merged pull request that resolves to it by
 * RFC 7.3 precedence; ties go to the highest number. A merged pull request
 * without a match is dropped: it never becomes a row.
 */
function claimMerged(
  merged: readonly MergedPullRequest[],
  project: ProjectConfig,
  issues: readonly LinearIssue[],
  linked: readonly LinkedSession[],
): Map<string, MergedPullRequest> {
  const winners = new Map<string, MergedPullRequest>();
  for (const pr of merged) {
    const resolution = resolveIssueKey(pr, project, issues, linked);
    if (resolution === null) continue;
    const current = winners.get(resolution.key);
    if (current === undefined || Date.parse(pr.mergedAt) > Date.parse(current.mergedAt) ||
      (Date.parse(pr.mergedAt) === Date.parse(current.mergedAt) && pr.number > current.number)) {
      winners.set(resolution.key, pr);
    }
  }
  return winners;
}

/** Source that must be `ok` before a session without a row may be called orphaned. */
function sourcesToConcludeOrphan(provider: string | null): readonly ("github" | "linear")[] {
  if (provider === "github") return ["github"];
  return ["github", "linear"];
}

/**
 * Builds the table rows and the orphaned sessions.
 *
 * Row order: pull requests in input order, then issue-only rows in issue order;
 * an issue-only row carries the merged pull request that resolves to its issue.
 * Only `authored` pull requests are joined to issues. When several pull
 * requests resolve to the same issue key, the strongest match joins the issue
 * row (see claimWinners); the others become their own `github:` rows with
 * `noIssue` false, because the issue exists (or is known by key) and only one
 * row may carry a `linear:<KEY>` key; they still report that key as `issueKey`. A session attaches to exactly one row. A
 * session without a row is reported as orphaned only when the sources that
 * could have matched it are `ok` and its issue is not in a paused state.
 */
export function joinItems(input: JoinInput): JoinResult {
  const { project, issues, pullRequests, mergedPullRequests, sessions, notifications, sources } = input;
  const usesLinear = isLinearProject(project);
  const linked = linkedSessionsOf(project, sessions);
  const issuesById = new Map<string, LinearIssue>();
  for (const issue of issues) {
    if (!issuesById.has(issue.id)) issuesById.set(issue.id, issue);
  }

  const candidates: Candidate[] = pullRequests.map((pr) => ({
    pr,
    resolution: pr.relation === "authored" && usesLinear ? resolveIssueKey(pr, project, issues, linked) : null,
  }));
  const winners = claimWinners(candidates);

  const mergedByKey = usesLinear ? claimMerged(mergedPullRequests, project, issues, linked) : new Map<string, MergedPullRequest>();

  const drafts: RowDraft[] = [];
  const claimedKeys = new Set<string>();

  for (const { pr, resolution } of candidates) {
    if (resolution === null) {
      drafts.push({
        key: `github:${pr.id}`,
        issue: null,
        issueKey: null,
        resolvedKey: null,
        pullRequest: pr,
        mergedPullRequest: null,
        joinedBy: null,
        // Review requests of others are never joined; for authored pull requests
        // without Linear data the absence of an issue cannot be concluded.
        noIssue: pr.relation === "authored" && sources.linear === "ok",
      });
      continue;
    }
    if (winners.get(resolution.key) !== pr) {
      drafts.push({
        key: `github:${pr.id}`,
        issue: null,
        issueKey: null,
        resolvedKey: resolution.key,
        pullRequest: pr,
        mergedPullRequest: null,
        joinedBy: null,
        noIssue: false,
      });
      continue;
    }
    claimedKeys.add(resolution.key);
    drafts.push({
      key: `linear:${resolution.key}`,
      issue: issuesById.get(resolution.key) ?? null,
      issueKey: resolution.key,
      resolvedKey: resolution.key,
      pullRequest: pr,
      mergedPullRequest: null,
      joinedBy: resolution.joinedBy,
      noIssue: false,
    });
  }

  // Issues in a configured paused state are not on anyone's turn; without a pull request they get no row.
  const pausedStates = pausedStatesOf(project);
  const pausedIds = new Set(
    issues.filter((issue) => pausedStates.includes(issue.stateName)).map((issue) => issue.id),
  );
  for (const issue of issues) {
    if (claimedKeys.has(issue.id) || pausedIds.has(issue.id)) continue;
    claimedKeys.add(issue.id);
    drafts.push({
      key: `linear:${issue.id}`,
      issue,
      issueKey: issue.id,
      resolvedKey: issue.id,
      pullRequest: null,
      mergedPullRequest: mergedByKey.get(issue.id) ?? null,
      joinedBy: null,
      noIssue: false,
    });
  }

  // A link id (issue key or pull request id) outranks a branch match.
  const sessionsByRow = new Map<number, PohunekSession[]>();
  const orphanedSessions: OrphanedSession[] = [];
  for (const l of linked) {
    let target = drafts.findIndex(
      (d) => (d.issueKey !== null && d.issueKey === l.linkId) || d.pullRequest?.id === l.linkId,
    );
    if (target < 0 && l.branch !== null) {
      target = drafts.findIndex((d) => d.pullRequest?.headRefName === l.branch);
    }
    if (target >= 0) {
      sessionsByRow.set(target, [...(sessionsByRow.get(target) ?? []), l.session]);
    } else if (
      !pausedIds.has(l.linkId) &&
      sourcesToConcludeOrphan(l.provider).every((name) => !isSourceFailure(sources[name]))
    ) {
      orphanedSessions.push({ id: l.session.id, name: l.session.name, linkId: l.linkId });
    }
  }

  const items: WorkItem[] = drafts.map((draft, index) => {
    const rowSessions = sessionsByRow.get(index) ?? [];
    const sessionIds = new Set(rowSessions.map((s) => s.id));
    return {
      key: draft.key,
      project: project.pohunekLabel,
      issue: draft.issue,
      pullRequest: draft.pullRequest,
      mergedPullRequest: draft.mergedPullRequest,
      joinedBy: draft.joinedBy,
      noIssue: draft.noIssue,
      issueKey: draft.resolvedKey,
      sessions: rowSessions,
      notifications: notifications.filter(
        (n) => n.sessionId !== null && sessionIds.has(n.sessionId),
      ),
    };
  });

  const unlinkedSessions = sessions.filter(
    (session) =>
      session.projectLabel === project.pohunekLabel && isLiveSession(session) && linkOf(project, session) === null,
  );

  return { items, orphanedSessions, unlinkedSessions };
}
