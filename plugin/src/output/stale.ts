// Shared by `list --stale-days` and the TUI stale filter.
import type { ListItem } from "../types/item.ts";

const MS_PER_DAY = 86_400_000;

/** Instant before which a pull request counts as stale, `days` before `nowMs`. */
export function staleCutoff(nowMs: number, days: number): number {
  return nowMs - days * MS_PER_DAY;
}

/**
 * A pull request not updated since `cutoffMs` that nothing runs for (no linked
 * session is running). An unparsable timestamp never hides a row.
 */
export function isStalePullRequest(item: ListItem, cutoffMs: number): boolean {
  const pr = item.pull_request;
  if (pr === null || item.sessions.some((session) => session.state === "running")) return false;
  return Date.parse(pr.updated_at) < cutoffMs;
}
