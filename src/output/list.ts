// Row building and rendering for `pohunek-work list`: the list --json contract
// (RFC 9.1) and the terminal table.
import { configuredProfile } from "../config/profiles.ts";
import { evaluateOnTurn, summarizeChecks } from "../rules.ts";
import { isLiveSession } from "../sources/pohunek.ts";
import { toAscii } from "./sanitize.ts";
import type { IdentityConfig, ProfilesConfig, ProjectConfig } from "../types/config.ts";
import {
  LIST_CONTRACT_VERSION,
  type ListAction,
  type ListEnvelope,
  type ListError,
  type ListItem,
  type ListPayload,
  type ListProjectStatus,
  type ListPullRequest,
  type OnTurn,
  type OrphanedSession,
  type SourceStatuses,
  type UnlinkedSession,
  type WorkItem,
} from "../types/item.ts";

export interface RowContext {
  readonly sources: SourceStatuses;
  readonly identity: IdentityConfig;
  readonly project: Pick<ProjectConfig, "ignoredChecks" | "aiReviewers" | "profiles">;
  /** Global [profiles]; a project's own table replaces it whole. */
  readonly profiles: ProfilesConfig;
}

/** The `do` action that moves a row on the owner's turn forward; null when the step is manual (7, 9). */
function ruleAction(onTurn: OnTurn): string | null {
  if (onTurn.actor !== "me") return null;
  switch (onTurn.rule) {
    case 3:
      return "review";
    case 4:
      return "babysit";
    case 5:
      return onTurn.reason === "fix CI" ? "fix-ci" : "rebase";
    case 6:
      return "ready";
    case 8:
      return "implement";
    default:
      return null;
  }
}

/** Actions that start a session carry the agent profile `do` would use. */
const PROFILED_ACTIONS: readonly string[] = ["implement", "babysit", "fix-ci", "rebase", "review"];

/**
 * Named actions of a row, the primary first (docs/tui-plan.md 4.5). `attach`
 * is listed whenever a live linked session exists, which covers rules 1 and 11.
 * `merge` is never listed. Delegation policy is empty, so nothing is delegable.
 */
export function rowActions(item: WorkItem, onTurn: OnTurn, context: Pick<RowContext, "project" | "profiles">): ListAction[] {
  const names: string[] = [];
  const primary = ruleAction(onTurn);
  if (primary !== null) names.push(primary);
  if (item.sessions.some(isLiveSession)) names.push("attach");
  return names.map((name) => {
    const profile = PROFILED_ACTIONS.includes(name) ? configuredProfile(name, context.project.profiles, context.profiles) : undefined;
    return profile === undefined ? { name, delegable: false } : { name, delegable: false, profile };
  });
}

/** Builds one contract row. */
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
    actions: rowActions(item, onTurn, context),
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
  unlinkedSessions: readonly UnlinkedSession[],
  projects: readonly ListProjectStatus[],
): ListEnvelope {
  const ok: ListPayload = {
    items,
    orphaned_sessions: orphanedSessions,
    unlinked_sessions: unlinkedSessions,
    projects,
  };
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

/** Plain-text table in strict ASCII (provider text is untrusted), one row per item; `liveSessionIds` marks sessions that are live right now. */
export function renderTable(
  items: readonly ListItem[],
  orphanedSessions: readonly OrphanedSession[],
  unlinkedSessions: readonly UnlinkedSession[],
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
    ].map(toAscii);
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
    lines.push(toAscii(`orphaned session ${orphan.id} (${orphan.name ?? "unnamed"}) links ${orphan.linkId}`));
  }
  for (const session of unlinkedSessions) {
    lines.push(
      toAscii(
        `unlinked session ${session.id} (${session.name ?? "unnamed"}) in ${session.project}: ${session.activity ?? session.state}`,
      ),
    );
  }
  return lines.join("\n");
}

