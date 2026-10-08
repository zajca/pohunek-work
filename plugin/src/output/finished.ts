// Shared by `list --mine --finished-hours`.
import type { ListItem } from "../types/item.ts";

const MS_PER_HOUR = 3_600_000;

/** Instant after which a session counts as recently finished, `hours` before `nowMs`. */
export function finishedCutoff(nowMs: number, hours: number): number {
  return nowMs - hours * MS_PER_HOUR;
}

/**
 * A row whose agent work ended recently: nothing runs or waits for input, and at least
 * one linked session is stopped or done with an `updated_at` at or after `cutoffMs`. An
 * unparsable or absent timestamp never qualifies a session.
 */
export function isRecentlyFinished(item: ListItem, cutoffMs: number): boolean {
  if (item.sessions.some((s) => s.indicator === "running" || s.indicator === "waiting_input")) return false;
  return item.sessions.some((s) => {
    if (s.state !== "stopped" && s.state !== "done") return false;
    const updated = s.updated_at === null ? Number.NaN : Date.parse(s.updated_at);
    return updated >= cutoffMs;
  });
}
