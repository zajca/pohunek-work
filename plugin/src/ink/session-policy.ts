import type { ControlSession } from "../control/index.ts";

/** Runtime states in which the daemon refuses every change to the session. */
const READ_ONLY_RUNTIMES: readonly string[] = ["conflicting", "incompatible"];
/** Session states in which the session runs or can take input. */
const ACTIVE_STATES: readonly string[] = ["running", "working", "starting", "reconnecting", "blocked"];

/** Whether the TUI may change the session: it is not external and its runtime is not read-only. */
export function isWritable(session: ControlSession): boolean {
  return !session.external && !READ_ONLY_RUNTIMES.includes(session.runtimeState ?? "");
}

/** A writable session whose runtime is not lost: stop, remove, rename and metadata act on it. */
export function isMutable(session: ControlSession): boolean {
  return isWritable(session) && session.runtimeState !== "lost";
}

export function isActive(session: ControlSession): boolean {
  return ACTIVE_STATES.includes(session.state);
}

/** Whether the TUI refuses to attach to the session: it is read-only, or its runtime is lost. */
export function isAttachBlocked(session: ControlSession): boolean {
  return !isWritable(session) || session.runtimeState === "lost";
}
