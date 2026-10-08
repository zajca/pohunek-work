// The label shown for a session in the list table and the TUI.
import type { ListSession } from "../types/item.ts";

/** A live session shows its activity (`live` while unknown); every other indicator is shown as is. */
export function sessionLabel(session: ListSession): string {
  return session.indicator === "running" ? (session.activity ?? "live") : session.indicator;
}
