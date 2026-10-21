import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

/** Status line text for input refused while an action is still running. */
export const BUSY_REFUSAL = "Still working on the last action; input was not applied, try again when it finishes";

export function defaultStatus(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A ref whose `current` the owner writes; React types its `useRef` results this way too. */
export interface MutableRef<T> { current: T }

/** The status line, the busy flag, and the counters that let a late read tell it is stale against an action. */
export interface StatusState {
  readonly status: string | null;
  readonly setStatus: Dispatch<SetStateAction<string | null>>;
  readonly busy: boolean;
  readonly setBusy: Dispatch<SetStateAction<boolean>>;
  readonly mutationNotice: MutableRef<string | null>;
  readonly mutationEpoch: MutableRef<number>;
  readonly actionSeq: MutableRef<number>;
  readonly bumpStatus: (message: string | null) => void;
}

export function useStatus(): StatusState {
  const [status, setStatus] = useState<string | null>(null);
  // The message of the last mutation that failed. Snapshots that arrive afterwards keep it on the status line.
  const mutationNotice = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped when a mutation completes; a read that started before it must not replace the state the mutation showed.
  const mutationEpoch = useRef(0);
  // Counts the actions that started; a read that completes later checks it before it reports its own result.
  const actionSeq = useRef(0);
  // A status written by a user action; it counts as newer than any refresh read that started before it.
  const bumpStatus = useCallback((message: string | null): void => { actionSeq.current += 1; setStatus(message); }, []);
  // The refusal on the status line is for the action that was running, so it goes once that action ends.
  useEffect(() => { if (!busy) setStatus((old) => old === BUSY_REFUSAL ? null : old); }, [busy]);
  return { status, setStatus, busy, setBusy, mutationNotice, mutationEpoch, actionSeq, bumpStatus };
}
