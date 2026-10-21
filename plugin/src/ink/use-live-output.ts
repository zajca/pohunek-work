import { useCallback, useEffect, useState } from "react";
import type { ControlClient, ControlRuntime, ControlScreen } from "../control/index.ts";
import type { InkTuiOptions } from "./app.tsx";
import { LiveOutput } from "./live-output.ts";
import { defaultStatus } from "./use-status.ts";

export interface LiveOutputState {
  readonly screen: ControlScreen | null;
  readonly setScreen: (screen: ControlScreen | null) => void;
  readonly restartOutput: () => void;
}

/** The output of the session shown beside the list or in the overlay, read live; `liveHost` and `liveId` are null when none is shown. */
export function useLiveOutput(
  control: ControlClient,
  options: Pick<InkTuiOptions, "outputMaxBytes" | "outputWaitMs">,
  liveHost: string | null,
  liveId: string | null,
): LiveOutputState {
  const [screen, setScreen] = useState<ControlScreen | null>(null);
  const [liveRound, setLiveRound] = useState(0);
  useEffect(() => {
    setScreen(null);
    if (liveHost === null || liveId === null) return;
    let active = true;
    // A function call, so the check after each await is not narrowed to the value the flag had before the await.
    const isActive = (): boolean => active;
    const live = new LiveOutput(options.outputMaxBytes);
    let wake: (() => void) | null = null;
    // Resolves with the next snapshot, or when the effect is cleaned up first.
    const nextSnapshot = (): Promise<void> => new Promise((resolve) => {
      const unsubscribe = control.subscribe(() => { unsubscribe(); wake = null; resolve(); });
      wake = () => { unsubscribe(); wake = null; resolve(); };
    });
    const read = async (): Promise<void> => {
      // The cursor is only valid with the runtime it was read from, so both move together.
      let cursor: { readonly after: string; readonly runtime: ControlRuntime } | null = null;
      // A read that failed leaves the panel showing the failure until a read succeeds, even one with no new output.
      let failed = false;
      for (;;) {
        const result = await control.output(liveHost, liveId, { after: cursor?.after ?? null, runtime: cursor?.runtime ?? null, maxBytes: options.outputMaxBytes, waitMs: options.outputWaitMs });
        if (!isActive()) return;
        // The output block says why nothing is shown; the status line stays free for actions.
        if (!result.ok) {
          failed = true;
          setScreen({ sessionId: liveId, title: null, progress: null, visibleLines: [`output unavailable: ${result.error.message}`] });
          // The read is tried again when the control client publishes a snapshot, which follows a reconnect.
          await nextSnapshot();
          if (!isActive()) return;
          continue;
        }
        // A new worker instance or generation starts a new output history, so the output before it is a gap.
        if (cursor !== null && (cursor.runtime.workerInstanceId !== result.data.runtime.workerInstanceId || cursor.runtime.runtimeGeneration !== result.data.runtime.runtimeGeneration)) live.markGap();
        cursor = { after: result.data.nextOffset, runtime: result.data.runtime };
        if (result.data.gap) live.markGap();
        if (result.data.bytes.length === 0 && !result.data.gap && !failed) continue;
        failed = false;
        live.append(result.data.bytes);
        setScreen({ sessionId: liveId, title: null, progress: null, visibleLines: live.lines() });
      }
    };
    read().catch((error: unknown) => { if (active) setScreen({ sessionId: liveId, title: null, progress: null, visibleLines: [`output unavailable: ${defaultStatus(error)}`] }); });
    return () => { active = false; wake?.(); };
  }, [control, liveHost, liveId, liveRound, options.outputMaxBytes, options.outputWaitMs]);
  const restartOutput = useCallback((): void => { setLiveRound((round) => round + 1); }, []);
  return { screen, setScreen, restartOutput };
}
