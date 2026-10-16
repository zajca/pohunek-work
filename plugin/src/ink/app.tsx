import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Box, render, Text, useApp, useInput, usePaste, useStdout, type Key } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createControlClient, type ControlAction, type ControlGovernance, type ControlHost, type ControlHostCapabilities, type ControlNotification, type ControlSession, type ControlSnapshot } from "../control/index.ts";
import { createSessionLauncher, type ActionChoice, type LaunchOptions, type LaunchRequest, type CreatedSession } from "../session-launch/index.ts";
import { checkOpenUrl, githubBranchUrl } from "../tui/actions.ts";
import { noLinkReason, sessionLinks, type SessionLink } from "./links.ts";
import type { TuiAttachMode } from "../types/config.ts";
import { staleCutoff } from "../output/stale.ts";
import { ACTOR_FILTERS, filterRows, projectLabels, rowId, type Filters } from "../tui/rows.ts";
import { exec, execInteractive, execInteractiveCapture, type ChildEnd, type InteractiveOutcome } from "../util/exec.ts";
import { handover, openExternal, suspendForChild as suspendChild } from "./handover.ts";
import { useControlData } from "./use-control-data.ts";
import { useLiveOutput } from "./use-live-output.ts";
import { BUSY_REFUSAL, defaultStatus, useStatus } from "./use-status.ts";
import type { ControlActivityCursor, ControlActivityScope } from "../control/types.ts";
import { compareActivityOrder } from "../control/order.ts";
import { openAttachWindow } from "../tui/attach-window.ts";
import { ATTACH_HOST, ATTACH_VALUE, renderAttachArgv } from "../tui/attach-template.ts";
import { previewWork, workActionArgv } from "./work.ts";
import { ActionButton, Message, ScreenFrame, safeText, shorten } from "./components.tsx";
import { MouseProvider, parseMouseEvent, setMouseTracking, useMouseDispatch } from "./mouse.tsx";
import { FILTER_FOOTER, FORM_FOOTER, LayoutProvider, MAIN_FOOTER, SESSIONS_FOOTER, useLayout } from "./layout.tsx";
import { decodeDoEnvelope, type DoOutcome } from "../tui/decode.ts";
import { ActivityView, activityMatches, applyActivityChange, filterSessions, HostsView, hostTerms, LinkChooser, listWindowStart, orderedSessions, ProjectPicker, projectChoices, RecoveryConfirmation, recordTerms, SessionsView, SessionDetail, WorkPreview, WorkView, sessionDetailMaxOffset, sessionGroup, workPreviewMaxOffset, type ActivityScope, type ViewName } from "./views.tsx";
import { changeTextField, formFieldLabel, formFields, formPick, INTENTS, LAST_PICK_FIELD, moveFocus, nextField, submitIndex, type PickItem } from "./form/fields.ts";
import { fuzzyFilter, pastedText, typedText } from "../tui/search.ts";
import { keyPresses, splitKey } from "./key-presses.ts";
import { isActive, isAttachBlocked, isMutable, isWritable } from "./session-policy.ts";
import { FormView } from "./form/form-view.tsx";
import type { LaunchForm } from "./form/launch-form.ts";
import { HelpOverlay } from "./overlays/help.tsx";
import { HostOverlay } from "./overlays/host.tsx";
import { NotificationOverlay } from "./overlays/notification.tsx";
import { confirmText, type ConfirmAction } from "./overlays/session.tsx";
import { WorkDetailOverlay } from "./overlays/work.tsx";

export interface InkTuiOptions {
  readonly mode: "main" | "new-session";
  readonly selfBin: string;
  readonly pohunekBin: string;
  readonly timeoutMs: number;
  readonly listTimeoutMs: number;
  readonly launchTimeoutMs: number;
  readonly launchKillMarginMs: number;
  readonly notificationsPageSize: number;
  readonly refreshIntervalMs: number;
  readonly sessionReconcileMs: number;
  readonly actionCaptureBytes: number;
  /** Inline attaches in this terminal; window attaches in a terminal started from attachCommand. */
  readonly attachMode: TuiAttachMode;
  /** A new-session that opened its session in a window reports the line the process prints as it exits. */
  readonly onWindowOpened?: (line: string) => void;
  readonly attachCommand?: readonly string[];
  readonly attachLaunchCheckMs?: number;
  readonly outputWaitMs: number;
  readonly outputMaxBytes: number;
  /** Longest gap between two presses on one list row that counts as a double click. */
  readonly doubleClickMs: number;
  readonly reconnectMaxMs: number;
  /** Columns from which the session detail is a panel beside the list. */
  readonly detailMinWidth: number;
  readonly localSocket: string | null;
  readonly initialView: "mine" | "all";
  readonly stalePrDays: number;
  readonly openUrlHosts: readonly string[];
  readonly openCommand: string;
  readonly clipboardCommand?: string;
  readonly onSnapshot?: (snapshot: ControlSnapshot) => void;
  readonly log?: (event: string, detail?: string) => void;
}

/** An event waiting for its render: a key press of Ink's input channel or a paste of its paste channel. */
type PendingEvent = { readonly kind: "key"; readonly press: string; readonly key: Key } | { readonly kind: "paste"; readonly text: string };
/** The owner's own overlay kinds: a return or a pick names one of these. */
type OverlayKind = "none" | "links" | "session" | "host" | "notification" | "form" | "assistant" | "confirm" | "recovery" | "rename" | "metadata" | "work-detail" | "work-preview" | "help" | "projects";
/** Where Esc or a finished action returns to. */
type ReturnKind = "none" | "session";
/** The open overlay; `kind` is what the views switch on. A confirm carries its target, so it cannot open without one. */
/** The session and highlighted link of the link chooser; `url` is null when the session has no link to highlight. */
interface LinkChoice { readonly host: string; readonly id: string; readonly url: string | null; readonly returnTo: ReturnKind }

type Overlay =
  | { readonly kind: Exclude<OverlayKind, "confirm" | "recovery" | "links" | "host" | "notification" | "work-detail" | "work-preview" | "projects"> }
  | { readonly kind: "confirm"; readonly action: ConfirmAction; readonly session: ControlSession; readonly returnTo: ReturnKind }
  | { readonly kind: "recovery"; readonly request: RecoveryRequest }
  | { readonly kind: "links"; readonly chooser: LinkChoice }
  | { readonly kind: "host"; readonly capabilities: ControlHostCapabilities | null; readonly governance: ControlGovernance | null }
  | { readonly kind: "notification"; readonly record: ControlNotification }
  | { readonly kind: "work-detail"; readonly key: string; readonly choice: number }
  | { readonly kind: "work-preview"; readonly key: string; readonly choice: number; readonly preview: DoOutcome | string; readonly offset: number }
  | { readonly kind: "projects"; readonly index: number; readonly search: string; readonly filtering: boolean };

/** The project picker's highlight, query and whether the query is being typed. */
type PickState = { readonly index: number; readonly search: string; readonly filtering: boolean };
/** A resume or fork waiting for the owner to confirm the native conversation it will recover. */
interface RecoveryRequest { readonly kind: "resume" | "fork"; readonly session: ControlSession; readonly returnTo: ReturnKind }

const VIEWS: readonly ViewName[] = ["Work", "Sessions", "Hosts", "Activity"];
const SCOPES: readonly ActivityScope[] = ["Recent", "Unread", "Archived"];
const CONTROL_SCOPE: Readonly<Record<ActivityScope, ControlActivityScope>> = { Recent: "recent", Unread: "unread", Archived: "archived" };



const EMPTY_FORM: LaunchForm = { host: "local", project: null, agent: null, action: null, name: "", prompt: "", branch: "", baseBranch: "", intent: "help", focus: 1, search: "", highlight: 0, choice: 0 };



function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Whether the last refresh could not read this host's sessions; a discovery failure leaves them readable. */
function sessionsUnreadable(snapshot: ControlSnapshot | null, host: string): boolean {
  return snapshot?.errors.some((error) => error.host === host && error.scope === "sessions") ?? false;
}

function sameSession(a: ControlSession, b: ControlSession): boolean {
  return a.host === b.host && a.id === b.id && a.state === b.state && a.runtimeState === b.runtimeState && a.updatedAt === b.updatedAt;
}

/** The native conversation and its last activity, as shown in the recovery confirmation. */
function sameRecoveryTarget(a: ControlSession, b: ControlSession): boolean {
  return JSON.stringify(a.nativeTarget) === JSON.stringify(b.nativeTarget) && a.nativeLastActivityAt === b.nativeLastActivityAt;
}

function selectedAt<T>(items: readonly T[], index: number): T | null {
  return items[Math.max(0, Math.min(index, items.length - 1))] ?? null;
}





function InkApplication({ options, setExitCode }: { readonly options: InkTuiOptions; readonly setExitCode: (code: number) => void }): ReactNode {
  const layout = useLayout();
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const dispatchMouse = useMouseDispatch();
  const control = useMemo(() => createControlClient({ binary: options.pohunekBin, timeoutMs: options.timeoutMs, notificationsPageSize: options.notificationsPageSize, localSocket: options.localSocket, reconnectMaxMs: options.reconnectMaxMs }), [options.pohunekBin, options.timeoutMs, options.notificationsPageSize, options.reconnectMaxMs]);
  const newLauncher = useCallback(() => createSessionLauncher({ bin: options.pohunekBin, queryTimeoutMs: options.timeoutMs, launchTimeoutMs: options.launchTimeoutMs, launchKillMarginMs: options.launchKillMarginMs }), [options.pohunekBin, options.timeoutMs, options.launchTimeoutMs, options.launchKillMarginMs]);
  const [launcher, setLauncher] = useState(newLauncher);
  const [view, setView] = useState<ViewName>("Work");
  /** The last press on a list row, which a press on the same row within `doubleClickMs` turns into a double click. */
  const rowClick = useRef<{ readonly id: string; readonly at: number } | null>(null);
  const [overlay, setOverlay] = useState<Overlay>({ kind: options.mode === "new-session" ? "form" : "none" });
  const [workFilters, setWorkFilters] = useState<Filters>({ actor: options.initialView === "mine" ? "me" : "all", project: null, text: "", hideStale: false });
  // The view whose `/` filter takes the text keys; Work keeps its query in workFilters.
  const [editing, setEditing] = useState<ViewName | null>(null);
  // A view change by pointer leaves the filter of the view it came from: its text keys must not reach the new view.
  useEffect(() => { setEditing((old) => old === null || old === view ? old : null); }, [view]);
  const [queries, setQueries] = useState<Record<"Sessions" | "Hosts" | "Activity", string>>({ Sessions: "", Hosts: "", Activity: "" });
  const [workKey, setWorkKey] = useState<string | null>(null);
  const { status, setStatus, busy, setBusy, mutationNotice, mutationEpoch, actionSeq, bumpStatus } = useStatus();
  // Set when a fork did not answer: its outcome is unknown, so another fork waits for the owner to look at the list.
  const [forkUnknown, setForkUnknown] = useState(false);
  const [cursor, setCursor] = useState<Record<ViewName, number>>({ Work: 0, Sessions: 0, Hosts: 0, Activity: 0 });
  // The first row each list was last drawn from; a selection inside that window never scrolls it.
  const [windowStarts, setWindowStarts] = useState<Record<ViewName, number>>({ Work: 0, Sessions: 0, Hosts: 0, Activity: 0 });
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [scope, setScope] = useState<ActivityScope>("Recent");
  // The records of the Activity scope shown, one page at a time; `cursor` is null when the list is complete.
  const [activity, setActivity] = useState<{ scope: ActivityScope; records: readonly ControlNotification[]; cursor: ControlActivityCursor | null }>({ scope: "Recent", records: [], cursor: null });
  const activityGeneration = useRef(0);
  // The notifications of the session the detail or the panel shows, read by session; `key` says which session they belong to.
  const [sessionNotes, setSessionNotes] = useState<{ key: string; records: readonly ControlNotification[] }>({ key: "", records: [] });
  const [sessionDetail, setSessionDetail] = useState<ControlSession | null>(null);
  const [detailOffset, setDetailOffset] = useState(0);
  // The panel and the session overlay follow the newest output until the owner scrolls away from its end.
  const [followOutput, setFollowOutput] = useState(true);
  const notificationSelectionGeneration = useRef(0);
  const [formLoading, setFormLoading] = useState(false);
  const formLoadingRef = useRef(false);
  const formGeneration = useRef(0);
  const [edit, setEdit] = useState("");
  const [form, setForm] = useState<LaunchForm>(EMPTY_FORM);
  const [launchOptions, setLaunchOptions] = useState<LaunchOptions | null>(null);
  const [actions, setActions] = useState<readonly ActionChoice[]>([]);
  const [created, setCreated] = useState<CreatedSession | null>(null);
  // The link chooser of `l`: the session, the highlighted line and the overlay it returns to on Esc or a pick.
  // The chooser names its session by host and id and its highlight by URL, so a refresh re-resolves both.
  // The ref the control data calls after each control read. It is set below, once the activity page is declared.
  const afterControlRead = useRef<() => void>(() => undefined);
  const { alive, snapshot, setSnapshot, work, stale, refresh } = useControlData(control, options, { setStatus, actionSeq, mutationEpoch, mutationNotice }, afterControlRead);

  useEffect(() => {
    const restore = (): void => { setMouseTracking(false); };
    process.on("exit", restore);
    setMouseTracking(true);
    return () => { process.removeListener("exit", restore); restore(); };
  }, []);

  /** Every inline attach runs through here: the child ends with its session, and a failed attach is reported. */
  const attachInline = useCallback((host: string, id: string, run: (end: ChildEnd) => Promise<InteractiveOutcome>): Promise<void> =>
    handover(run, control, host, id, options.timeoutMs), [control, options.timeoutMs]);

  const suspendForChild = useCallback(<T,>(action: () => Promise<T>): Promise<T> => suspendChild(suspendTerminal, alive, action), [suspendTerminal]);

  const sessions = useMemo(() => snapshot === null ? [] : filterSessions(snapshot, orderedSessions(snapshot, projectFilter), queries.Sessions), [snapshot, projectFilter, queries.Sessions]);
  // The picker's query narrows its choices only while the picker is open.
  const pickSearch = overlay.kind === "projects" ? overlay.search : "";
  const pickChoices = useMemo(() => projectChoices(snapshot?.sessions ?? [], pickSearch), [snapshot, pickSearch]);
  const records = useMemo(() => fuzzyFilter(activity.scope === scope ? activity.records : [], queries.Activity, recordTerms), [activity, scope, queries.Activity]);
  const hostRows = useMemo(() => snapshot === null ? [] : fuzzyFilter(snapshot.hosts, queries.Hosts, hostTerms), [snapshot, queries.Hosts]);
  const workRows = useMemo(() => work?.payload === null || work === null ? null : filterRows(work.payload, workFilters, staleCutoff(Date.now(), options.stalePrDays)), [work, workFilters, options.stalePrDays]);
  const selectedWork = workRows?.find((item) => rowId(item) === workKey) ?? selectedAt(workRows ?? [], cursor.Work);
  // The item and the action choice exist only while the work detail or its preview is open.
  const workOverlay = overlay.kind === "work-detail" || overlay.kind === "work-preview" ? overlay : null;
  const workDetail = work?.payload?.items.find((item) => rowId(item) === workOverlay?.key) ?? null;
  const originOf = useCallback((session: ControlSession): string | null => snapshot?.projects.find((entry) => entry.host === session.host && entry.id === session.projectId)?.originUrl ?? null, [snapshot]);
  const linksOf = useCallback((session: ControlSession): SessionLink[] => sessionLinks(session, work?.payload?.items ?? null, originOf(session)), [originOf, work]);
  const selectedWorkAction = workDetail?.actions[workOverlay?.choice ?? 0];
  const previewMatchesSelection = overlay.kind === "work-preview" && typeof overlay.preview !== "string" && overlay.preview.kind === "ok" &&
    workDetail !== null && selectedWorkAction !== undefined && overlay.preview.key === workDetail.key && overlay.preview.action === selectedWorkAction.name;
  const selectedWorkIndex = selectedWork === null ? 0 : workRows?.indexOf(selectedWork) ?? 0;
  const selectedSession = sessions.find((session) => `${session.host}/${session.id}` === sessionKey) ?? selectedAt(sessions, cursor.Sessions);
  const split = options.mode === "main" && stdout.columns >= options.detailMinWidth;
  // The session shown beside the list or in the overlay is read live; a read for a session the owner has left is dropped.
  const liveSession = overlay.kind === "session" ? sessionDetail : split && view === "Sessions" ? selectedSession : null;
  const liveHost = liveSession?.host ?? null;
  const liveId = liveSession?.id ?? null;
  const { screen, setScreen, restartOutput } = useLiveOutput(control, options, liveHost, liveId);
  // The side panel shows the highlighted session; its screen is kept only for that session.
  const panelScreen = screen !== null && selectedSession !== null && screen.sessionId === selectedSession.id ? screen : null;
  const selectedSessionIndex = selectedSession === null ? 0 : sessions.indexOf(selectedSession);
  const selectedHost = selectedAt(hostRows, cursor.Hosts);
  const selectedRecord = selectedAt(records, cursor.Activity);
  const visibleRows = Math.max(2, Math.floor((stdout.rows - layout.listReservedRows) / 2));
  const detailHeight = Math.max(4, stdout.rows - layout.detailReservedRows);
  const noteSession = overlay.kind === "session" && sessionDetail !== null ? sessionDetail : selectedSession;
  const noteHost = noteSession?.host ?? null;
  const noteId = noteSession?.id ?? null;
  const detailNotifications = useMemo(() => {
    const byId = new Map<string, ControlNotification>();
    for (const record of snapshot?.notifications ?? []) byId.set(`${record.host}/${record.id}`, record);
    if (noteHost !== null && noteId !== null && sessionNotes.key === `${noteHost}/${noteId}`) {
      for (const record of sessionNotes.records) if (!byId.has(`${record.host}/${record.id}`)) byId.set(`${record.host}/${record.id}`, record);
    }
    return [...byId.values()];
  }, [snapshot, sessionNotes, noteHost, noteId]);
  useEffect(() => {
    if (noteHost === null || noteId === null) return undefined;
    const key = `${noteHost}/${noteId}`;
    let current = true;
    void control.sessionNotifications(noteHost, noteId).then((result) => {
      if (!current || !alive.current) return;
      if (result.ok) setSessionNotes({ key, records: result.data });
      else {
        setSessionNotes((previous) => previous.key === key ? previous : { key, records: [] });
        bumpStatus(`Session notifications unavailable: ${result.error.message}`);
      }
    });
    return () => { current = false; };
  }, [control, noteHost, noteId, bumpStatus]);

  // The Activity list reads its scope's first page when the view or the scope is shown; more pages are read on demand.
  const readActivityPage = useCallback(async (target: ActivityScope, cursor: ControlActivityCursor | null): Promise<void> => {
    const generation = ++activityGeneration.current;
    const result = await control.activity(CONTROL_SCOPE[target], cursor);
    if (!alive.current || generation !== activityGeneration.current) return;
    // A failed read keeps the records already shown.
    if (!result.ok) { bumpStatus(`Activity read failed: ${result.error.message}`); return; }
    // The records of the hosts that answered are shown; a failed host is read again by the next load or refresh.
    const [firstError] = result.data.errors;
    if (firstError !== undefined) bumpStatus(`Activity read failed on ${firstError.host}: ${firstError.error.message}`);
    setActivity((previous) => {
      if (cursor === null || previous.scope !== target) return { scope: target, records: result.data.records, cursor: result.data.cursor };
      // A page can repeat a record a refresh already put in the list; each record is shown once.
      const shown = new Set(previous.records.map((record) => `${record.host}/${record.id}`));
      const more = result.data.records.filter((record) => !shown.has(`${record.host}/${record.id}`));
      return { scope: target, records: [...previous.records, ...more].sort(compareActivityOrder), cursor: result.data.cursor };
    });
  }, [bumpStatus, control]);
  // A refresh re-reads the first page of the open scope. The loaded records after that page in the activity order are
  // kept, minus any that left the scope, because the next page reads from where the first page ends. The records of a
  // host the refresh could not read are kept too, since the refresh does not show them again.
  const reconcileActivity = useCallback(async (target: ActivityScope): Promise<void> => {
    const generation = ++activityGeneration.current;
    const result = await control.activity(CONTROL_SCOPE[target], null);
    if (!alive.current || generation !== activityGeneration.current || !result.ok) return;
    setActivity((previous) => {
      if (previous.scope !== target) return previous;
      if (result.data.cursor === null) return { scope: target, records: result.data.records, cursor: null };
      const fresh = result.data.records;
      const tail = fresh[fresh.length - 1];
      const failedHosts = new Set(result.data.errors.map((item) => item.host));
      const shown = new Set(fresh.map((record) => `${record.host}/${record.id}`));
      const older = previous.records.filter((record) => !shown.has(`${record.host}/${record.id}`) && activityMatches(target, record)
        && (failedHosts.has(record.host) || (tail !== undefined && compareActivityOrder(record, tail) > 0)));
      return { scope: target, records: [...fresh, ...older].sort(compareActivityOrder), cursor: result.data.cursor };
    });
  }, [control]);
  const activityView = useRef<{ view: ViewName; scope: ActivityScope }>({ view: "Work", scope: "Recent" });
  activityView.current = { view, scope };
  afterControlRead.current = (): void => { if (activityView.current.view === "Activity") void reconcileActivity(activityView.current.scope); };
  useEffect(() => {
    if (view !== "Activity") return;
    setActivity({ scope, records: [], cursor: null });
    void readActivityPage(scope, null);
  }, [view, scope, readActivityPage]);
  const loadMoreActivity = useCallback((): void => {
    if (activity.cursor !== null && activity.scope === scope) void readActivityPage(scope, activity.cursor);
  }, [activity, readActivityPage, scope]);

  // A notification that changes while Activity is open updates the loaded page; the page is not read again.
  // The session notes follow the same events: a change to the session's record replaces it, and a removal drops it.
  useEffect(() => control.subscribeNotifications((change) => {
    if (!alive.current) return;
    setActivity((previous) => ({ ...previous, records: applyActivityChange(previous.records, previous.scope, change, previous.cursor === null) }));
    setSessionNotes((previous) => {
      const others = previous.records.filter((record) => !(record.host === change.host && record.id === change.id));
      const record = change.record;
      if (record !== null && `${record.host}/${record.sessionId}` === previous.key) return { key: previous.key, records: [...others, record] };
      return { key: previous.key, records: others };
    });
  }), [control]);

  const panelMaxOffset = selectedSession === null ? 0 : sessionDetailMaxOffset(selectedSession, panelScreen, detailHeight, detailNotifications, linksOf(selectedSession), noLinkReason(selectedSession, work, originOf(selectedSession)));
  // Following the output keeps the end of the text in view; a scroll that reaches the end resumes following.
  const panelOffset = followOutput ? panelMaxOffset : Math.min(detailOffset, panelMaxOffset);
  // The list takes half of a split terminal; the panel takes the rest. Each row keeps a margin of one column.
  const listWidth = split ? Math.floor(stdout.columns / 2) : stdout.columns;
  const detailMaxOffset = sessionDetail === null ? 0 : sessionDetailMaxOffset(sessionDetail, screen, detailHeight, detailNotifications, linksOf(sessionDetail), noLinkReason(sessionDetail, work, originOf(sessionDetail)));
  const overlayOffset = followOutput ? detailMaxOffset : Math.min(detailOffset, detailMaxOffset);
  const scrollDetail = (next: number, max: number): void => {
    const clamped = Math.max(0, Math.min(max, next));
    setDetailOffset(clamped);
    setFollowOutput(clamped >= max);
  };
  const previewHeight = Math.max(4, stdout.rows - layout.previewReservedRows);
  const previewWidth = Math.max(20, stdout.columns - 4);
  const previewMaxOffset = overlay.kind === "work-preview" ? workPreviewMaxOffset(overlay.preview, previewWidth, previewHeight) : 0;
  const sessionWritable = sessionDetail !== null && isWritable(sessionDetail);
  const sessionMutable = sessionDetail !== null && isMutable(sessionDetail);
  const sessionActive = sessionDetail !== null && isActive(sessionDetail);
  const sessionAttachable = sessionMutable && (sessionActive || sessionDetail.canResume);
  const sessionRecoverable = sessionWritable && sessionDetail.canResume && (!sessionActive || sessionDetail.runtimeState === "lost");

  useEffect(() => { setDetailOffset(0); setFollowOutput(true); }, [sessionKey]);



  const loadForm = useCallback(async (host: string, preferredProject: string | null = null, assistant = false): Promise<void> => {
    // The form targets the requested host at once; a response for an earlier request is dropped.
    const generation = ++formGeneration.current;
    formLoadingRef.current = true;
    setFormLoading(true);
    // Host-specific values are cleared with the host so a submission cannot carry them to another host.
    setForm((previous) => previous.host === host ? previous : { ...previous, host, project: null, action: null, agent: null, prompt: "", branch: "", baseBranch: "", choice: 0 });
    setActions([]);
    try {
      const loaded = await launcher.loadOptions(host);
      if (generation !== formGeneration.current) return;
      const project = loaded.projects.find((entry) => entry.id === preferredProject || entry.label === preferredProject)?.id ?? loaded.projects[0]?.id ?? null;
      const eligibleAgents = loaded.agents.filter((agent) => !assistant || agent.assistantCapable);
      setLaunchOptions(loaded);
      setForm((previous) => ({ ...previous, host, project, choice: 0,
        agent: eligibleAgents.find((agent) => agent.id === previous.agent)?.id ?? eligibleAgents[0]?.id ?? null }));
      const loadedActions = project === null ? [] : await launcher.loadActions(host, project);
      if (generation === formGeneration.current) setActions(loadedActions);
    } catch (error) {
      if (generation === formGeneration.current) bumpStatus(`Launch options: ${defaultStatus(error)}`);
    } finally {
      if (generation === formGeneration.current) {
        formLoadingRef.current = false;
        setFormLoading(false);
      }
    }
  }, [launcher]);

  const chooseProject = useCallback(async (project: string): Promise<void> => {
    setForm((old) => ({ ...old, project, action: null, agent: null, prompt: "", branch: "", baseBranch: "", search: "", choice: 0 }));
    setActions([]);
    try { setActions(await launcher.loadActions(form.host, project)); }
    catch (error) { bumpStatus(`Project actions: ${defaultStatus(error)}`); }
  }, [form.host, launcher]);

  const chooseAction = useCallback(async (action: string | null): Promise<void> => {
    if (action === null || form.project === null) { setForm((old) => ({ ...old, action: null, agent: null, prompt: "", branch: "", baseBranch: "" })); return; }
    setBusy(true);
    try {
      const resolved = await launcher.resolveAction(form.host, form.project, action);
      setForm((old) => ({ ...old, action, agent: resolved.agent, branch: resolved.branch ?? "", baseBranch: resolved.baseBranch ?? "", prompt: resolved.prompt }));
    } catch (error) { bumpStatus(`Action template: ${defaultStatus(error)}`); }
    finally { setBusy(false); }
  }, [form.host, form.project, launcher]);

  useEffect(() => { if (options.mode === "new-session") void loadForm("local"); }, [loadForm, options.mode]);

  const openForm = useCallback((assistant: boolean): void => {
    setLauncher(newLauncher());
    setCreated(null);
    const host = view === "Sessions" ? selectedSession?.host ?? "local" : "local";
    const project = view === "Sessions" ? selectedSession?.projectId ?? null : selectedWork?.project ?? null;
    setForm({ ...EMPTY_FORM, host, project });
    setOverlay({ kind: assistant ? "assistant" : "form" });
    void loadForm(host, project, assistant);
  }, [loadForm, newLauncher, selectedSession, selectedWork, view]);

  /** Opens a session in the window that `attach_command` starts; throws with the reason when the launch check fails. */
  const openAttachWindowFor = useCallback(async (host: string, id: string): Promise<string> => {
    if (options.attachCommand === undefined || options.attachLaunchCheckMs === undefined) throw new Error("window attach needs attach_command in [tui]");
    if (!ATTACH_HOST.test(host) || !ATTACH_VALUE.test(id)) throw new Error("the session's host or id is not a plain name, so it is not passed to the window");
    const argv = renderAttachArgv(options.attachCommand, { bin: options.pohunekBin, host, id });
    const result = await openAttachWindow(argv, { launchCheckMs: options.attachLaunchCheckMs });
    if (!result.ok) throw new Error(result.message);
    return `Session ${id} opened in a new window`;
  }, [options.attachCommand, options.attachLaunchCheckMs, options.pohunekBin]);

  /** Attaches a session in the window or inline, as attach_mode says; returns the window's status line, or null when it ran inline. */
  const attachSession = useCallback(async (host: string, id: string, inline: (end: ChildEnd) => Promise<InteractiveOutcome>): Promise<string | null> => {
    if (options.attachMode === "window") return openAttachWindowFor(host, id);
    await suspendForChild(() => attachInline(host, id, inline));
    return null;
  }, [attachInline, openAttachWindowFor, options.attachMode, suspendForChild]);

  const attachCreated = useCallback(async (): Promise<void> => {
    if (created === null || busy) return;
    actionSeq.current += 1;
    setBusy(true);
    try {
      const windowed = await attachSession(created.host, created.sessionId, (end) => launcher.attachSession(end).then((attached) => attached.outcome));
      if (windowed !== null) {
        bumpStatus(windowed);
        if (options.mode === "new-session") options.onWindowOpened?.(`opened ${created.sessionId} in a new window`);
      }
      if (options.mode === "new-session") { setExitCode(0); exit(); }
      else { setCreated(null); setOverlay({ kind: "none" }); void refresh(); }
    } catch (error) {
      if (options.mode === "new-session") setExitCode(2);
      bumpStatus(`Session ${created.host}/${created.sessionId} exists; attach failed: ${defaultStatus(error)}`);
    } finally {
      setBusy(false);
    }
  }, [attachSession, busy, created, exit, launcher, options.mode, refresh, setExitCode]);

  const submitForm = useCallback(async (): Promise<void> => {
    if (formLoadingRef.current) { bumpStatus("Host options are still loading; submit when they finish"); return; }
    if (busy || created !== null) return;
    actionSeq.current += 1;
    setBusy(true);
    try {
      const request: LaunchRequest = overlay.kind === "assistant" ? {
        kind: "assistant", host: form.host, project: form.project, branch: nullable(form.branch), baseBranch: nullable(form.baseBranch),
        intent: form.intent, agent: form.agent, request: null, noSnapshot: false, degraded: false,
      } : {
        kind: "session", host: form.host, project: form.project, branch: nullable(form.branch), baseBranch: nullable(form.baseBranch),
        agent: form.agent, name: nullable(form.name), prompt: nullable(form.prompt),
      };
      const result = await launcher.createSession(request);
      setCreated(result);
      if (result.warnings.length > 0) {
        bumpStatus(`Created ${result.host}/${result.sessionId} with ${result.warnings.length} warning(s); review before attaching`);
        return;
      }
      bumpStatus(`Created ${result.host}/${result.sessionId}; attaching…`);
      try {
        const windowed = await attachSession(result.host, result.sessionId, (end) => launcher.attachSession(end).then((attached) => attached.outcome));
        if (windowed !== null) {
          bumpStatus(windowed);
          if (options.mode === "new-session") options.onWindowOpened?.(`opened ${result.sessionId} in a new window`);
        }
        if (options.mode === "new-session") { setExitCode(0); exit(); }
        else { setCreated(null); setOverlay({ kind: "none" }); void refresh(); }
      } catch (error) {
        if (options.mode === "new-session") setExitCode(2);
        bumpStatus(`Session ${result.host}/${result.sessionId} exists; attach failed: ${defaultStatus(error)}`);
      }
    } catch (error) {
      if (options.mode === "new-session") setExitCode(2);
      bumpStatus(defaultStatus(error));
    } finally {
      setBusy(false);
    }
  }, [attachSession, busy, created, exit, form, launcher, options.mode, overlay.kind, refresh, setExitCode]);

  const inspectSessionAt = useCallback(async (host: string, id: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await control.inspectSession(host, id);
      if (!result.ok) { bumpStatus(result.error.message); return; }
      setSessionDetail(result.data);
      setDetailOffset(0);
      setFollowOutput(true);
      setSessionKey(`${host}/${id}`);
      setView("Sessions");
      setScreen(null);
      setOverlay({ kind: "session" });
    } catch (error) { bumpStatus(defaultStatus(error)); }
    finally { setBusy(false); }
  }, [control]);

  const inspectHost = useCallback(async (host: ControlHost): Promise<void> => {
    if (!host.dialable) { bumpStatus(`Host ${host.name} has no dialable identity`); return; }
    setBusy(true);
    try {
      const [capabilities, policy] = await Promise.all([
        control.inspectHost(host.route), control.inspectGovernance(host.route),
      ]);
      const failures = [capabilities.ok ? null : capabilities.error.message, policy.ok ? null : policy.error.message].filter((message): message is string => message !== null);
      if (failures.length > 0) bumpStatus(failures.join("; "));
      setOverlay({ kind: "host", capabilities: capabilities.ok ? capabilities.data : null, governance: policy.ok ? policy.data : null });
    } catch (error) { bumpStatus(defaultStatus(error)); }
    finally { setBusy(false); }
  }, [control]);

  const openNotification = useCallback(async (record: ControlNotification): Promise<void> => {
    const generation = ++notificationSelectionGeneration.current;
    setOverlay({ kind: "notification", record });
    if (record.status === "unread") {
      if (stale || snapshot?.errors.some((error) => error.host === record.host && error.scope === "notifications")) {
        bumpStatus("Notification data is stale; it was not marked read");
      } else {
        try {
          const result = await control.act({ kind: "read", host: record.host, notificationId: record.id });
          if (!result.ok) {
            if (notificationSelectionGeneration.current === generation) bumpStatus(`Mark read failed: ${result.error.message}`);
          } else {
            if (result.data.kind === "read" && notificationSelectionGeneration.current === generation) {
              const updated = result.data.notification;
              setOverlay((current) => current.kind === "notification" && current.record.host === record.host && current.record.id === record.id ? { kind: "notification", record: updated } : current);
            }
            await refresh();
          }
        } catch (error) { if (notificationSelectionGeneration.current === generation) bumpStatus(`Mark read failed: ${defaultStatus(error)}`); }
      }
    }
  }, [control, refresh, snapshot, stale]);

  const updateNotification = useCallback(async (record: ControlNotification, kind: "ack" | "archive"): Promise<void> => {
    const generation = notificationSelectionGeneration.current;
    if (stale || snapshot?.errors.some((error) => error.host === record.host && error.scope === "notifications")) {
      bumpStatus("Notification data is stale; refresh before changing it"); return;
    }
    try {
      const result = await control.act({ kind, host: record.host, notificationId: record.id });
      if (!result.ok) bumpStatus(`${kind} failed: ${result.error.message}`);
      else {
        // The notification the daemon returned is shown at once; the reconcile below supersedes any read still in flight.
        mutationEpoch.current += 1;
        if ("notification" in result.data) {
          const updated = result.data.notification;
          setSnapshot((previous) => previous === null ? previous : { ...previous, notifications: previous.notifications.map((item) => item.host === updated.host && item.id === updated.id ? updated : item) });
          setActivity((previous) => ({ ...previous, records: previous.records.map((item) => item.host === updated.host && item.id === updated.id ? updated : item) }));
          setOverlay((current) => current.kind === "notification" && current.record.host === updated.host && current.record.id === updated.id ? { kind: "notification", record: updated } : current);
        }
        bumpStatus(`Notification ${kind === "ack" ? "acknowledged" : "archived"}`);
        await refresh();
        // Closes after the list is read, and only if this notification is still the one open: the owner may have
        // left it and opened another, which has the same overlay name.
        if (notificationSelectionGeneration.current === generation) setOverlay((current) => current.kind === "notification" ? { kind: "none" } : current);
      }
    } catch (error) { bumpStatus(`${kind} failed: ${defaultStatus(error)}`); }
  }, [control, refresh, snapshot, stale]);

  const runSessionAction = useCallback(async (action: ControlAction, expected: ControlSession | null = sessionDetail, confirmed: ControlSession | null = null): Promise<void> => {
    if (expected === null || busy || stale || sessionsUnreadable(snapshot, expected.host)) {
      bumpStatus("Session data is stale or unavailable; refresh before changing it");
      return;
    }
    mutationNotice.current = null;
    if (action.kind === "fork" && forkUnknown) {
      bumpStatus("The last fork did not answer, so it may exist; press r to review the Sessions list before forking again");
      return;
    }
    actionSeq.current += 1;
    setBusy(true);
    try {
      const latest = await control.inspectSession(expected.host, expected.id);
      if (!latest.ok) { bumpStatus(latest.error.message); return; }
      if (!sameSession(expected, latest.data)) { setSessionDetail(latest.data); bumpStatus("Session changed; review the new state before acting"); return; }
      if (confirmed !== null && !sameRecoveryTarget(confirmed, latest.data)) { bumpStatus("Recovery target changed; review it before confirming again"); return; }
      if (!isWritable(latest.data)) {
        bumpStatus("This runtime is read-only"); return;
      }
      const outcome = await control.act(action);
      if (!outcome.ok) {
        mutationNotice.current = outcome.error.message;
        bumpStatus(outcome.error.message);
        // The fork's overlay offers Resume on r, so the owner is taken to the list, where r refreshes it.
        if (outcome.error.code === "outcome_unknown" && action.kind === "fork") { setForkUnknown(true); setOverlay({ kind: "none" }); }
        // What the daemon holds may differ from what the owner sees, so the list is read again after a failed mutation.
        if (outcome.error.code === "outcome_unknown" || action.kind === "remove") await refresh();
        return;
      }
      if (outcome.data.kind === "remove" && (!outcome.data.removed || outcome.data.worktreesFailed > 0)) {
        bumpStatus(`Removal unverified; session ${expected.host}/${expected.id} may remain. Inspect before retrying.`);
        await refresh();
        return;
      }
      if (outcome.data.kind === "stop" && !outcome.data.stopped) {
        bumpStatus(`Stop unverified; inspect session ${expected.host}/${expected.id}`);
        await refresh();
        return;
      }
      // The list read starts before the completion message. A read queued behind one already in flight can still warn over the message; the warning stays visible.
      if (outcome.data.kind !== "resume") {
        void refresh();
        bumpStatus(`${action.kind} completed`);
        setOverlay({ kind: "none" });
        return;
      }
      bumpStatus(`${action.kind} completed`);
      setOverlay({ kind: "none" });
      {
        const resumed = outcome.data.session;
        try {
          const windowed = await attachSession(resumed.host, resumed.id, (end) => execInteractive([options.pohunekBin, "attach", "--host", resumed.host, "--", resumed.id], end));
          if (windowed !== null) bumpStatus(windowed);
        } catch (error) { bumpStatus(`Session resumed at ${resumed.host}/${resumed.id}; attach failed: ${defaultStatus(error)}`); }
      }
      void refresh();
    } catch (error) { bumpStatus(defaultStatus(error)); }
    finally { setBusy(false); }
  }, [attachSession, busy, control, options.pohunekBin, refresh, sessionDetail, snapshot, stale]);

  const requestRecovery = useCallback(async (kind: RecoveryRequest["kind"], target: ControlSession, returnTo: ReturnKind): Promise<void> => {
    if (busy || stale || sessionsUnreadable(snapshot, target.host)) {
      bumpStatus("Session data is stale or unavailable; refresh before recovering it"); return;
    }
    setBusy(true);
    try {
      const latest = await control.inspectSession(target.host, target.id);
      if (!latest.ok) { bumpStatus(latest.error.message); return; }
      if (!sameSession(target, latest.data)) { bumpStatus("Session changed; review the new state before recovering it"); return; }
      if (!isWritable(latest.data)) { bumpStatus("This runtime is read-only"); return; }
      if (latest.data.nativeTarget.status === "invalid") { bumpStatus(`Recovery target unavailable: ${latest.data.nativeTarget.reason}`); return; }
      if (kind === "fork" ? !latest.data.canFork : !latest.data.canResume) { bumpStatus(`This session cannot be ${kind === "fork" ? "forked" : "resumed"}`); return; }
      setOverlay({ kind: "recovery", request: { kind, session: latest.data, returnTo } });
    } catch (error) { bumpStatus(defaultStatus(error)); }
    finally { setBusy(false); }
  }, [busy, control, snapshot, stale]);

  const confirmRecovery = useCallback((request: RecoveryRequest): void => {
    // A fork opens its terminal at the size of this one, so the forked session starts with the owner's dimensions.
    const action: ControlAction = request.kind === "fork"
      ? { kind: "fork", host: request.session.host, sessionId: request.session.id, cols: stdout.columns, rows: stdout.rows }
      : { kind: "resume", host: request.session.host, sessionId: request.session.id };
    void runSessionAction(action, request.session, request.session);
  }, [runSessionAction]);

  /** Attaches the given session, or the one on screen when none is given. */
  const openSelected = useCallback(async (picked?: ControlSession): Promise<void> => {
    const target = picked ?? (overlay.kind === "session" ? sessionDetail : selectedSession);
    if (target === null) return;
    if (isAttachBlocked(target)) {
      bumpStatus("This session cannot be opened from the TUI"); return;
    }
    if (target.canResume && target.state !== "running") {
      await requestRecovery("resume", target, overlay.kind === "session" ? "session" : "none");
      return;
    }
    setBusy(true);
    try {
      const windowed = await attachSession(target.host, target.id, (end) => execInteractive([options.pohunekBin, "attach", "--host", target.host, "--", target.id], end));
      if (windowed !== null) bumpStatus(windowed);
      // Not awaited inside the busy window: the work list can take seconds, and input must not wait for it.
      void refresh();
    } catch (error) { bumpStatus(`Attach: ${defaultStatus(error)}`); }
    finally { setBusy(false); }
  }, [attachSession, options.pohunekBin, overlay.kind, refresh, requestRecovery, selectedSession, sessionDetail]);

  const openLink = useCallback((raw: string): void => {
    const checked = checkOpenUrl(raw, options.openUrlHosts);
    if (!checked.ok) { bumpStatus(`Not opened: ${checked.reason}`); return; }
    try {
      openExternal(options.openCommand, checked.href);
      bumpStatus(`Opened ${checked.host}`);
    } catch (error) { bumpStatus(`Open link: ${defaultStatus(error)}`); }
  }, [options.openCommand, options.openUrlHosts]);

  // The branch page comes from the project's GitHub origin; without one the status says so instead of guessing.
  const openBranch = useCallback((session: ControlSession): void => {
    const url = githubBranchUrl(originOf(session), session.branch);
    if (url === null) { bumpStatus("No GitHub branch page: the session has no branch or its project has no GitHub origin"); return; }
    openLink(url);
  }, [openLink, originOf]);

  // A numbered line of the Links block (a click on it) opens that link directly.
  const openLinkNumber = useCallback((session: ControlSession, number: number): void => {
    const link = linksOf(session)[number - 1];
    if (link === undefined) { bumpStatus(`No link ${String(number)} on this session`); return; }
    openLink(link.url);
  }, [linksOf, openLink]);

  // `l`: no link reports it, one link opens directly, several open the chooser that returns to `returnTo`.
  const chooseLink = useCallback((session: ControlSession, returnTo: "none" | "session"): void => {
    const links = linksOf(session);
    if (links.length === 0) { bumpStatus(`No link: ${noLinkReason(session, work, originOf(session))}`); return; }
    const only = links[0];
    if (links.length === 1 && only !== undefined) { openLink(only.url); return; }
    setOverlay({ kind: "links", chooser: { host: session.host, id: session.id, url: links[0]?.url ?? null, returnTo } });
  }, [linksOf, openLink, originOf, work]);

  // The picker opens on the current project filter with its full list, so a stale search cannot hide that project.
  const openProjectPicker = useCallback((): void => {
    const index = projectChoices(snapshot?.sessions ?? [], "").findIndex((choice) => choice.label === projectFilter);
    setOverlay({ kind: "projects", index: Math.max(0, index), search: "", filtering: false });
  }, [projectFilter, snapshot]);

  const openFolder = useCallback(async (session: ControlSession): Promise<void> => {
    if (session.host !== "local") { bumpStatus("Remote paths can be copied but cannot be opened on this host"); return; }
    const path = session.worktreePath ?? session.cwd;
    if (!isAbsolute(path)) { bumpStatus("The session path is not absolute"); return; }
    try {
      if (!(await stat(path)).isDirectory()) { bumpStatus("The session path is not a directory"); return; }
      openExternal(options.openCommand, path);
      bumpStatus("Opened session folder");
    } catch (error) { bumpStatus(`Open folder: ${defaultStatus(error)}`); }
  }, [options.openCommand]);

  const copyValue = useCallback(async (value: string): Promise<void> => {
    if (options.clipboardCommand === undefined) { bumpStatus(`Select and copy this value: ${safeText(value)}`); return; }
    try {
      const result = await exec([options.clipboardCommand], { timeoutMs: options.timeoutMs, stdin: value });
      bumpStatus(result.exitCode === 0 && !result.timedOut ? "Copied to clipboard" : "Clipboard command failed");
    } catch (error) { bumpStatus(`Clipboard command failed: ${defaultStatus(error)}`); }
  }, [options.clipboardCommand, options.timeoutMs]);

  const workHandover = useCallback(async (action: string): Promise<void> => {
    if (workDetail === null || busy) return;
    const checked = workActionArgv(options.selfBin, workDetail.key, action, workDetail.project);
    if (!checked.ok) { bumpStatus(checked.reason); return; }
    actionSeq.current += 1;
    setBusy(true);
    const started = actionSeq.current;
    let report: string;
    try {
      if (action === "attach" && options.attachMode === "window") {
        // The window needs the session id, which the attach plan names; `do attach` itself runs inline.
        const preview = await previewWork(options.selfBin, options.listTimeoutMs, workDetail.key, "attach", workDetail.project);
        if (typeof preview === "string") throw new Error(preview);
        if (preview.kind === "error") throw new Error(`${preview.err.code}: ${preview.err.msg}`);
        if (preview.kind !== "ok") throw new Error(`the attach plan is ${preview.kind}`);
        const id = preview.plan.find((field) => field.label === "session_id")?.value;
        if (id === undefined) throw new Error("the attach plan names no session");
        report = await openAttachWindowFor("local", id);
      } else if (action === "attach") {
        const outcome = await suspendForChild(() => execInteractive(checked.argv));
        report = outcome.kind === "exited" && outcome.code === 0 ? "Detached from work session"
          : outcome.kind === "exited" ? `Attach ended with exit ${String(outcome.code)}` : outcome.kind === "ended" ? "Attach ended with its session" : `Attach was stopped by ${outcome.signal}`;
      } else {
        const run = await suspendForChild(() => execInteractiveCapture(checked.argv, layout.actionCaptureBytes));
        if (run.stdout === null) report = "Action output exceeded the capture limit; inspect sessions before retrying";
        else {
          const outcome = decodeDoEnvelope(run.stdout);
          if (outcome.kind === "error") report = `${outcome.err.code}: ${outcome.err.msg}`;
          else if (outcome.kind !== "ok") report = `Action result ${outcome.kind}; inspect sessions before retrying`;
          else if (run.exitCode !== 0 || outcome.dryRun) report = `Action result conflicts with exit ${String(run.exitCode)}; inspect sessions before retrying`;
          else {
            const session = outcome.result?.find((field) => field.label === "session_id")?.value;
            const warnings = outcome.result?.find((field) => field.label === "warnings")?.value;
            report = `${action} completed${session === undefined ? "" : `; session ${session}`}${warnings === undefined ? "" : `; warnings: ${warnings}`}`;
          }
        }
      }
      setOverlay({ kind: "none" });
    } catch (error) {
      bumpStatus(`Work action: ${defaultStatus(error)}`);
      return;
    } finally { setBusy(false); }
    // Read after the busy flag is cleared, so input is not refused while the list loads; the report is set last.
    await refresh();
    // A mutation that started during the read may have set its own result; that result takes precedence.
    if (actionSeq.current === started) setStatus(report);
  }, [busy, openAttachWindowFor, options.attachMode, options.listTimeoutMs, options.selfBin, refresh, suspendForChild, workDetail]);

  const previewWorkAction = useCallback(async (action: string): Promise<void> => {
    if (workDetail === null || busy) return;
    setBusy(true);
    try {
      const preview = await previewWork(options.selfBin, options.listTimeoutMs, workDetail.key, action, workDetail.project);
      // The choice is the one the owner has now, when the detail is still open; Esc from the preview returns to it.
      setOverlay((current) => ({ kind: "work-preview", key: rowId(workDetail), choice: current.kind === "work-detail" ? current.choice : 0, preview, offset: 0 }));
    } catch (error) { bumpStatus(`Plan preview: ${defaultStatus(error)}`); }
    finally { setBusy(false); }
  }, [busy, options.listTimeoutMs, options.selfBin, workDetail]);

  /** Asks for a stop or a remove of `target`; the flags are the ones the detail offers. */
  const requestConfirm = useCallback((target: ControlSession, kind: ConfirmAction, returnTo: ReturnKind): void => {
    const writable = isWritable(target);
    const mutable = isMutable(target);
    const active = isActive(target);
    if (kind === "stop" ? !(mutable && active) : !writable) { bumpStatus(kind === "stop" ? "Only a live session can be stopped" : "This session cannot be removed"); return; }
    setOverlay({ kind: "confirm", action: kind, session: target, returnTo });
  }, []);

  // Each view's rows: how many there are, and what opening one does. The selection, the keys and the drawing read the same count.
  const viewRows: Record<ViewName, { readonly count: number; readonly open: (index: number) => void }> = {
    Work: {
      count: workRows?.length ?? 0,
      open: (index) => {
        const item = workRows?.[index];
        if (item !== undefined) setOverlay({ kind: "work-detail", key: rowId(item), choice: 0 });
      },
    },
    Sessions: {
      count: sessions.length,
      open: (index) => {
        const session = sessions[index];
        if (session !== undefined) void inspectSessionAt(session.host, session.id);
      },
    },
    Hosts: {
      count: hostRows.length,
      open: (index) => {
        const host = hostRows[index];
        if (host !== undefined) void inspectHost(host);
      },
    },
    Activity: {
      count: records.length,
      open: (index) => {
        const record = records[index];
        if (record !== undefined) void openNotification(record);
      },
    },
  };

  const selectIndex = useCallback((index: number): void => {
    const count = viewRows[view].count;
    const next = Math.max(0, Math.min(count - 1, index));
    setCursor((old) => ({ ...old, [view]: next }));
    if (view === "Sessions") { const session = sessions[next]; setSessionKey(session === undefined ? null : `${session.host}/${session.id}`); }
    if (view === "Work") { const item = workRows?.[next]; setWorkKey(item === undefined ? null : rowId(item)); }
  }, [sessions, view, viewRows, workRows]);

  /** Moves the Sessions selection to the first row of the next (or the previous) group; the first row of the current group counts as its start. */
  const jumpSection = useCallback((direction: 1 | -1): void => {
    if (snapshot === null) return;
    const starts = sessions.flatMap((session, index) => index === 0 || sessionGroup(session, snapshot.notifications) !== sessionGroup(sessions[index - 1] ?? session, snapshot.notifications) ? [index] : []);
    const current = selectedSessionIndex;
    if (direction === 1) {
      const next = starts.find((start) => start > current);
      if (next !== undefined) selectIndex(next);
      return;
    }
    const currentStart = starts.filter((start) => start <= current).pop() ?? 0;
    selectIndex(current === currentStart ? (starts.filter((start) => start < currentStart).pop() ?? 0) : currentStart);
  }, [selectIndex, selectedSessionIndex, sessions, snapshot]);

  const move = useCallback((delta: number): void => {
    const current = view === "Sessions" ? selectedSessionIndex : view === "Work" ? selectedWorkIndex : cursor[view];
    selectIndex(current + delta);
  }, [cursor, selectedSessionIndex, selectedWorkIndex, selectIndex, view]);

  const openRow = useCallback((index: number): void => {
    const { count, open } = viewRows[view];
    if (count === 0) return;
    const targetIndex = Math.max(0, Math.min(count - 1, index));
    selectIndex(targetIndex);
    open(targetIndex);
  }, [selectIndex, view, viewRows]);

  /**
   * The identity of the item drawn at `index` of `target`. A snapshot refresh can reorder a list between two presses,
   * so a press pair counts as a double click only when both presses name the same item.
   */
  const rowIdentity = useCallback((target: ViewName, index: number): string | null => {
    if (target === "Work") { const item = workRows?.[index]; return item === undefined ? null : `work:${rowId(item)}`; }
    if (target === "Sessions") { const session = sessions[index]; return session === undefined ? null : `session:${session.host}/${session.id}`; }
    if (target === "Hosts") { const host = hostRows[index]; return host === undefined ? null : `host:${host.route}`; }
    const record = records[index];
    return record === undefined ? null : `activity:${record.host}/${record.id}`;
  }, [hostRows, records, sessions, workRows]);

  /**
   * A press on a row selects it and never opens it. A second press on the same row of the same view within
   * `doubleClickMs` does what Enter does on that row: Sessions attaches when the side panel is visible.
   */
  const clickRow = useCallback((index: number): void => {
    const now = Date.now();
    const previous = rowClick.current;
    const id = rowIdentity(view, index);
    rowClick.current = id === null ? null : { id, at: now };
    selectIndex(index);
    if (id === null || previous === null || previous.id !== id || now - previous.at > options.doubleClickMs) return;
    rowClick.current = null;
    if (view === "Sessions" && split) {
      const session = sessions[index];
      if (session !== undefined) void openSelected(session);
      return;
    }
    openRow(index);
  }, [openRow, openSelected, options.doubleClickMs, rowIdentity, selectIndex, sessions, split, view]);

  // Stores the choice of pick field `focus`; the field's own action runs where it has one (host, project, action).
  const applyPick = (focus: number, item: PickItem, assistant: boolean): void => {
    if (focus === 0) { if (item.value !== null) void loadForm(item.value, form.project, assistant); }
    else if (focus === 1) { if (item.value !== null) void chooseProject(item.value); }
    else if (focus === 2) setForm((old) => ({ ...old, agent: item.value }));
    else if (focus === 3) {
      if (!assistant) { void chooseAction(item.value); return; }
      const intent = INTENTS.find((entry) => entry === item.value);
      if (intent !== undefined) setForm((old) => ({ ...old, intent }));
    }
  };

  /** ←/→ move the highlight through the matches of the focused pick field and select the highlighted one. */
  const changeFormChoice = (delta: 1 | -1): void => {
    const assistant = overlay.kind === "assistant";
    const pick = formPick(form, launchOptions, actions, assistant);
    if (pick === null || pick.matches.length === 0) return;
    const count = pick.matches.length;
    const next = pick.highlight < 0 ? (delta > 0 ? 0 : count - 1) : (pick.highlight + delta + count) % count;
    const item = pick.matches[next];
    if (item === undefined) return;
    setForm((old) => ({ ...old, highlight: next }));
    applyPick(form.focus, item, assistant);
  };

  const queryOf = (target: ViewName): string => target === "Work" ? workFilters.text : queries[target];

  /** Changes the query of `target`; the selection returns to the first match because the matches changed. */
  const editQuery = (target: ViewName, update: (text: string) => string): void => {
    if (target === "Work") setWorkFilters((old) => ({ ...old, text: update(old.text) }));
    else setQueries((old) => ({ ...old, [target]: update(old[target]) }));
    setCursor((old) => ({ ...old, [target]: 0 }));
    if (target === "Sessions") setSessionKey(null);
    if (target === "Work") setWorkKey(null);
  };

  const handlePaste = (text: string): void => {
    if (busy) { setStatus(BUSY_REFUSAL); return; }
    if (overlay.kind !== "form" && overlay.kind !== "assistant") return;
    if (created !== null) return;
    const clean = text.replaceAll("\u0000", "");
    const assistant = overlay.kind === "assistant";
    // A pick field takes the paste as its query, like typed text; a text field takes it as text.
    setForm((old) => old.focus <= LAST_PICK_FIELD ? (pastedText(clean) === "" ? old : { ...old, search: old.search + pastedText(clean), highlight: 0 }) : changeTextField(old, clean, assistant, false));
  };
  usePaste((text) => {
    pendingEvents.current.push({ kind: "paste", text });
    setPressTick((old) => old + 1);
  });


  // The work filters and the activity scope change the same way from a key and from a button.
  const cycleActor = useCallback((): void => {
    setWorkFilters((old) => ({ ...old, actor: ACTOR_FILTERS[(ACTOR_FILTERS.indexOf(old.actor) + 1) % ACTOR_FILTERS.length] ?? "all" }));
  }, []);
  const cycleProject = useCallback((): void => {
    if (work?.payload === null || work === null) return;
    const projects = projectLabels(work.payload);
    const index = projects.indexOf(workFilters.project ?? "");
    setWorkFilters((old) => ({ ...old, project: projects[index + 1] ?? null }));
  }, [work, workFilters.project]);
  const toggleStale = useCallback((): void => { setWorkFilters((old) => ({ ...old, hideStale: !old.hideStale })); }, []);
  const cycleScope = useCallback((): void => {
    setScope((old) => SCOPES[(SCOPES.indexOf(old) + 1) % SCOPES.length] ?? "Recent");
    setCursor((old) => ({ ...old, Activity: 0 }));
  }, []);

  /** Forms and the confirmation, recovery and rename overlays take every key, Tab included. */
  const modalKeys = (input: string, key: Key): boolean => {
    if (overlay.kind === "form" || overlay.kind === "assistant") {
      const assistant = overlay.kind === "assistant";
      const pickField = form.focus <= LAST_PICK_FIELD;
      if (created !== null) { if (key.return) void attachCreated(); else if (key.escape) { if (options.mode === "new-session") exit(); else setOverlay({ kind: "none" }); } return true; }
      // Esc first clears the query of a pick field; the next Esc leaves the form.
      if (key.escape) {
        if (form.search !== "") { setForm((old) => ({ ...old, search: "", highlight: 0 })); return true; }
        if (options.mode === "new-session") exit(); else setOverlay({ kind: "none" });
        return true;
      }
      if (key.ctrl && key.return) { void submitForm(); return true; }
      if (key.return && form.focus === submitIndex(assistant)) { void submitForm(); return true; }
      if (key.tab) { setForm((old) => moveFocus(old, nextField(old.focus, key.shift ? -1 : 1, assistant, true))); return true; }
      if (key.upArrow || key.downArrow) { setForm((old) => moveFocus(old, nextField(old.focus, key.upArrow ? -1 : 1, assistant, false))); return true; }
      if (key.leftArrow || key.rightArrow) { changeFormChoice(key.leftArrow ? -1 : 1); return true; }
      if (key.return && pickField) {
        if (form.search === "") { setForm((old) => moveFocus(old, nextField(old.focus, 1, assistant, false))); return true; }
        const pick = formPick(form, launchOptions, actions, assistant);
        const item = pick?.matches[pick.highlight];
        if (item === undefined) { bumpStatus(`No ${formFieldLabel(assistant, form.focus).toLowerCase()} matches "${form.search}"; Backspace edits the query`); return true; }
        applyPick(form.focus, item, assistant);
        setForm((old) => moveFocus(old, nextField(old.focus, 1, assistant, false)));
        return true;
      }
      if (key.return && overlay.kind === "form" && formFields(false)[form.focus]?.text === "prompt") { setForm((old) => ({ ...old, prompt: old.prompt + "\n" })); return true; }
      // The focus is read from the state the update applies to: a click that changed it may not have rendered yet.
      if (key.backspace || key.delete) {
        setForm((old) => old.focus <= LAST_PICK_FIELD ? (old.search === "" ? old : { ...old, search: old.search.slice(0, -1), highlight: 0 }) : changeTextField(old, "", assistant, true));
        return true;
      }
      // Control characters are never text: an input without printable characters types nothing.
      if (!key.ctrl && !key.meta && typedText(input) !== "") {
        setForm((old) => old.focus <= LAST_PICK_FIELD ? (typedText(input) === "" ? old : { ...old, search: old.search + input, highlight: 0 }) : changeTextField(old, input, assistant, false));
      }
      return true;
    }
    if (overlay.kind === "confirm") {
      if (input.toLowerCase() === "y") void runSessionAction({ kind: overlay.action, host: overlay.session.host, sessionId: overlay.session.id }, overlay.session);
      setOverlay({ kind: overlay.returnTo }); return true;
    }
    if (overlay.kind === "recovery") {
      const request = overlay.request;
      setOverlay({ kind: request.returnTo });
      if (input.toLowerCase() === "y") confirmRecovery(request);
      return true;
    }
    if (overlay.kind === "rename" || overlay.kind === "metadata") {
      if (key.escape) { setOverlay({ kind: "session" }); setEdit(""); return true; }
      if (key.return && sessionDetail !== null) {
        if (overlay.kind === "rename") void runSessionAction({ kind: "rename", host: sessionDetail.host, sessionId: sessionDetail.id, name: nullable(edit) });
        else {
          const separator = edit.indexOf("=");
          if (separator < 1) bumpStatus("Metadata needs key=value");
          else void runSessionAction({ kind: "metadata", host: sessionDetail.host, sessionId: sessionDetail.id, set: { [edit.slice(0, separator)]: edit.slice(separator + 1) } });
        }
        return true;
      }
      if (key.backspace || key.delete) setEdit((old) => old.slice(0, -1));
      else if (!key.ctrl && !key.meta) setEdit((old) => old + input);
      return true;
    }
    return false;
  };

  /** Tab and Shift-Tab switch views unless a text field is focused or help is open. */
  const tabKeys = (input: string, key: Key): boolean => {
    // Only Tab and Shift-Tab switch views. A list filter that is typed takes Tab for itself, as a text field does.
    const textFocused = editing !== null || (overlay.kind === "projects" && overlay.filtering);
    if ((key.tab || input === "\u001b[Z") && !textFocused && overlay.kind !== "help" && options.mode === "main") {
      const backward = key.shift || input === "\u001b[Z";
      const direction = backward ? -1 : 1;
      setOverlay({ kind: "none" });
      // The next view is read from the state the update applies to, so each Tab of a run moves one view further.
      setView((old) => VIEWS[(VIEWS.indexOf(old) + direction + VIEWS.length) % VIEWS.length] ?? "Work");
      return true;
    }
    return false;
  };

  /** While a list filter is typed, every key is text. */
  const filterKeys = (input: string, key: Key): boolean => {
    // While a filter is typed every key is text: x, D, 1-4 and the arrows never act on the list.
    if (overlay.kind === "none" && editing !== null) {
      if (key.escape) { editQuery(editing, () => ""); setEditing(null); return true; }
      if (key.return) { setEditing(null); return true; }
      if (key.tab) return true;
      if (key.backspace || key.delete) { editQuery(editing, (old) => old.slice(0, -1)); return true; }
      const typed = key.ctrl || key.meta ? "" : typedText(input);
      if (typed !== "") editQuery(editing, (old) => old + typed);
      return true;
    }
    return false;
  };

  /** Escape clearing a query, `/`, and the section and scope arrows act only with no overlay open. */
  const viewEditKeys = (input: string, key: Key): boolean => {
    if (overlay.kind === "none" && key.escape && queryOf(view) !== "") { editQuery(view, () => ""); return true; }
    if (overlay.kind === "none" && input === "/") { setEditing(view); return true; }
    if (overlay.kind === "none" && view === "Sessions" && (key.leftArrow || key.rightArrow || input === "[" || input === "]")) {
      jumpSection(key.rightArrow || input === "]" ? 1 : -1);
      return true;
    }
    if (overlay.kind === "none" && view === "Activity" && (key.leftArrow || key.rightArrow)) {
      const step = key.rightArrow ? 1 : -1;
      setScope((old) => SCOPES[(SCOPES.indexOf(old) + step + SCOPES.length) % SCOPES.length] ?? "Recent");
      setCursor((old) => ({ ...old, Activity: 0 }));
      return true;
    }
    return false;
  };

  /** Non-modal overlays consume every key they are given. */
  const overlayKeys = (input: string, key: Key): boolean => {
    if (overlay.kind === "help") { if (key.escape || input === "?" || input === "q") setOverlay({ kind: "none" }); return true; }
    if (overlay.kind === "projects") {
      // Changes the picker only while it is still the open overlay.
      const editPick = (change: (old: PickState) => PickState): void => {
        setOverlay((current) => current.kind === "projects" ? { ...current, ...change(current) } : current);
      };
      const chooseProject = (): void => {
        const choice = pickChoices[overlay.index];
        if (choice !== undefined) { setProjectFilter(choice.label); setCursor((old) => ({ ...old, Sessions: 0 })); }
        setOverlay({ kind: "none" });
      };
      if (overlay.filtering) {
        if (key.escape) editPick((old) => ({ ...old, search: "", index: 0, filtering: false }));
        else if (key.return) chooseProject();
        else if (key.backspace || key.delete) editPick((old) => ({ ...old, search: old.search.slice(0, -1), index: 0 }));
        else if (input !== "" && !key.ctrl && !key.meta && !key.tab) editPick((old) => ({ ...old, search: old.search + input, index: 0 }));
        return true;
      }
      if (key.escape) setOverlay({ kind: "none" });
      else if (key.upArrow) editPick((old) => ({ ...old, index: Math.max(0, old.index - 1) }));
      else if (key.downArrow) editPick((old) => ({ ...old, index: Math.min(pickChoices.length - 1, old.index + 1) }));
      else if (input === "/") editPick((old) => ({ ...old, filtering: true }));
      else if (key.return) chooseProject();
      return true;
    }
    if (overlay.kind === "work-preview") {
      if (key.escape) setOverlay({ kind: "work-detail", key: overlay.key, choice: overlay.choice });
      else if (key.pageDown || key.downArrow) setOverlay((current) => current.kind === "work-preview" ? { ...current, offset: Math.min(previewMaxOffset, current.offset + Math.max(1, previewHeight - 1)) } : current);
      else if (key.pageUp || key.upArrow) setOverlay((current) => current.kind === "work-preview" ? { ...current, offset: Math.max(0, current.offset - Math.max(1, previewHeight - 1)) } : current);
      else if ((key.return || input === "r") && previewMatchesSelection) void workHandover(selectedWorkAction.name);
      return true;
    }
    if (overlay.kind === "work-detail") {
      if (key.escape) { setOverlay({ kind: "none" }); return true; }
      if (key.upArrow || input === "k") setOverlay((current) => current.kind === "work-detail" ? { ...current, choice: Math.max(0, current.choice - 1) } : current);
      else if (key.downArrow || input === "j") setOverlay((current) => current.kind === "work-detail" ? { ...current, choice: Math.min((workDetail?.actions.length ?? 1) - 1, current.choice + 1) } : current);
      else if (key.return || input === "p") { if (selectedWorkAction !== undefined) void previewWorkAction(selectedWorkAction.name); }
      else if (input === "r") { if (selectedWorkAction !== undefined) void workHandover(selectedWorkAction.name); }
      else if (input === "o" && workDetail !== null) { const url = workDetail.pull_request?.url ?? workDetail.issue?.url; if (url !== undefined) openLink(url); }
      return true;
    }
    if (overlay.kind === "links") {
      const choice = overlay.chooser;
      const chosen = snapshot?.sessions.find((session) => session.host === choice.host && session.id === choice.id) ?? null;
      const links = chosen === null ? [] : linksOf(chosen);
      const close = (): void => { setOverlay({ kind: choice.returnTo }); };
      if (chosen === null) {
        close();
        bumpStatus("The session of this chooser is no longer listed; no link opened");
        return true;
      }
      const highlighted = Math.max(0, links.findIndex((link) => link.url === choice.url));
      const highlight = (index: number): void => { setOverlay({ kind: "links", chooser: { ...choice, url: links[index]?.url ?? null } }); };
      // A refresh can change the links while the chooser is open; a pick that no longer has its link says so instead of failing silently.
      const missing = (number: number): void => {
        if (links.length === 0) { close(); bumpStatus(`No link ${String(number)} on this session anymore; none are left`); return; }
        bumpStatus(`No link ${String(number)} on this session anymore; choose 1–${String(links.length)}`);
      };
      const openNumbered = (index: number): void => {
        const link = links[index];
        if (link === undefined) { close(); missing(index + 1); return; }
        close();
        openLink(link.url);
      };
      if (key.escape) close();
      else if (key.upArrow || key.downArrow) highlight(Math.max(0, Math.min(links.length - 1, highlighted + (key.downArrow ? 1 : -1))));
      else if (key.return) {
        const link = links.find((item) => item.url === choice.url);
        if (link === undefined) {
          highlight(0);
          bumpStatus(links.length === 0 ? "The chooser has no links left on this session" : "The highlighted link is no longer on this session; choose again");
          return true;
        }
        close();
        openLink(link.url);
      } else if (/^[1-9]$/.test(input)) {
        if (Number(input) <= links.length) openNumbered(Number(input) - 1);
        else missing(Number(input));
      }
      return true;
    }
    if (overlay.kind === "session") {
      if (key.escape) { setOverlay({ kind: "none" }); return true; }
      if (sessionDetail === null) return true;
      if (key.pageDown || key.downArrow) { scrollDetail(overlayOffset + Math.max(1, detailHeight - 1), detailMaxOffset); return true; }
      if (key.pageUp || key.upArrow) { scrollDetail(overlayOffset - Math.max(1, detailHeight - 1), detailMaxOffset); return true; }
      if (input === "o" && sessionAttachable) void openSelected();
      else if (input === "r" && sessionRecoverable) void requestRecovery("resume", sessionDetail, "session");
      else if (input === "f" && sessionMutable && sessionDetail.canFork) void requestRecovery("fork", sessionDetail, "session");
      else if (input === "x" || input === "D") requestConfirm(sessionDetail, input === "x" ? "stop" : "remove", "session");
      else if ((input === "e" || input === "m") && sessionMutable) { setEdit(input === "e" ? sessionDetail.name ?? "" : ""); setOverlay({ kind: input === "e" ? "rename" : "metadata" }); }
      else if (input === "p") restartOutput();
      else if (input === "l") chooseLink(sessionDetail, "session");
      else if (input === "u") void openFolder(sessionDetail);
      else if (input === "g") openBranch(sessionDetail);
      else if (input === "b") void copyValue(sessionDetail.branch ?? "");
      else if (input === "c") void copyValue(sessionDetail.worktreePath ?? sessionDetail.cwd);
      return true;
    }
    if (overlay.kind === "notification") {
      const { record } = overlay;
      if (key.escape) setOverlay({ kind: "none" });
      else if (input === "o" && record.sessionId !== null) void inspectSessionAt(record.host, record.sessionId);
      else if (input === "a" || input === "x") void updateNotification(record, input === "a" ? "ack" : "archive");
      return true;
    }
    if (overlay.kind === "host") { if (key.escape) setOverlay({ kind: "none" }); return true; }
    return false;
  };

  /** Keys that act the same in every view. */
  const globalKeys = (input: string, key: Key): boolean => {
    if (input === "q" || (key.ctrl && input === "c")) { exit(); return true; }
    if (input === "?") { setOverlay({ kind: "help" }); return true; }
    if (["1", "2", "3", "4"].includes(input)) { setView(VIEWS[Number(input) - 1] ?? "Work"); return true; }
    if (key.upArrow || input === "k") { move(-1); return true; }
    if (key.downArrow || input === "j") { move(1); return true; }
    if (input === "r") { setForkUnknown(false); mutationNotice.current = null; void refresh(); return true; }
    return false;
  };

  /** The keys of the view shown. */
  const viewKeys = (input: string, key: Key): void => {
    if (view === "Work") {
      if (input === "m") setWorkFilters((old) => ({ ...old, actor: old.actor === "me" ? "all" : "me" }));
      else if (input === "f") cycleActor();
      else if (input === "P") cycleProject();
      else if (input === "h") toggleStale();
      else if (key.return || input === "a") openRow(selectedWorkIndex);
      else if (input === "n") openForm(false);
      else if (input === "s") setView("Sessions");
    } else if (view === "Sessions") {
      if (key.return) { if (split) void openSelected(); else openRow(selectedSessionIndex); }
      else if (input === "o") void openSelected();
      else if (input === "l" && selectedSession !== null) chooseLink(selectedSession, "none");
      else if (input === "u" && selectedSession !== null) void openFolder(selectedSession);
      else if (input === "g" && selectedSession !== null) openBranch(selectedSession);
      else if (input === "b" && selectedSession !== null) void copyValue(selectedSession.branch ?? "");
      else if (input === "c" && selectedSession !== null) void copyValue(selectedSession.worktreePath ?? selectedSession.cwd);
      else if (input === "x" && selectedSession !== null) requestConfirm(selectedSession, "stop", "none");
      else if (input === "D" && selectedSession !== null) requestConfirm(selectedSession, "remove", "none");
      else if (split && (key.pageDown || key.pageUp)) scrollDetail(panelOffset + (key.pageDown ? 1 : -1) * Math.max(1, detailHeight - 1), panelMaxOffset);
      else if (input === "n") openForm(false);
      else if (input === "a") openForm(true);
      else if (input === "P" && snapshot !== null) openProjectPicker();
    } else if (view === "Hosts") {
      if (key.return) openRow(cursor.Hosts);
    } else {
      if (input === "c") cycleScope();
      else if (input === "m") loadMoreActivity();
      else if (key.return) openRow(cursor.Activity);
    }
  };

  const handleKey = (input: string, key: Key): void => {
    const mouse = parseMouseEvent(input);
    // Input that arrives while an action runs is refused on the status line, so the owner sees why nothing happened.
    if (busy && (mouse !== null || !input.startsWith("[<"))) { setStatus(BUSY_REFUSAL); return; }
    if (mouse !== null) { dispatchMouse(mouse); return; }
    if (input.startsWith("[<")) return;
    // The tiers run in this order; the first one that consumes the key ends the dispatch.
    if (modalKeys(input, key) || tabKeys(input, key) || filterKeys(input, key) || viewEditKeys(input, key) || overlayKeys(input, key) || globalKeys(input, key)) return;
    viewKeys(input, key);
  };

  // Ink passes a chunk of several presses as one input, and pastes on a channel of their own. Key presses and pastes
  // are handled in arrival order, one per committed render, so each reads the state the event before it left.
  // The handler closure of a render is current only for that render.
  const pendingEvents = useRef<PendingEvent[]>([]);
  const [pressTick, setPressTick] = useState(0);
  useEffect(() => {
    const next = pendingEvents.current.shift();
    if (next === undefined) return;
    if (next.kind === "paste") handlePaste(next.text);
    else handleKey(next.press, next.key);
    if (pendingEvents.current.length > 0) setPressTick((old) => old + 1);
  }, [pressTick]);
  useInput((input, key) => {
    for (const press of keyPresses(input)) pendingEvents.current.push({ kind: "key", press, key: press === input ? key : splitKey(press, key) });
    setPressTick((old) => old + 1);
  });

  const footer = overlay.kind === "none" ? editing !== null ? FILTER_FOOTER : stdout.columns < layout.compactColumns ? "Tab views · ↑↓ select · / filter · Enter open · ? help" : view === "Sessions" && split ? SESSIONS_FOOTER : MAIN_FOOTER :
    overlay.kind === "form" || overlay.kind === "assistant" ? stdout.columns < layout.compactColumns ? "Click choice · ↑↓ field · Ctrl+Enter · Esc back" : FORM_FOOTER :
      overlay.kind === "work-detail" ? "↑↓ choose · Enter/click preview · r or Run executes · Esc back" :
        overlay.kind === "links" ? "↑↓ choose · Enter or 1-9 opens · Esc back" : overlay.kind === "projects" ? "↑↓ choose · Enter selects · / filters · Esc back" : overlay.kind === "work-preview" ? "↑↓ scroll plan · Enter or Run executes · Esc back" : "Esc back  ·  click a labeled action";
  const subtitle = stale ? "STALE: last good data; writes disabled" : snapshot?.errors.length ? `${snapshot.errors.length} host/source error(s); affected writes disabled` : null;
  const listInteraction = { onRowClick: clickRow, onWheel: move, width: Math.max(20, stdout.columns - 4) };
  // Each list is drawn from the window it last showed, so the window moves only when the selection leaves it.
  const workStart = listWindowStart(windowStarts.Work, selectedWorkIndex, workRows?.length ?? 0, visibleRows);
  const sessionsStart = listWindowStart(windowStarts.Sessions, selectedSessionIndex, sessions.length, visibleRows);
  const hostsStart = listWindowStart(windowStarts.Hosts, cursor.Hosts, hostRows.length, visibleRows);
  const activityStart = listWindowStart(windowStarts.Activity, cursor.Activity, records.length, visibleRows);
  // The windows drawn become the ones the next render starts from; the state changes only when a window moved.
  useEffect(() => {
    setWindowStarts((old) => old.Work === workStart && old.Sessions === sessionsStart && old.Hosts === hostsStart && old.Activity === activityStart ? old :
      { Work: workStart, Sessions: sessionsStart, Hosts: hostsStart, Activity: activityStart });
  }, [workStart, sessionsStart, hostsStart, activityStart]);

  let content: ReactNode;
  if (overlay.kind === "form" || overlay.kind === "assistant") content = <FormView form={form} options={launchOptions} actions={actions} assistant={overlay.kind === "assistant"} created={created} busy={busy} loading={formLoading}
    onFocus={(focus) => { setForm((old) => ({ ...moveFocus(old, focus), choice: 0 })); }}
    onPickChoice={(index) => {
      const assistant = overlay.kind === "assistant";
      const item = formPick(form, launchOptions, actions, assistant)?.matches[index];
      if (item === undefined) return;
      setForm((old) => ({ ...old, highlight: index }));
      applyPick(form.focus, item, assistant);
    }}
    onScrollChoices={(direction, max) => { setForm((old) => ({ ...old, choice: Math.max(0, Math.min(Math.max(0, max), old.choice + direction)) })); }}
    onFollowHighlight={(start) => { setForm((old) => ({ ...old, choice: start })); }}
    onSubmit={() => { if (created === null) void submitForm(); else void attachCreated(); }}
    onCancel={() => { if (options.mode === "new-session") exit(); else setOverlay({ kind: "none" }); }} />;
  else if (overlay.kind === "session" && sessionDetail !== null) content = <SessionDetail session={sessionDetail} screen={screen} notifications={detailNotifications} links={linksOf(sessionDetail)} noLinks={noLinkReason(sessionDetail, work, originOf(sessionDetail))}
    offset={overlayOffset} height={detailHeight} onWheel={(direction) => { scrollDetail(overlayOffset + direction * Math.max(1, detailHeight - 1), detailMaxOffset); }}
    onOpenLink={(index) => { openLinkNumber(sessionDetail, index + 1); }} />;
  else if (overlay.kind === "links") {
    const { chooser } = overlay;
    const chosen = snapshot?.sessions.find((session) => session.host === chooser.host && session.id === chooser.id) ?? null;
    const chosenLinks = chosen === null ? [] : linksOf(chosen);
    content = <LinkChooser links={chosenLinks} selected={Math.max(0, chosenLinks.findIndex((link) => link.url === chooser.url))} />;
  }
  else if (overlay.kind === "recovery") content = <RecoveryConfirmation action={overlay.request.kind} session={overlay.request.session} />;
  else if (overlay.kind === "confirm" && overlay.returnTo !== "none") content = <Message color="red" text={confirmText(overlay.action, overlay.session)} />;
  else if (overlay.kind === "rename" || overlay.kind === "metadata") content = <Text>{`${overlay.kind === "rename" ? "Name" : "Metadata key=value"}: ${safeText(edit)}_  Enter save  Esc cancel`}</Text>;
  else if (overlay.kind === "host") content = <HostOverlay capabilities={overlay.capabilities} governance={overlay.governance} />;
  else if (overlay.kind === "notification") content = <NotificationOverlay record={overlay.record} />;
  else if (overlay.kind === "work-preview") content = <WorkPreview preview={overlay.preview} width={previewWidth} height={previewHeight} offset={overlay.offset} onWheel={(direction) => { setOverlay((current) => current.kind === "work-preview" ? { ...current, offset: Math.max(0, Math.min(previewMaxOffset, current.offset + direction * Math.max(1, previewHeight - 1))) } : current); }} />;
  else if (overlay.kind === "work-detail") content = workDetail === null ? <Message text="This work item is no longer available. Go back and refresh." /> : <WorkDetailOverlay detail={workDetail} choice={overlay.choice} onPick={(index, name) => { setOverlay({ kind: "work-detail", key: overlay.key, choice: index }); void previewWorkAction(name); }} />;
  else if (overlay.kind === "projects") content = <ProjectPicker choices={pickChoices} selected={overlay.index} search={overlay.search} filtering={overlay.filtering} limit={visibleRows} />;
  else if (overlay.kind === "help") content = <HelpOverlay />;
  else if (view === "Work") content = <WorkView rows={workRows} selected={selectedWorkIndex} start={workStart} limit={visibleRows} filter={`Actor ${workFilters.actor}  Project ${workFilters.project ?? "all"}  Search ${workFilters.text || "none"}  Hide stale ${workFilters.hideStale ? "on" : "off"}${work?.partial ? "  PARTIAL" : ""}`} warning={work?.warning ?? null} searchActive={editing === "Work"} searchText={workFilters.text} {...listInteraction} />;
  else if (view === "Sessions") content = split ? <Box flexDirection="row" width="100%">
    <Box width={listWidth} flexDirection="column"><SessionsView snapshot={snapshot} sessions={sessions} selected={selectedSessionIndex} start={sessionsStart} limit={visibleRows} project={projectFilter} query={queries.Sessions} editing={editing === "Sessions"} {...listInteraction} width={listWidth - 2} /></Box>
    <Box width={stdout.columns - listWidth} flexDirection="column">
      {selectedSession === null ? <Message text="No session is selected." /> : <SessionDetail session={selectedSession} screen={panelScreen} notifications={detailNotifications} links={linksOf(selectedSession)} noLinks={noLinkReason(selectedSession, work, originOf(selectedSession))} offset={panelOffset} height={detailHeight}
        onWheel={(direction) => { scrollDetail(panelOffset + direction * Math.max(1, detailHeight - 1), panelMaxOffset); }} onOpenLink={(index) => { openLinkNumber(selectedSession, index + 1); }} />}
    </Box>
  </Box> : <SessionsView snapshot={snapshot} sessions={sessions} selected={selectedSessionIndex} start={sessionsStart} limit={visibleRows} project={projectFilter} query={queries.Sessions} editing={editing === "Sessions"} {...listInteraction} />;
  else if (view === "Hosts") content = <HostsView hosts={hostRows} selected={cursor.Hosts} start={hostsStart} limit={visibleRows} query={queries.Hosts} editing={editing === "Hosts"} {...listInteraction} />;
  else content = <ActivityView records={records} selected={cursor.Activity} start={activityStart} scope={scope} limit={visibleRows} query={queries.Activity} editing={editing === "Activity"} {...listInteraction} />;

  let toolbar: ReactNode = null;
  if (overlay.kind === "none") {
    if (view === "Work") toolbar = <Box gap={1} flexWrap="wrap">
      {selectedWork !== null && <ActionButton label="Open item" onClick={() => { openRow(selectedWorkIndex); }} primary />}
      <ActionButton label="New session" onClick={() => { openForm(false); }} />
      <ActionButton label={`Actor: ${workFilters.actor}`} onClick={cycleActor} />
      <ActionButton label={`Project: ${shorten(workFilters.project ?? "all", 12)}`} onClick={cycleProject} />
      <ActionButton label="Search /" onClick={() => { setEditing("Work"); }} />
      <ActionButton label={`Stale: ${workFilters.hideStale ? "hide" : "show"}`} onClick={toggleStale} />
      <ActionButton label="Refresh" onClick={() => void refresh()} />
      <ActionButton label="Help ?" onClick={() => { setOverlay({ kind: "help" }); }} />
    </Box>;
    else if (view === "Sessions") toolbar = <Box gap={1} flexWrap="wrap">
      {selectedSession !== null && <ActionButton label="Open session" onClick={() => { openRow(selectedSessionIndex); }} primary />}
      <ActionButton label="New session" onClick={() => { openForm(false); }} />
      <ActionButton label="Assistant" onClick={() => { openForm(true); }} />
      <ActionButton label="Search /" onClick={() => { setEditing("Sessions"); }} />
      <ActionButton label={`Project: ${shorten(projectFilter ?? "all", 12)}`} onClick={() => { if (snapshot !== null) openProjectPicker(); }} />
      <ActionButton label="Refresh" onClick={() => void refresh()} />
      <ActionButton label="Help ?" onClick={() => { setOverlay({ kind: "help" }); }} />
    </Box>;
    else if (view === "Hosts") toolbar = <Box gap={1}>{selectedHost !== null && <ActionButton label="Open host" onClick={() => { openRow(cursor.Hosts); }} primary />}<ActionButton label="Search /" onClick={() => { setEditing("Hosts"); }} /><ActionButton label="Refresh" onClick={() => void refresh()} /></Box>;
    else toolbar = <Box gap={1} flexWrap="wrap">
      <ActionButton label={`Scope: ${scope}`} onClick={cycleScope} />
      <ActionButton label="Search /" onClick={() => { setEditing("Activity"); }} />
      {activity.cursor !== null && <ActionButton label="Load more" onClick={() => { loadMoreActivity(); }} />}
      {selectedRecord !== null && <ActionButton label="Open notification" onClick={() => { openRow(cursor.Activity); }} primary />}
    </Box>;
  } else if (overlay.kind === "work-detail") toolbar = <Box gap={1} flexWrap="wrap">
    {selectedWorkAction !== undefined && <ActionButton label={`Run ${selectedWorkAction.name}`} onClick={() => { void workHandover(selectedWorkAction.name); }} primary />}
    {selectedWorkAction !== undefined && <ActionButton label="Preview plan" onClick={() => { void previewWorkAction(selectedWorkAction.name); }} />}
    {(workDetail?.pull_request?.url ?? workDetail?.issue?.url) !== undefined && <ActionButton label="Open link" onClick={() => { const url = workDetail?.pull_request?.url ?? workDetail?.issue?.url; if (url !== undefined) openLink(url); }} />}
    <ActionButton label="Back" onClick={() => { setOverlay({ kind: "none" }); }} />
  </Box>;
  else if (overlay.kind === "work-preview") toolbar = <Box gap={1} flexWrap="wrap">
    {previewMatchesSelection && <ActionButton label={`Run ${selectedWorkAction.name}`} onClick={() => { void workHandover(selectedWorkAction.name); }} primary />}
    <ActionButton label="Back to item" onClick={() => { setOverlay({ kind: "work-detail", key: overlay.key, choice: overlay.choice }); }} />
  </Box>;
  else if (overlay.kind === "notification") toolbar = <Box gap={1} flexWrap="wrap">
    {overlay.record.sessionId !== null && <ActionButton label="Open session" onClick={() => { if (overlay.record.sessionId !== null) void inspectSessionAt(overlay.record.host, overlay.record.sessionId); }} primary />}
    <ActionButton label="Acknowledge" onClick={() => void updateNotification(overlay.record, "ack")} />
    <ActionButton label="Archive" onClick={() => void updateNotification(overlay.record, "archive")} />
    <ActionButton label="Back" onClick={() => { setOverlay({ kind: "none" }); }} />
  </Box>;
  else if (overlay.kind === "session" && sessionDetail !== null) toolbar = <Box gap={1} flexWrap="wrap">
    {sessionAttachable && <ActionButton label="Attach" onClick={() => void openSelected()} primary />}
    {sessionRecoverable && <ActionButton label="Resume" onClick={() => void requestRecovery("resume", sessionDetail, "session")} />}
    <ActionButton label="Refresh output" onClick={restartOutput} />
    {sessionMutable && sessionDetail.canFork && <ActionButton label="Fork" onClick={() => void requestRecovery("fork", sessionDetail, "session")} />}
    {sessionMutable && <ActionButton label="Rename" onClick={() => { setEdit(sessionDetail.name ?? ""); setOverlay({ kind: "rename" }); }} />}
    {sessionMutable && <ActionButton label="Metadata" onClick={() => { setEdit(""); setOverlay({ kind: "metadata" }); }} />}
    {sessionDetail.branch !== null && <ActionButton label="Copy branch" onClick={() => void copyValue(sessionDetail.branch ?? "")} />}
    <ActionButton label="Copy path" onClick={() => void copyValue(sessionDetail.worktreePath ?? sessionDetail.cwd)} />
    {linksOf(sessionDetail).length === 1 && <ActionButton label="Open link" onClick={() => { chooseLink(sessionDetail, "session"); }} />}
    {sessionDetail.host === "local" && <ActionButton label="Open folder" onClick={() => void openFolder(sessionDetail)} />}
    {sessionMutable && sessionActive && <ActionButton label="Stop" onClick={() => { requestConfirm(sessionDetail, "stop", "session"); }} />}
    {sessionWritable && <ActionButton label="Remove" onClick={() => { requestConfirm(sessionDetail, "remove", "session"); }} />}
    <ActionButton label="Back" onClick={() => { setOverlay({ kind: "none" }); }} />
  </Box>;
  else if (overlay.kind === "recovery") toolbar = <Box gap={1}>
    <ActionButton label={`Confirm ${overlay.request.kind}`} onClick={() => { const { request } = overlay; setOverlay({ kind: request.returnTo }); confirmRecovery(request); }} primary />
    <ActionButton label="Cancel" onClick={() => { setOverlay({ kind: overlay.request.returnTo }); }} />
  </Box>;
  else if (overlay.kind === "confirm") toolbar = <Box gap={1}>
    <ActionButton label={`Confirm ${overlay.action}`} onClick={() => { const { action, session, returnTo } = overlay; setOverlay({ kind: returnTo }); void runSessionAction({ kind: action, host: session.host, sessionId: session.id }, session); }} primary />
    <ActionButton label="Cancel" onClick={() => { setOverlay({ kind: overlay.returnTo }); }} />
  </Box>;
  else if (overlay.kind !== "form" && overlay.kind !== "assistant") toolbar = <Box gap={1}>
    {(overlay.kind === "rename" || overlay.kind === "metadata") && sessionDetail !== null && <ActionButton label="Save" onClick={() => {
      if (overlay.kind === "rename") void runSessionAction({ kind: "rename", host: sessionDetail.host, sessionId: sessionDetail.id, name: nullable(edit) });
      else { const separator = edit.indexOf("="); if (separator < 1) bumpStatus("Metadata needs key=value"); else void runSessionAction({ kind: "metadata", host: sessionDetail.host, sessionId: sessionDetail.id, set: { [edit.slice(0, separator)]: edit.slice(separator + 1) } }); }
    }} primary />}
    <ActionButton label="Back" onClick={() => { setOverlay({ kind: overlay.kind === "rename" || overlay.kind === "metadata" ? "session" : "none" }); }} />
  </Box>;

  return <ScreenFrame title={options.mode === "new-session" ? "pohunek-work new-session" : "pohunek-work"}
    {...(options.mode === "main" ? { tabs: VIEWS, activeTab: VIEWS.indexOf(view), onTab: (index: number) => { setOverlay({ kind: "none" }); setView(VIEWS[index] ?? "Work"); } } : {})}
    subtitle={subtitle} footer={footer} status={status ?? work?.warning ?? null}>
    {content}
    {overlay.kind === "confirm" && overlay.returnTo === "none" && <Message color="red" text={confirmText(overlay.action, overlay.session)} />}
    {toolbar}
  </ScreenFrame>;
}



export async function runInkTui(options: InkTuiOptions): Promise<number> {
  let exitCode = 0;
  const instance = render(<LayoutProvider value={{ actionCaptureBytes: options.actionCaptureBytes, tabLabels: VIEWS }}><MouseProvider><InkApplication options={options} setExitCode={(code) => { exitCode = code; }} /></MouseProvider></LayoutProvider>, { alternateScreen: true, interactive: true, exitOnCtrlC: false, patchConsole: false });
  try {
    await instance.waitUntilExit();
    return exitCode;
  } catch (error) {
    options.log?.("ink_error", defaultStatus(error));
    return 2;
  } finally {
    instance.unmount();
  }
}
