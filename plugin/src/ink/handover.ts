// The one path every inline attach takes. The attach child is ended only when the session is confirmed over by a
// targeted read of that session on its host. A snapshot that lacks the session, or lists it ended, only asks for that
// read: a stale snapshot, a failed discovery or an unreachable host is not evidence that the session ended.
import type { ControlClient, ControlError, ControlSnapshot } from "../control/index.ts";
import type { ChildEnd, InteractiveOutcome } from "../util/exec.ts";

/** Session states in which the session will not run again; an attach to it has nothing left to show. */
const ENDED_STATES: readonly string[] = ["stopped", "done", "failed"];
/** The CLI code of a read of a session the daemon does not have. */
const NOT_FOUND_CODE = "session_not_found";

type SessionControl = Pick<ControlClient, "subscribe" | "inspectSession">;

/** Whether a snapshot is a reason to read the session again: it is missing or listed in an ended state. */
export function mayBeOver(snapshot: ControlSnapshot, host: string, id: string): boolean {
  const session = snapshot.sessions.find((item) => item.host === host && item.id === id);
  return session === undefined || ENDED_STATES.includes(session.state);
}

/** The daemon answered that the session does not exist; any other failure says nothing about the session. */
function notFound(error: ControlError): boolean {
  return error.cliCode === NOT_FOUND_CODE;
}

/**
 * Calls `onEnded` once a targeted read confirms the session is over: it is in an ended state, or the daemon on its
 * host reports it not found. Reads run one at a time; a trigger that arrives during a read is read again afterwards.
 */
export function sessionEnd(control: SessionControl, host: string, id: string, graceMs: number): ChildEnd {
  return {
    watch: (onEnded) => {
      const state = { stopped: false, reading: false, again: false };
      const requested = (): boolean => state.again;
      const confirm = async (): Promise<void> => {
        if (state.reading) { state.again = true; return; }
        state.reading = true;
        try {
          for (;;) {
            state.again = false;
            const result = await control.inspectSession(host, id);
            if (state.stopped) return;
            if (result.ok ? ENDED_STATES.includes(result.data.state) : notFound(result.error)) {
              state.stopped = true;
              onEnded();
              return;
            }
            // A call of this function, so the check is not narrowed to the value assigned above.
            if (!requested()) return;
          }
        } finally {
          state.reading = false;
        }
      };
      const unsubscribe = control.subscribe((snapshot) => { if (!state.stopped && mayBeOver(snapshot, host, id)) void confirm(); });
      return () => { state.stopped = true; unsubscribe(); };
    },
    graceMs,
  };
}

/**
 * Runs one inline attach. `run` starts the attach child with the end watch it must use. Resolves when the attach
 * completed (the child exited with 0, or the session was confirmed over and the child stopped with it) and rejects
 * with the reason otherwise: a failed exit, or a signal sent by something other than the session end.
 */
export async function handover(
  run: (end: ChildEnd) => Promise<InteractiveOutcome>,
  control: SessionControl,
  host: string,
  id: string,
  graceMs: number,
): Promise<void> {
  const outcome = await run(sessionEnd(control, host, id, graceMs));
  if (outcome.kind === "exited" && outcome.code !== 0) throw new Error(`attach exited ${String(outcome.code)}`);
  if (outcome.kind === "signaled") throw new Error(`attach was stopped by ${outcome.signal} while its session may still run`);
}
