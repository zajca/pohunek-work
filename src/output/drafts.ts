// Shared by `list --no-drafts` and the TUI draft filter.
import type { ListItem } from "../types/item.ts";

/** A draft pull request nothing runs for: no linked session is running. */
export function isIdleDraft(item: ListItem): boolean {
  return item.pull_request?.draft === true && !item.sessions.some((session) => session.state === "running");
}
