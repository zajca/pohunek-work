// The one path every inline attach takes. The attach child is ended when its session is over, and the way it ended
// decides whether the attach succeeded, so no caller can wait on a child whose session has gone.
import type { ControlClient, ControlSnapshot } from "../control/index.ts";
import type { ChildEnd, InteractiveOutcome } from "../util/exec.ts";

/** Session states in which the session will not run again; an attach to it has nothing left to show. */
const ENDED_STATES: readonly string[] = ["stopped", "done", "failed"];

/**
 * Whether the session is over in `snapshot`. A session listed in an ended state is over. A session that is not listed
 * is over only when the snapshot read every host's sessions: a failed discovery or a failed sessions read removes
 * entries without saying that their sessions ended.
 */
export function sessionOver(snapshot: ControlSnapshot, host: string, id: string): boolean {
  const session = snapshot.sessions.find((item) => item.host === host && item.id === id);
  if (session !== undefined) return ENDED_STATES.includes(session.state);
  return snapshot.errors.every((error) => error.scope !== "discovery" && !(error.host === host && error.scope === "sessions"));
}

/** Calls `onEnded` once the session is over, from the control subscription; returns the stop of the watch. */
export function sessionEnd(control: Pick<ControlClient, "subscribe">, host: string, id: string, graceMs: number): ChildEnd {
  return {
    watch: (onEnded) => control.subscribe((next) => { if (sessionOver(next, host, id)) onEnded(); }),
    graceMs,
  };
}

/**
 * Runs one inline attach. `run` starts the attach child with the end watch it must use. Resolves when the attach
 * completed (the child exited with 0, or the session ended and the child was stopped with it) and rejects with the
 * reason otherwise: a failed exit, or a signal sent by something other than the session end.
 */
export async function handover(
  run: (end: ChildEnd) => Promise<InteractiveOutcome>,
  control: Pick<ControlClient, "subscribe">,
  host: string,
  id: string,
  graceMs: number,
): Promise<void> {
  const outcome = await run(sessionEnd(control, host, id, graceMs));
  if (outcome.kind === "exited" && outcome.code !== 0) throw new Error(`attach exited ${String(outcome.code)}`);
  if (outcome.kind === "signaled") throw new Error(`attach was stopped by ${outcome.signal} while its session may still run`);
}
