// Joins normalized source data into table rows (RFC section 7).
import type {
  JoinMatch,
  OrphanedSession,
  SourceStatuses,
  WorkItem,
} from "./types/item.ts";
import type { ProjectConfig } from "./types/config.ts";
import type {
  LinearIssue,
  PohunekNotification,
  PohunekSession,
  PullRequest,
} from "./types/sources.ts";

export interface JoinInput {
  readonly project: ProjectConfig;
  readonly issues: readonly LinearIssue[];
  readonly pullRequests: readonly PullRequest[];
  readonly sessions: readonly PohunekSession[];
  readonly notifications: readonly PohunekNotification[];
  readonly sources: SourceStatuses;
}

export interface JoinResult {
  readonly items: WorkItem[];
  readonly orphanedSessions: OrphanedSession[];
}

const META_PROVIDER = "work.link.provider";
const META_LINK_ID = "work.link.id";
const META_LINK_BRANCH = "work.link.branch";

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

/** Sessions of the project that carry a link id; the rest never take part in the join. */
function linkedSessionsOf(
  project: ProjectConfig,
  sessions: readonly PohunekSession[],
): LinkedSession[] {
  const linked: LinkedSession[] = [];
  for (const session of sessions) {
    if (session.projectLabel !== project.pohunekLabel) continue;
    const linkId = session.metadata[META_LINK_ID];
    if (linkId === undefined || linkId === "") continue;
    const branch = session.metadata[META_LINK_BRANCH];
    linked.push({
      session,
      provider: session.metadata[META_PROVIDER] ?? null,
      linkId,
      branch: branch === undefined || branch === "" ? null : branch,
    });
  }
  return linked;
}

/** Group `key` of the branch pattern; the regex is reset so a global or sticky flag cannot skip matches. */
function keyFromBranch(pattern: RegExp, headRefName: string): string | null {
  pattern.lastIndex = 0;
  const match = pattern.exec(headRefName);
  pattern.lastIndex = 0;
  const key = match?.groups?.["key"];
  return key === undefined || key === "" ? null : key;
}

/** First match of RFC 7.3 precedence: session link, Linear attachment, branch pattern. */
function resolveIssueKey(
  pr: PullRequest,
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
  readonly issueKey: string | null;
  readonly pullRequest: PullRequest | null;
  readonly joinedBy: JoinMatch | null;
  readonly noIssue: boolean;
}

/**
 * Builds the table rows and the orphaned sessions.
 *
 * Row order: pull requests in input order, then issue-only rows in issue order.
 * Only `authored` pull requests are joined to issues. When two pull requests
 * resolve to the same issue key, the first joins the issue row and the second
 * becomes its own `github:` row with `noIssue` false, because the issue exists
 * (or is known by key) and only one row may carry a `linear:<KEY>` key.
 */
export function joinItems(input: JoinInput): JoinResult {
  const { project, issues, pullRequests, sessions, notifications, sources } = input;
  const linked = linkedSessionsOf(project, sessions);
  const issuesById = new Map<string, LinearIssue>();
  for (const issue of issues) {
    if (!issuesById.has(issue.id)) issuesById.set(issue.id, issue);
  }

  const drafts: RowDraft[] = [];
  const claimedKeys = new Set<string>();

  for (const pr of pullRequests) {
    if (pr.relation !== "authored") {
      drafts.push({
        key: `github:${pr.id}`,
        issue: null,
        issueKey: null,
        pullRequest: pr,
        joinedBy: null,
        noIssue: false,
      });
      continue;
    }

    const resolution = resolveIssueKey(pr, project, issues, linked);
    if (resolution === null) {
      drafts.push({
        key: `github:${pr.id}`,
        issue: null,
        issueKey: null,
        pullRequest: pr,
        joinedBy: null,
        // Without Linear data the absence of an issue cannot be concluded.
        noIssue: sources.linear === "ok",
      });
      continue;
    }

    if (claimedKeys.has(resolution.key)) {
      drafts.push({
        key: `github:${pr.id}`,
        issue: null,
        issueKey: null,
        pullRequest: pr,
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
      pullRequest: pr,
      joinedBy: resolution.joinedBy,
      noIssue: false,
    });
  }

  for (const issue of issues) {
    if (claimedKeys.has(issue.id)) continue;
    claimedKeys.add(issue.id);
    drafts.push({
      key: `linear:${issue.id}`,
      issue,
      issueKey: issue.id,
      pullRequest: null,
      joinedBy: null,
      noIssue: false,
    });
  }

  const attachedSessionIds = new Set<string>();
  const items: WorkItem[] = drafts.map((draft) => {
    const rowSessions = linked
      .filter((l) => {
        const pr = draft.pullRequest;
        return (
          (draft.issueKey !== null && l.linkId === draft.issueKey) ||
          (pr !== null && l.linkId === pr.id) ||
          (pr !== null && l.branch !== null && l.branch === pr.headRefName)
        );
      })
      .map((l) => l.session);
    for (const session of rowSessions) attachedSessionIds.add(session.id);
    const sessionIds = new Set(rowSessions.map((s) => s.id));
    return {
      key: draft.key,
      project: project.pohunekLabel,
      issue: draft.issue,
      pullRequest: draft.pullRequest,
      joinedBy: draft.joinedBy,
      noIssue: draft.noIssue,
      sessions: rowSessions,
      notifications: notifications.filter(
        (n) => n.sessionId !== null && sessionIds.has(n.sessionId),
      ),
    };
  });

  const orphanedSessions: OrphanedSession[] = linked
    .filter((l) => !attachedSessionIds.has(l.session.id))
    .map((l) => ({ id: l.session.id, name: l.session.name, linkId: l.linkId }));

  return { items, orphanedSessions };
}
