// Row building and rendering for `pohunek-work list`: the list --json contract
// (RFC 9.1) and the terminal table.
import { evaluateOnTurn, summarizeChecks } from "../rules.ts";
import type { IdentityConfig, ProjectConfig } from "../types/config.ts";
import {
  LIST_CONTRACT_VERSION,
  type ListEnvelope,
  type ListError,
  type ListItem,
  type ListPayload,
  type ListProjectStatus,
  type ListPullRequest,
  type OrphanedSession,
  type SourceStatuses,
  type WorkItem,
} from "../types/item.ts";

export interface RowContext {
  readonly sources: SourceStatuses;
  readonly identity: IdentityConfig;
  readonly project: Pick<ProjectConfig, "ignoredChecks" | "aiReviewers">;
}

/**
 * Builds one contract row. `actions` is empty: named actions and their
 * delegation policy are not part of the read-only overview.
 */
export function buildListItem(item: WorkItem, context: RowContext): ListItem {
  const { onTurn, progress } = evaluateOnTurn({ item, ...context });
  const pr = item.pullRequest;
  const pullRequest: ListPullRequest | null =
    pr === null
      ? null
      : {
          id: pr.id,
          url: pr.url,
          title: pr.title,
          draft: pr.isDraft,
          review_decision: pr.reviewDecision,
          checks: summarizeChecks(pr.checks, context.project.ignoredChecks),
          mergeable: pr.mergeable,
          fix_delivered: progress?.fixDelivered ?? null,
          threads_answered: progress?.threadsAnswered ?? null,
          rerequested: progress?.rerequested ?? null,
        };
  const issue = item.issue;
  return {
    key: item.key,
    project: item.project,
    issue:
      issue === null
        ? null
        : { id: issue.id, title: issue.title, state: issue.stateName, url: issue.url },
    pull_request: pullRequest,
    no_issue: item.noIssue,
    sessions: item.sessions.map((session) => ({
      id: session.id,
      name: session.name,
      role: session.metadata["work.role"] ?? null,
      state: session.state,
      activity: session.activity,
    })),
    on_turn: { actor: onTurn.actor, reason: onTurn.reason, rule: onTurn.rule },
    actions: [],
    sources: context.sources,
  };
}

/** Keeps only rows on the owner's turn. */
export function filterMine(items: readonly ListItem[]): ListItem[] {
  return items.filter((item) => item.on_turn.actor === "me");
}

export function buildListEnvelope(
  cliVersion: string,
  items: readonly ListItem[],
  orphanedSessions: readonly OrphanedSession[],
  projects: readonly ListProjectStatus[],
): ListEnvelope {
  const ok: ListPayload = { items, orphaned_sessions: orphanedSessions, projects };
  return {
    cli_version: cliVersion,
    protocol: { minimum: LIST_CONTRACT_VERSION, maximum: LIST_CONTRACT_VERSION },
    ok,
  };
}

export function buildErrorEnvelope(cliVersion: string, err: ListError): ListEnvelope {
  return {
    cli_version: cliVersion,
    protocol: { minimum: LIST_CONTRACT_VERSION, maximum: LIST_CONTRACT_VERSION },
    err,
  };
}

/** Provider text is untrusted: control characters (terminal escapes) become spaces. */
export function sanitizeCell(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

const HEADER = ["KEY", "ON TURN", "PR", "REVIEW", "CHECKS", "SESSIONS", "TITLE"] as const;

function onTurnCell(item: ListItem): string {
  const { actor, reason, rule } = item.on_turn;
  const ruleText = rule === null ? "" : ` (r${rule.toString()})`;
  return actor === "me" || actor === "unknown" ? `${actor}: ${reason}${ruleText}` : `${actor}${ruleText}`;
}

function sessionsCell(item: ListItem, liveIds: ReadonlySet<string>): string {
  if (item.sessions.length === 0) return "-";
  return item.sessions
    .map((s) => `${s.role ?? "?"}:${liveIds.has(s.id) ? (s.activity ?? "live") : s.state}`)
    .join(",");
}

/** Plain-text table, one row per item; `liveSessionIds` marks sessions that are live right now. */
export function renderTable(
  items: readonly ListItem[],
  orphanedSessions: readonly OrphanedSession[],
  liveSessionIds: ReadonlySet<string>,
): string {
  const rows = items.map((item) => {
    const pr = item.pull_request;
    return [
      item.key + (item.no_issue ? " (no issue)" : ""),
      onTurnCell(item),
      pr === null ? "-" : pr.id + (pr.draft ? " draft" : ""),
      pr?.review_decision ?? "-",
      pr?.checks ?? "-",
      sessionsCell(item, liveSessionIds),
      item.issue?.title ?? pr?.title ?? "",
    ].map(sanitizeCell);
  });
  const table: string[][] = [[...HEADER], ...rows];
  const widths = HEADER.map((_, col) => Math.max(...table.map((row) => (row[col] ?? "").length)));
  const lines = table.map((row) =>
    row
      .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
  for (const orphan of orphanedSessions) {
    lines.push(sanitizeCell(`orphaned session ${orphan.id} (${orphan.name ?? "unnamed"}) links ${orphan.linkId}`));
  }
  return lines.join("\n");
}

