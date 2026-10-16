import type { ControlSession } from "../../control/index.ts";

export type ConfirmAction = "stop" | "remove";

/** The confirmation line for a stop or a remove; a remove names the worktree it may delete. */
export function confirmText(kind: ConfirmAction | null, session: ControlSession | null): string {
  const name = session === null ? "session" : session.name ?? session.id;
  return kind === "remove" ? `Confirm remove of ${name}? y/N. Removal may delete its worktree.` : `Confirm ${kind ?? "action"} of ${name}? y/N`;
}
