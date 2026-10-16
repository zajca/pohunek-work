import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ControlClient, ControlSnapshot } from "../control/index.ts";
import { coalesce } from "./coalesce.ts";
import type { InkTuiOptions } from "./app.tsx";
import { defaultStatus, type MutableRef, type StatusState } from "./use-status.ts";
import { loadWork, type WorkSnapshot } from "./work.ts";

const SOURCE_WARNING = /source\(s\) unavailable; mutating actions are paused$/;

function retainUnavailable(previous: ControlSnapshot | null, current: ControlSnapshot): ControlSnapshot {
  if (previous === null || current.errors.length === 0) return current;
  const failed = (host: string, scope: string): boolean => current.errors.some((error) =>
    error.scope === "discovery" || (error.host === host && error.scope === scope));
  const presentSession = new Set(current.sessions.map((session) => `${session.host}/${session.id}`));
  const presentProject = new Set(current.projects.map((project) => `${project.host}/${project.id}`));
  const presentNotification = new Set(current.notifications.map((notification) => `${notification.host}/${notification.id}`));
  return {
    ...current,
    sessions: [...current.sessions, ...previous.sessions.filter((session) => failed(session.host, "sessions") && !presentSession.has(`${session.host}/${session.id}`))],
    projects: [...current.projects, ...previous.projects.filter((project) => failed(project.host, "projects") && !presentProject.has(`${project.host}/${project.id}`))],
    notifications: [...current.notifications, ...previous.notifications.filter((notification) => failed(notification.host, "notifications") && !presentNotification.has(`${notification.host}/${notification.id}`))],
  };
}

export type ControlDataOptions = Pick<InkTuiOptions, "mode" | "selfBin" | "listTimeoutMs" | "sessionReconcileMs" | "refreshIntervalMs" | "onSnapshot" | "log">;

export interface ControlDataState {
  /** Cleared on unmount; a read that completes after it must not update the state. */
  readonly alive: MutableRef<boolean>;
  readonly snapshot: ControlSnapshot | null;
  readonly setSnapshot: (update: (previous: ControlSnapshot | null) => ControlSnapshot | null) => void;
  readonly work: WorkSnapshot | null;
  readonly stale: boolean;
  readonly refresh: () => Promise<void>;
}

/**
 * The control snapshot and the work list, refreshed on their own intervals. `afterControlRead` runs after each control
 * read that succeeds; the owner points it at whatever must follow a read.
 */
export function useControlData(
  control: ControlClient,
  options: ControlDataOptions,
  status: Pick<StatusState, "setStatus" | "actionSeq" | "mutationEpoch" | "mutationNotice">,
  afterControlRead: MutableRef<() => void>,
): ControlDataState {
  const { setStatus, actionSeq, mutationEpoch, mutationNotice } = status;
  const alive = useRef(true);
  const [snapshot, setSnapshot] = useState<ControlSnapshot | null>(null);
  const [work, setWork] = useState<WorkSnapshot | null>(null);
  const [stale, setStale] = useState(false);

  // Snapshots from the reconcile and from the daemon's event stream share one path.
  // A read that started before a newer action may not replace that action's status; the snapshot itself is always applied.
  // A background publish (an event or a per-host read) reports a new outage only over an empty status or an earlier
  // outage warning, so an action outcome is never overwritten by it.
  const applySnapshot = useCallback((next: ControlSnapshot, mayReport = true, background = false): void => {
    setSnapshot((previous) => retainUnavailable(previous, next));
    try { options.onSnapshot?.(next); }
    catch (error) { options.log?.("snapshot_callback_failed", defaultStatus(error)); }
    setStale(false);
    if (next.errors.length === 0 || mutationNotice.current !== null) return;
    const warning = `${next.errors.length} source(s) unavailable; mutating actions are paused`;
    if (mayReport) setStatus(warning);
    else if (background) setStatus((old) => old === null || SOURCE_WARNING.test(old) ? warning : old);
  }, [options.log, options.onSnapshot]);

  useEffect(() => control.subscribe((next) => { if (alive.current) applySnapshot(next, false, true); }), [applySnapshot, control]);
  useEffect(() => () => { void control.close(); }, [control]);

  // Sessions and the work list refresh on their own intervals; a manual refresh runs both.
  // A request during an in-flight read is answered by one follow-up read (see coalesce.ts).
  const refreshControl = useMemo(() => coalesce(async (): Promise<void> => {
    const started = actionSeq.current;
    const epoch = mutationEpoch.current;
    const nextControl = await control.refresh().then((value) => ({ ok: true as const, value }), (reason: unknown) => ({ ok: false as const, reason }));
    if (!alive.current) return;
    if (nextControl.ok) {
      // A read that started before a mutation completed is superseded by the follow-up read that the mutation queued.
      if (mutationEpoch.current === epoch) applySnapshot(nextControl.value, actionSeq.current === started);
      afterControlRead.current();
    } else {
      setStale(true);
      if (actionSeq.current === started) setStatus(`Control refresh failed: ${defaultStatus(nextControl.reason)}`);
    }
  }), [applySnapshot, control, afterControlRead]);

  const refreshWork = useMemo(() => coalesce(async (): Promise<void> => {
    if (options.mode !== "main") return;
    const started = actionSeq.current;
    const nextWork = await loadWork(options.selfBin, options.listTimeoutMs).then((value) => ({ ok: true as const, value }), (reason: unknown) => ({ ok: false as const, reason }));
    if (!alive.current) return;
    if (nextWork.ok) {
      const latest = nextWork.value;
      setWork((previous) => latest.payload === null && previous?.payload !== null && previous !== null ?
        { ...previous, partial: true, warning: latest.warning ?? "Work refresh unavailable; showing last good rows" } : latest);
    } else {
      const warning = `Work refresh failed: ${defaultStatus(nextWork.reason)}`;
      setWork((previous) => previous === null ? null : { ...previous, partial: true, warning });
      if (actionSeq.current === started) setStatus(warning);
    }
  }), [options.listTimeoutMs, options.mode, options.selfBin]);

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([refreshControl(), refreshWork()]);
  }, [refreshControl, refreshWork]);

  useEffect(() => {
    alive.current = true;
    void refreshControl();
    void refreshWork();
    const controlTimer = setInterval(() => { void refreshControl(); }, options.sessionReconcileMs);
    const workTimer = setInterval(() => { void refreshWork(); }, options.refreshIntervalMs);
    return () => { alive.current = false; clearInterval(controlTimer); clearInterval(workTimer); };
  }, [options.refreshIntervalMs, options.sessionReconcileMs, refreshControl, refreshWork]);

  return { alive, snapshot, setSnapshot, work, stale, refresh };
}
