// Joins normalized source data into table rows (RFC section 7).
import {
  isSourceFailure,
  type JoinMatch,
  type OrphanedSession,
  type SourceStatuses,
  type WorkItem,
} from "./types/item.ts";
import { isGithubProject, issueSourceStatusKey } from "./config/issue-source.ts";
import { issueRowKey } from "./config/row-key.ts";
import type { ProjectConfig } from "./types/config.ts";
import { isLiveSession } from "./sources/pohunek.ts";
import { samePullRequestUrl } from "./util/pr-url.ts";
import type {
  Issue,
  MergedPullRequest,
  PohunekNotification,
  PohunekSession,
  PullRequest,
  SourceName,
} from "./types/sources.ts";

export interface JoinInput {
  readonly project: ProjectConfig;
  readonly issues: readonly Issue[];
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
const PLUGIN_KEYS = { provider: "work.link.provider", kind: "work.link.kind", id: "work.link.id", branch: "work.link.branch" } as const;
const LEGACY_KEYS = { provider: "link.provider", kind: "link.kind", id: "link.id", branch: "link.branch" } as const;

interface LinkedSession {
  readonly session: PohunekSession;
  readonly provider: string | null;
  /** `issue` or `pull_request`; null when the session carries no kind. */
  readonly kind: string | null;
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
  const kind = nonEmpty(session.metadata[keys.kind]);
  let linkId = keys === LEGACY_KEYS && provider === "github" && /^\d+$/.test(id) ? `${project.repo}#${id}` : id;
  // GitHub repository names are case-insensitive; an issue link id takes the configured spelling so it equals the issue key.
  if (provider === "github" && kind === "issue" && isOwnGithubIssueKey(project, linkId)) {
    linkId = githubIssueKey(project, Number(linkId.slice(linkId.lastIndexOf("#") + 1)));
  }
  return { provider, kind, linkId, branch: nonEmpty(session.metadata[keys.branch]) };
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

/** Pull request data the issue key resolution reads; a merged pull request carries no closing references. */
type Resolvable = Pick<PullRequest, "url" | "headRefName"> & { readonly closingIssueNumbers?: readonly number[] };

const DECIMAL = /^[0-9]+$/;

export function githubIssueKey(project: ProjectConfig, number: number): string {
  return `${project.repo}#${number.toString()}`;
}

/** A link id names an issue of the project's own repository: `<owner/name>#<n>`. */
function isOwnGithubIssueKey(project: ProjectConfig, linkId: string): boolean {
  const hash = linkId.lastIndexOf("#");
  return hash > 0 && linkId.slice(0, hash).toLowerCase() === project.repo.toLowerCase() && DECIMAL.test(linkId.slice(hash + 1));
}

/** First match of RFC 7.3 precedence for a Linear project: session link, Linear attachment, branch pattern. */
function resolveLinearIssueKey(
  pr: Resolvable,
  project: ProjectConfig,
  issues: readonly Issue[],
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
    issue.attachmentUrls.some((url) => samePullRequestUrl(url, pr.url)),
  );
  if (byAttachment !== undefined) {
    return { key: byAttachment.id, joinedBy: "issue_reference" };
  }

  const byBranch = keyFromBranch(project.branchPattern, pr.headRefName);
  if (byBranch !== null) {
    return { key: byBranch, joinedBy: "branch_pattern" };
  }
  return null;
}

/**
 * RFC 7.3 precedence for a GitHub project: session link to an issue, closing
 * reference into the project's repository, branch pattern capturing an issue number.
 * A pull request that closes several issues joins the lowest-numbered one that
 * is on the table, else the lowest-numbered one.
 */
function resolveGithubIssueKey(
  pr: Resolvable,
  project: ProjectConfig,
  issues: readonly Issue[],
  linked: readonly LinkedSession[],
): PrResolution | null {
  // A pull request link (`kind` other than `issue`) carries a pull request id, which has the same shape as an issue key.
  const bySession = linked.find(
    (l) =>
      l.provider === "github" &&
      l.kind === "issue" &&
      l.branch !== null &&
      l.branch === pr.headRefName &&
      isOwnGithubIssueKey(project, l.linkId),
  );
  if (bySession !== undefined) {
    return { key: bySession.linkId, joinedBy: "session_link" };
  }

  const closing = (pr.closingIssueNumbers ?? []).map((number) => githubIssueKey(project, number));
  const byReference = closing.find((key) => issues.some((issue) => issue.id === key)) ?? closing[0];
  if (byReference !== undefined) {
    return { key: byReference, joinedBy: "issue_reference" };
  }

  const captured = keyFromBranch(project.branchPattern, pr.headRefName);
  if (captured !== null && DECIMAL.test(captured)) {
    const number = Number(captured);
    if (Number.isSafeInteger(number) && number > 0) {
      return { key: githubIssueKey(project, number), joinedBy: "branch_pattern" };
    }
  }
  return null;
}

function resolveIssueKey(
  pr: Resolvable,
  project: ProjectConfig,
  issues: readonly Issue[],
  linked: readonly LinkedSession[],
): PrResolution | null {
  return isGithubProject(project)
    ? resolveGithubIssueKey(pr, project, issues, linked)
    : resolveLinearIssueKey(pr, project, issues, linked);
}

interface RowDraft {
  readonly key: string;
  readonly issue: Issue | null;
  /** Key sessions attach to; null on a secondary pull request row, which no session may claim by key. */
  readonly issueKey: string | null;
  /** Issue key the row resolved to, including on a secondary pull request row; null without a match. */
  readonly resolvedKey: string | null;
  /** The issue behind `resolvedKey` when the issue source returned it, including on a secondary pull request row. */
  readonly resolvedIssue: Issue | null;
  readonly pullRequest: PullRequest | null;
  readonly mergedPullRequest: MergedPullRequest | null;
  readonly joinedBy: JoinMatch | null;
  readonly noIssue: boolean;
}

const RANK: Readonly<Record<JoinMatch, number>> = {
  session_link: 0,
  issue_reference: 1,
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
  issues: readonly Issue[],
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

/**
 * Sources that must be `ok` before a session without a row may be called orphaned.
 * A pull request link needs GitHub only; every other link may name an issue, so it
 * also needs the project's issue source.
 */
function sourcesToConcludeOrphan(link: LinkedSession, project: ProjectConfig): readonly SourceName[] {
  const namesPullRequest = link.provider === "github" && !(link.kind === "issue" && isGithubProject(project));
  return namesPullRequest ? ["github"] : ["github", issueSourceStatusKey(project)];
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
 * row may carry the issue key (`linear:<KEY>` or `github-issue:<owner/name>#<n>`); they still report that key as `issueKey`. A session attaches to exactly one row. A
 * session without a row is reported as orphaned only when the sources that
 * could have matched it are `ok` and its issue is not in a paused state.
 */
export function joinItems(input: JoinInput): JoinResult {
  const { project, issues, pullRequests, mergedPullRequests, sessions, notifications, sources } = input;
  const issueSource = issueSourceStatusKey(project);
  const linked = linkedSessionsOf(project, sessions);
  const issuesById = new Map<string, Issue>();
  for (const issue of issues) {
    if (!issuesById.has(issue.id)) issuesById.set(issue.id, issue);
  }

  const candidates: Candidate[] = pullRequests.map((pr) => ({
    pr,
    resolution: pr.relation === "authored" ? resolveIssueKey(pr, project, issues, linked) : null,
  }));
  const winners = claimWinners(candidates);

  const mergedByKey = claimMerged(mergedPullRequests, project, issues, linked);

  const drafts: RowDraft[] = [];
  const claimedKeys = new Set<string>();

  for (const { pr, resolution } of candidates) {
    if (resolution === null) {
      drafts.push({
        key: `github:${pr.id}`,
        issue: null,
        issueKey: null,
        resolvedKey: null,
        resolvedIssue: null,
        pullRequest: pr,
        mergedPullRequest: null,
        joinedBy: null,
        // Review requests of others are never joined; for authored pull requests
        // without issue source data the absence of an issue cannot be concluded.
        noIssue: pr.relation === "authored" && sources[issueSource] === "ok",
      });
      continue;
    }
    if (winners.get(resolution.key) !== pr) {
      drafts.push({
        key: `github:${pr.id}`,
        issue: null,
        issueKey: null,
        resolvedKey: resolution.key,
        resolvedIssue: issuesById.get(resolution.key) ?? null,
        pullRequest: pr,
        mergedPullRequest: null,
        joinedBy: null,
        noIssue: false,
      });
      continue;
    }
    claimedKeys.add(resolution.key);
    drafts.push({
      key: issueRowKey(project, resolution.key),
      issue: issuesById.get(resolution.key) ?? null,
      issueKey: resolution.key,
      resolvedKey: resolution.key,
      resolvedIssue: issuesById.get(resolution.key) ?? null,
      pullRequest: pr,
      mergedPullRequest: null,
      joinedBy: resolution.joinedBy,
      noIssue: false,
    });
  }

  // Issues in a configured paused state are not on anyone's turn; without a pull request they get no row.
  const pausedIds = new Set(issues.filter((issue) => issue.paused).map((issue) => issue.id));
  for (const issue of issues) {
    if (claimedKeys.has(issue.id) || pausedIds.has(issue.id)) continue;
    claimedKeys.add(issue.id);
    drafts.push({
      key: issueRowKey(project, issue.id),
      issue,
      issueKey: issue.id,
      resolvedKey: issue.id,
      resolvedIssue: issue,
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
      sourcesToConcludeOrphan(l, project).every((name) => !isSourceFailure(sources[name]))
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
      resolvedIssue: draft.resolvedIssue,
      issueLookup: null,
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
