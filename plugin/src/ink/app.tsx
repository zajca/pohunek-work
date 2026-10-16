import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Box, render, Text, useApp, useInput, usePaste, useStdout, type Key } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createControlClient, type ControlAction, type ControlGovernance, type ControlHost, type ControlHostCapabilities, type ControlNotification, type ControlRuntime, type ControlScreen, type ControlSession, type ControlSnapshot } from "../control/index.ts";
import { createSessionLauncher, type ActionChoice, type LaunchOptions, type LaunchRequest, type CreatedSession } from "../session-launch/index.ts";
import { checkOpenUrl, githubBranchUrl } from "../tui/actions.ts";
import { noLinkReason, sessionLinks, type SessionLink } from "./links.ts";
import type { TuiAttachMode } from "../types/config.ts";
import { staleCutoff } from "../output/stale.ts";
import { ACTOR_FILTERS, filterRows, projectLabels, rowId, type Filters } from "../tui/rows.ts";
import { exec, execInteractive, execInteractiveCapture, type ChildEnd, type InteractiveOutcome } from "../util/exec.ts";
import { handover } from "./handover.ts";
import type { ControlActivityScope } from "../control/types.ts";
import { openAttachWindow } from "../tui/attach-window.ts";
import { ATTACH_HOST, ATTACH_VALUE, renderAttachArgv } from "../tui/attach-template.ts";
import { coalesce } from "./coalesce.ts";
import { loadWork, previewWork, workActionArgv, type WorkSnapshot } from "./work.ts";
import { ActionButton, Message, ScreenFrame, safeText, Section, shorten } from "./components.tsx";
import { MouseProvider, MouseZone, parseMouseEvent, setMouseTracking, useMouseDispatch } from "./mouse.tsx";
import { FILTER_FOOTER, FORM_FOOTER, LayoutProvider, MAIN_FOOTER, SESSIONS_FOOTER, useLayout } from "./layout.tsx";
import { decodeDoEnvelope, type DoOutcome } from "../tui/decode.ts";
import { LiveOutput } from "./live-output.ts";
import { ActivityView, filterSessions, HostsView, hostTerms, LinkChooser, listWindowStart, orderedSessions, ProjectPicker, projectChoices, RecoveryConfirmation, recordTerms, SessionsView, SessionDetail, WorkPreview, WorkView, sessionDetailMaxOffset, sessionGroup, workPreviewMaxOffset, type ActivityScope, type ViewName } from "./views.tsx";
import { formPick, INTENTS, LAST_PICK_FIELD, type PickItem } from "./form-pick.ts";
import { fuzzyFilter, pastedText, typedText } from "../tui/search.ts";
import { keyPresses, splitKey } from "./key-presses.ts";

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
type Overlay = "none" | "links" | "session" | "host" | "notification" | "form" | "assistant" | "confirm" | "recovery" | "rename" | "metadata" | "work-detail" | "work-preview" | "help" | "projects";
/** A resume or fork waiting for the owner to confirm the native conversation it will recover. */
interface RecoveryRequest { readonly kind: "resume" | "fork"; readonly session: ControlSession; readonly returnTo: Overlay }
type ConfirmAction = "stop" | "remove";
/** Status line text for input refused while an action is still running. */
export const BUSY_REFUSAL = "Still working on the last action; input was not applied, try again when it finishes";
const VIEWS: readonly ViewName[] = ["Work", "Sessions", "Hosts", "Activity"];
const SCOPES: readonly ActivityScope[] = ["Recent", "Unread", "Archived"];
const CONTROL_SCOPE: Readonly<Record<ActivityScope, ControlActivityScope>> = { Recent: "recent", Unread: "unread", Archived: "archived" };
const SOURCE_WARNING = /source\(s\) unavailable; mutating actions are paused$/;

interface LaunchForm {
  readonly host: string;
  readonly project: string | null;
  readonly agent: string | null;
  readonly action: string | null;
  readonly name: string;
  readonly prompt: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly intent: "setup" | "project" | "update" | "debug" | "help";
  readonly focus: number;
  /** The query of the focused pick field; it narrows that field's choices. */
  readonly search: string;
  /** Index in the matching choices of the highlighted one, moved by ←/→ and reset by typing. */
  readonly highlight: number;
  /** First choice shown in the choice list. */
  readonly choice: number;
}

const EMPTY_FORM: LaunchForm = { host: "local", project: null, agent: null, action: null, name: "", prompt: "", branch: "", baseBranch: "", intent: "help", focus: 1, search: "", highlight: 0, choice: 0 };

const FORM_FIELDS = 9;
const ASSISTANT_FIELDS = 8;
/** The Assistant form's Request row is disabled, so focus never stops on it. */
const ASSISTANT_DISABLED_FIELD = 4;

/** The field Tab (wrapping) or ↑/↓ (stopping at the first and last field) moves to; the disabled row is skipped. */
function nextField(focus: number, step: 1 | -1, assistant: boolean, wrap: boolean): number {
  const count = assistant ? ASSISTANT_FIELDS : FORM_FIELDS;
  let next = focus + step;
  if (wrap) next = (next + count) % count;
  else if (next < 0 || next >= count) return focus;
  return assistant && next === ASSISTANT_DISABLED_FIELD ? next + step : next;
}

/** Focus moves to another field; the query and highlight belong to the field they were typed in. */
function moveFocus(form: LaunchForm, focus: number): LaunchForm {
  return focus === form.focus ? form : { ...form, focus, search: "", highlight: 0, choice: 0 };
}

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

function defaultStatus(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectedAt<T>(items: readonly T[], index: number): T | null {
  return items[Math.max(0, Math.min(index, items.length - 1))] ?? null;
}

function formFieldLabel(assistant: boolean, index: number): string {
  return assistant ? ["Host", "Project", "Agent", "Intent", "Request", "Branch", "Base branch"][index] ?? "" :
    ["Host", "Project", "Agent", "Action/template", "Name", "Prompt", "Branch", "Base branch"][index] ?? "";
}

function changeTextField(form: LaunchForm, input: string, assistant: boolean, erase: boolean): LaunchForm {
  const field = form.focus === 1 ? "search" : assistant ? form.focus === 5 ? "branch" : form.focus === 6 ? "baseBranch" : null :
    form.focus === 4 ? "name" : form.focus === 5 ? "prompt" : form.focus === 6 ? "branch" : form.focus === 7 ? "baseBranch" : null;
  if (field === null) return form;
  const value = form[field];
  const clean = field === "prompt" ? input : input.replaceAll("\r", " ").replaceAll("\n", " ");
  return { ...form, [field]: erase ? value.slice(0, -1) : value + clean };
}

function FormView({ form, options, actions, assistant, created, busy, loading, onFocus, onPickChoice, onScrollChoices, onFollowHighlight, onSubmit, onCancel }: {
  readonly form: LaunchForm; readonly options: LaunchOptions | null; readonly actions: readonly ActionChoice[]; readonly assistant: boolean;
  readonly created: CreatedSession | null; readonly busy: boolean; readonly loading: boolean;
  readonly onFocus: (index: number) => void;
  readonly onPickChoice: (index: number) => void;
  readonly onScrollChoices: (direction: -1 | 1, max: number) => void;
  /** Moves the choice window to start at this choice; called when the highlight moves, so it stays visible. */
  readonly onFollowHighlight: (start: number) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { stdout } = useStdout();
  const layout = useLayout();
  const compact = stdout.rows < layout.compactRows || stdout.columns < layout.compactColumns;
  const pick = formPick(form, options, actions, assistant);
  const choices = pick?.matches ?? [];
  const highlight = pick?.highlight ?? -1;
  const choiceLimit = compact ? 2 : layout.visibleChoices;
  // The window is where the wheel left it. The highlight pulls it along whenever the highlight, the query or the
  // matches change; a wheel step alone changes none of them and keeps the window where it is.
  const choiceStart = Math.min(form.choice, Math.max(0, choices.length - choiceLimit));
  const matchKey = choices.map((choice) => choice.label).join("\n");
  const followed = useRef({ highlight, search: form.search, matchKey });
  useEffect(() => {
    const last = followed.current;
    if (last.highlight === highlight && last.search === form.search && last.matchKey === matchKey) return;
    followed.current = { highlight, search: form.search, matchKey };
    onFollowHighlight(listWindowStart(form.choice, highlight, choices.length, choiceLimit));
  }, [choiceLimit, choices.length, form.choice, form.search, highlight, matchKey, onFollowHighlight]);
  const fieldName = formFieldLabel(assistant, form.focus).toLowerCase();
  // The submit row is the field after the last one; the Assistant form has one field fewer.
  const submitFocused = created === null && form.focus === (assistant ? ASSISTANT_FIELDS : FORM_FIELDS) - 1;
  const hostChoices = options?.hosts.map((host) => host.label) ?? [];
  const agentChoices = options?.agents.filter((agent) => !assistant || agent.assistantCapable).map((agent) => agent.label) ?? [];
  // A pick field shows its query in place of its value while the query is typed.
  const pickValue = (value: string, index: number): string => form.focus === index && form.search !== "" ? `search: ${form.search}` : value;
  const fields = [
    pickValue(options?.hosts.find((host) => host.id === form.host)?.label ?? form.host, 0),
    pickValue(options?.projects.find((project) => project.id === form.project)?.label ?? "none", 1),
    pickValue(options?.agents.find((agent) => agent.id === form.agent)?.label ?? "default", 2),
    pickValue(assistant ? form.intent : actions.find((action) => action.id === form.action)?.label ?? "blank session", 3),
    assistant ? "Free-form request unavailable in core CLI" : form.name,
    assistant ? form.branch : form.prompt,
    assistant ? form.baseBranch : form.branch,
    ...(assistant ? [] : [form.baseBranch]),
  ];
  return <Box flexDirection="column">
    <Text bold color="cyan">{assistant ? "NEW ASSISTANT" : "NEW SESSION"}</Text>
    {created === null && !compact && choices.length === 0 && form.search === "" && <Text dimColor>{loading ? `Loading ${form.host} options…` : "Click a field to edit it. Tab moves to the next field."}</Text>}
    {created !== null && <Message color="green" text={`Created ${created.host}/${created.sessionId}. Creation is locked.`} />}
    {created?.warnings.map((warning, index) => <Message key={index} text={`Launch warning: ${warning}`} />)}
    {created === null && options?.warning !== null && options?.warning !== undefined && <Text color="yellow" wrap="truncate-end">{safeText(options.warning)}</Text>}
    {created === null && fields.map((value, index) => <MouseZone key={index} onClick={assistant && index === ASSISTANT_DISABLED_FIELD ? undefined : () => { onFocus(index); }}>
      <Text color={assistant && index === ASSISTANT_DISABLED_FIELD ? "gray" : form.focus === index ? "cyan" : "white"} bold={form.focus === index} wrap="truncate-end">
        {`${form.focus === index ? "▸" : " "} ${formFieldLabel(assistant, index).padEnd(16)} ${index <= LAST_PICK_FIELD ? "‹ " : ""}${shorten(value || (index <= LAST_PICK_FIELD ? "none" : "(empty)"), 60)}${index <= LAST_PICK_FIELD ? " ›" : form.focus === index ? "_" : ""}`}
      </Text>
    </MouseZone>)}
    {created === null && pick !== null && form.search !== "" && <Text dimColor wrap="truncate-end">{safeText(`Search: ${form.search}  ·  ${String(choices.length)} matches  ·  Enter picks the highlighted one`)}</Text>}
    {created === null && pick !== null && form.search !== "" && choices.length === 0 && <Text color="yellow" wrap="truncate-end">{safeText(`No ${fieldName} matches; Backspace edits the query, Esc clears it`)}</Text>}
    {created === null && choices.length > 0 && <MouseZone flexDirection="column" width="100%" onWheel={(direction) => { onScrollChoices(direction, choices.length - choiceLimit); }}>
      <Text dimColor>{`Choose ${fieldName}${choices.length > choiceLimit && !compact ? ` (${choiceStart + 1}–${Math.min(choiceStart + choiceLimit, choices.length)} / ${choices.length}; wheel for more)` : ""}`}</Text>
      {choices.slice(choiceStart, choiceStart + choiceLimit).map((choice, index) => <MouseZone key={`${choiceStart + index}/${choice.label}`} onClick={() => { onPickChoice(choiceStart + index); }}>
        <Text color={choiceStart + index === highlight ? "cyan" : "white"} bold={choiceStart + index === highlight}>{`${choiceStart + index === highlight ? "▸" : " "} ${choiceStart + index + 1}. ${shorten(choice.label, 65)}`}</Text>
      </MouseZone>)}
    </MouseZone>}
    <Box gap={1}>
      {/* The focused submit row carries the same ▸ marker as the fields, so the focus on it is visible. */}
      <ActionButton label={`${submitFocused ? "▸ " : ""}${created === null ? "Create and attach" : "Attach session"}`} onClick={onSubmit} primary />
      <ActionButton label={created === null ? "Cancel" : "Close"} onClick={onCancel} />
    </Box>
    {created === null && !compact && form.focus === 0 && <Text dimColor wrap="truncate-end">{`Hosts: ${hostChoices.join(", ") || "loading"}`}</Text>}
    {created === null && !compact && form.focus === 2 && <Text dimColor wrap="truncate-end">{`Agents: ${agentChoices.join(", ") || "loading"}`}</Text>}
    {created === null && !compact && form.focus === 3 && !assistant && <Text dimColor wrap="truncate-end">{`Actions: blank session, ${actions.map((action) => action.label).join(", ")}`}</Text>}
    {!compact && <Text dimColor wrap="truncate-end">{busy ? "Working…" : created === null ? FORM_FOOTER : "Enter retry attach  Esc close"}</Text>}
  </Box>;
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
  const [overlay, setOverlay] = useState<Overlay>(options.mode === "new-session" ? "form" : "none");
  const [snapshot, setSnapshot] = useState<ControlSnapshot | null>(null);
  const [work, setWork] = useState<WorkSnapshot | null>(null);
  const [workFilters, setWorkFilters] = useState<Filters>({ actor: options.initialView === "mine" ? "me" : "all", project: null, text: "", hideStale: false });
  // The view whose `/` filter takes the text keys; Work keeps its query in workFilters.
  const [editing, setEditing] = useState<ViewName | null>(null);
  // A view change by pointer leaves the filter of the view it came from: its text keys must not reach the new view.
  useEffect(() => { setEditing((old) => old === null || old === view ? old : null); }, [view]);
  const [queries, setQueries] = useState<Record<"Sessions" | "Hosts" | "Activity", string>>({ Sessions: "", Hosts: "", Activity: "" });
  const [workKey, setWorkKey] = useState<string | null>(null);
  const [workDetailKey, setWorkDetailKey] = useState<string | null>(null);
  const [workPreview, setWorkPreview] = useState<DoOutcome | string | null>(null);
  const [previewOffset, setPreviewOffset] = useState(0);
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Set when a fork did not answer: its outcome is unknown, so another fork waits for the owner to look at the list.
  const [forkUnknown, setForkUnknown] = useState(false);
  // The message of the last mutation that failed. Snapshots that arrive afterwards keep it on the status line.
  const mutationNotice = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<Record<ViewName, number>>({ Work: 0, Sessions: 0, Hosts: 0, Activity: 0 });
  // The first row each list was last drawn from; a selection inside that window never scrolls it.
  const [windowStarts, setWindowStarts] = useState<Record<ViewName, number>>({ Work: 0, Sessions: 0, Hosts: 0, Activity: 0 });
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [pick, setPick] = useState({ index: 0, search: "", filtering: false });
  const [scope, setScope] = useState<ActivityScope>("Recent");
  // The records of the Activity scope shown, one page at a time; `cursor` is null when the list is complete.
  const [activity, setActivity] = useState<{ scope: ActivityScope; records: readonly ControlNotification[]; cursor: string | null }>({ scope: "Recent", records: [], cursor: null });
  const activityGeneration = useRef(0);
  // The notifications of the session the detail or the panel shows, read by session; `key` says which session they belong to.
  const [sessionNotes, setSessionNotes] = useState<{ key: string; records: readonly ControlNotification[] }>({ key: "", records: [] });
  const [sessionDetail, setSessionDetail] = useState<ControlSession | null>(null);
  const [detailOffset, setDetailOffset] = useState(0);
  const [screen, setScreen] = useState<ControlScreen | null>(null);
  // The panel and the session overlay follow the newest output until the owner scrolls away from its end.
  const [followOutput, setFollowOutput] = useState(true);
  const [liveRound, setLiveRound] = useState(0);
  const [hostDetail, setHostDetail] = useState<ControlHostCapabilities | null>(null);
  const [governance, setGovernance] = useState<ControlGovernance | null>(null);
  const [notificationDetail, setNotificationDetail] = useState<ControlNotification | null>(null);
  const notificationSelectionGeneration = useRef(0);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [confirmSession, setConfirmSession] = useState<ControlSession | null>(null);
  const [confirmReturn, setConfirmReturn] = useState<Overlay>("session");
  const [formLoading, setFormLoading] = useState(false);
  const formLoadingRef = useRef(false);
  const formGeneration = useRef(0);
  const [recovery, setRecovery] = useState<RecoveryRequest | null>(null);
  const [edit, setEdit] = useState("");
  const [form, setForm] = useState<LaunchForm>(EMPTY_FORM);
  const [launchOptions, setLaunchOptions] = useState<LaunchOptions | null>(null);
  const [actions, setActions] = useState<readonly ActionChoice[]>([]);
  const [created, setCreated] = useState<CreatedSession | null>(null);
  const [workChoice, setWorkChoice] = useState(0);
  // The link chooser of `l`: the session, the highlighted line and the overlay it returns to on Esc or a pick.
  // The chooser names its session by host and id and its highlight by URL, so a refresh re-resolves both.
  const [linkChoice, setLinkChoice] = useState<{ host: string; id: string; url: string | null; returnTo: "none" | "session" } | null>(null);
  // Bumped when a mutation completes; a read that started before it must not replace the state the mutation showed.
  const mutationEpoch = useRef(0);
  // Counts the actions that started; a read that completes later checks it before it reports its own result.
  const actionSeq = useRef(0);
  // A status written by a user action; it counts as newer than any refresh read that started before it.
  const bumpStatus = useCallback((message: string | null): void => { actionSeq.current += 1; setStatus(message); }, []);
  const alive = useRef(true);

  useEffect(() => {
    const restore = (): void => { setMouseTracking(false); };
    process.on("exit", restore);
    setMouseTracking(true);
    return () => { process.removeListener("exit", restore); restore(); };
  }, []);

  /** Every inline attach runs through here: the child ends with its session, and a failed attach is reported. */
  const attachInline = useCallback((host: string, id: string, run: (end: ChildEnd) => Promise<InteractiveOutcome>): Promise<void> =>
    handover(run, control, host, id, options.timeoutMs), [control, options.timeoutMs]);

  const suspendForChild = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    setMouseTracking(false);
    // The child shares the foreground group, so Ctrl-C while the terminal is cooked also
    // signals this process; the handler keeps the TUI alive and the child still receives it.
    const ignoreInterrupt = (): void => undefined;
    process.on("SIGINT", ignoreInterrupt);
    let result!: T;
    try {
      await suspendTerminal(async () => { result = await action(); });
      return result;
    }
    finally {
      process.off("SIGINT", ignoreInterrupt);
      if (alive.current) setMouseTracking(true);
    }
  }, [suspendTerminal]);

  const sessions = useMemo(() => snapshot === null ? [] : filterSessions(snapshot, orderedSessions(snapshot, projectFilter), queries.Sessions), [snapshot, projectFilter, queries.Sessions]);
  const pickChoices = useMemo(() => projectChoices(snapshot?.sessions ?? [], pick.search), [snapshot, pick.search]);
  const records = useMemo(() => fuzzyFilter(activity.scope === scope ? activity.records : [], queries.Activity, recordTerms), [activity, scope, queries.Activity]);
  const hostRows = useMemo(() => snapshot === null ? [] : fuzzyFilter(snapshot.hosts, queries.Hosts, hostTerms), [snapshot, queries.Hosts]);
  const workRows = useMemo(() => work?.payload === null || work === null ? null : filterRows(work.payload, workFilters, staleCutoff(Date.now(), options.stalePrDays)), [work, workFilters, options.stalePrDays]);
  const selectedWork = workRows?.find((item) => rowId(item) === workKey) ?? selectedAt(workRows ?? [], cursor.Work);
  const workDetail = work?.payload?.items.find((item) => rowId(item) === workDetailKey) ?? null;
  const originOf = useCallback((session: ControlSession): string | null => snapshot?.projects.find((entry) => entry.host === session.host && entry.id === session.projectId)?.originUrl ?? null, [snapshot]);
  const linksOf = useCallback((session: ControlSession): SessionLink[] => sessionLinks(session, work?.payload?.items ?? null, originOf(session)), [originOf, work]);
  const selectedWorkAction = workDetail?.actions[workChoice];
  const previewMatchesSelection = workPreview !== null && typeof workPreview !== "string" && workPreview.kind === "ok" &&
    workDetail !== null && selectedWorkAction !== undefined && workPreview.key === workDetail.key && workPreview.action === selectedWorkAction.name;
  const selectedWorkIndex = selectedWork === null ? 0 : workRows?.indexOf(selectedWork) ?? 0;
  const selectedSession = sessions.find((session) => `${session.host}/${session.id}` === sessionKey) ?? selectedAt(sessions, cursor.Sessions);
  const split = options.mode === "main" && stdout.columns >= options.detailMinWidth;
  const selectedSessionIndex = selectedSession === null ? 0 : sessions.indexOf(selectedSession);
  const selectedHost = selectedAt(hostRows, cursor.Hosts);
  const selectedRecord = selectedAt(records, cursor.Activity);
  const visibleRows = Math.max(2, Math.floor((stdout.rows - layout.listReservedRows) / 2));
  const detailHeight = Math.max(4, stdout.rows - layout.detailReservedRows);
  // The side panel shows the highlighted session; its screen is kept only for that session.
  const panelScreen = screen !== null && selectedSession !== null && screen.sessionId === selectedSession.id ? screen : null;
  const noteSession = overlay === "session" && sessionDetail !== null ? sessionDetail : selectedSession;
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
  const readActivityPage = useCallback(async (target: ActivityScope, cursor: string | null): Promise<void> => {
    const generation = ++activityGeneration.current;
    const result = await control.activity(CONTROL_SCOPE[target], cursor);
    if (!alive.current || generation !== activityGeneration.current) return;
    // A failed read keeps the records already shown.
    if (!result.ok) { bumpStatus(`Activity read failed: ${result.error.message}`); return; }
    setActivity((previous) => ({
      scope: target,
      records: cursor === null || previous.scope !== target ? result.data.records : [...previous.records, ...result.data.records],
      cursor: result.data.cursor,
    }));
  }, [bumpStatus, control]);
  useEffect(() => {
    if (view !== "Activity") return;
    setActivity({ scope, records: [], cursor: null });
    void readActivityPage(scope, null);
  }, [view, scope, readActivityPage]);
  const loadMoreActivity = useCallback((): void => {
    if (activity.cursor !== null && activity.scope === scope) void readActivityPage(scope, activity.cursor);
  }, [activity, readActivityPage, scope]);

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
  const previewMaxOffset = workPreview === null ? 0 : workPreviewMaxOffset(workPreview, previewWidth, previewHeight);
  const sessionWritable = sessionDetail !== null && !sessionDetail.external && !["conflicting", "incompatible"].includes(sessionDetail.runtimeState ?? "");
  const sessionMutable = sessionWritable && sessionDetail.runtimeState !== "lost";
  const sessionActive = sessionDetail !== null && ["running", "working", "starting", "reconnecting", "blocked"].includes(sessionDetail.state);
  const sessionAttachable = sessionMutable && (sessionActive || sessionDetail.canResume);
  const sessionRecoverable = sessionWritable && sessionDetail.canResume && (!sessionActive || sessionDetail.runtimeState === "lost");

  useEffect(() => { setDetailOffset(0); setFollowOutput(true); }, [sessionKey]);

  // The session shown beside the list or in the overlay is read live; a read for a session the owner has left is dropped.
  const liveSession = overlay === "session" ? sessionDetail : split && view === "Sessions" ? selectedSession : null;
  const liveHost = liveSession?.host ?? null;
  const liveId = liveSession?.id ?? null;
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
    } else {
      setStale(true);
      if (actionSeq.current === started) setStatus(`Control refresh failed: ${defaultStatus(nextControl.reason)}`);
    }
  }), [applySnapshot, control]);

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
    setOverlay(assistant ? "assistant" : "form");
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

  const attachCreated = useCallback(async (): Promise<void> => {
    if (created === null || busy) return;
    actionSeq.current += 1;
    setBusy(true);
    try {
      if (options.attachMode === "window") {
        bumpStatus(await openAttachWindowFor(created.host, created.sessionId));
        if (options.mode === "new-session") options.onWindowOpened?.(`opened ${created.sessionId} in a new window`);
      } else {
        await suspendForChild(() => attachInline(created.host, created.sessionId, (end) => launcher.attachSession(end).then((attached) => attached.outcome)));
      }
      if (options.mode === "new-session") { setExitCode(0); exit(); }
      else { setCreated(null); setOverlay("none"); void refresh(); }
    } catch (error) {
      if (options.mode === "new-session") setExitCode(2);
      bumpStatus(`Session ${created.host}/${created.sessionId} exists; attach failed: ${defaultStatus(error)}`);
    } finally {
      setBusy(false);
    }
  }, [attachInline, busy, created, exit, launcher, openAttachWindowFor, options.attachMode, options.mode, refresh, setExitCode, suspendForChild]);

  const submitForm = useCallback(async (): Promise<void> => {
    if (formLoadingRef.current) { bumpStatus("Host options are still loading; submit when they finish"); return; }
    if (busy || created !== null) return;
    actionSeq.current += 1;
    setBusy(true);
    try {
      const request: LaunchRequest = overlay === "assistant" ? {
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
        if (options.attachMode === "window") {
          bumpStatus(await openAttachWindowFor(result.host, result.sessionId));
          if (options.mode === "new-session") options.onWindowOpened?.(`opened ${result.sessionId} in a new window`);
        } else {
          await suspendForChild(() => attachInline(result.host, result.sessionId, (end) => launcher.attachSession(end).then((attached) => attached.outcome)));
        }
        if (options.mode === "new-session") { setExitCode(0); exit(); }
        else { setCreated(null); setOverlay("none"); void refresh(); }
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
  }, [attachInline, busy, created, exit, form, launcher, options.mode, overlay, refresh, setExitCode, suspendForChild]);

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
      setOverlay("session");
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
      setHostDetail(capabilities.ok ? capabilities.data : null);
      setGovernance(policy.ok ? policy.data : null);
      const failures = [capabilities.ok ? null : capabilities.error.message, policy.ok ? null : policy.error.message].filter((message): message is string => message !== null);
      if (failures.length > 0) bumpStatus(failures.join("; "));
      setOverlay("host");
    } catch (error) { bumpStatus(defaultStatus(error)); }
    finally { setBusy(false); }
  }, [control]);

  const openNotification = useCallback(async (record: ControlNotification): Promise<void> => {
    const generation = ++notificationSelectionGeneration.current;
    setNotificationDetail(record);
    setOverlay("notification");
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
              setNotificationDetail((current) => current?.host === record.host && current.id === record.id ? updated : current);
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
          setNotificationDetail((current) => current !== null && current.host === updated.host && current.id === updated.id ? updated : current);
        }
        bumpStatus(`Notification ${kind === "ack" ? "acknowledged" : "archived"}`);
        await refresh();
        // Closes after the list is read, and only if this notification is still the one open: the owner may have
        // left it and opened another, which has the same overlay name.
        if (notificationSelectionGeneration.current === generation) setOverlay((current) => current === "notification" ? "none" : current);
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
      if (latest.data.external || ["conflicting", "incompatible"].includes(latest.data.runtimeState ?? "")) {
        bumpStatus("This runtime is read-only"); return;
      }
      const outcome = await control.act(action);
      if (!outcome.ok) {
        mutationNotice.current = outcome.error.message;
        bumpStatus(outcome.error.message);
        // The fork's overlay offers Resume on r, so the owner is taken to the list, where r refreshes it.
        if (outcome.error.code === "outcome_unknown" && action.kind === "fork") { setForkUnknown(true); setOverlay("none"); }
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
        setOverlay("none");
        return;
      }
      bumpStatus(`${action.kind} completed`);
      setOverlay("none");
      {
        const resumed = outcome.data.session;
        try {
          if (options.attachMode === "window") {
            bumpStatus(await openAttachWindowFor(resumed.host, resumed.id));
          } else {
            await suspendForChild(() => attachInline(resumed.host, resumed.id, (end) => execInteractive([options.pohunekBin, "attach", "--host", resumed.host, "--", resumed.id], end)));
          }
        } catch (error) { bumpStatus(`Session resumed at ${resumed.host}/${resumed.id}; attach failed: ${defaultStatus(error)}`); }
      }
      void refresh();
    } catch (error) { bumpStatus(defaultStatus(error)); }
    finally { setBusy(false); }
  }, [attachInline, busy, control, openAttachWindowFor, options.attachMode, options.pohunekBin, refresh, sessionDetail, snapshot, stale, suspendForChild]);

  const requestRecovery = useCallback(async (kind: RecoveryRequest["kind"], target: ControlSession, returnTo: Overlay): Promise<void> => {
    if (busy || stale || sessionsUnreadable(snapshot, target.host)) {
      bumpStatus("Session data is stale or unavailable; refresh before recovering it"); return;
    }
    setBusy(true);
    try {
      const latest = await control.inspectSession(target.host, target.id);
      if (!latest.ok) { bumpStatus(latest.error.message); return; }
      if (!sameSession(target, latest.data)) { bumpStatus("Session changed; review the new state before recovering it"); return; }
      if (latest.data.external || ["conflicting", "incompatible"].includes(latest.data.runtimeState ?? "")) { bumpStatus("This runtime is read-only"); return; }
      if (latest.data.nativeTarget.status === "invalid") { bumpStatus(`Recovery target unavailable: ${latest.data.nativeTarget.reason}`); return; }
      if (kind === "fork" ? !latest.data.canFork : !latest.data.canResume) { bumpStatus(`This session cannot be ${kind === "fork" ? "forked" : "resumed"}`); return; }
      setRecovery({ kind, session: latest.data, returnTo });
      setOverlay("recovery");
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
    const target = picked ?? (overlay === "session" ? sessionDetail : selectedSession);
    if (target === null) return;
    if (target.external || ["conflicting", "incompatible", "lost"].includes(target.runtimeState ?? "")) {
      bumpStatus("This session cannot be opened from the TUI"); return;
    }
    if (target.canResume && target.state !== "running") {
      await requestRecovery("resume", target, overlay === "session" ? "session" : "none");
      return;
    }
    setBusy(true);
    try {
      if (options.attachMode === "window") {
        bumpStatus(await openAttachWindowFor(target.host, target.id));
      } else {
        await suspendForChild(() => attachInline(target.host, target.id, (end) => execInteractive([options.pohunekBin, "attach", "--host", target.host, "--", target.id], end)));
      }
      // Not awaited inside the busy window: the work list can take seconds, and input must not wait for it.
      void refresh();
    } catch (error) { bumpStatus(`Attach: ${defaultStatus(error)}`); }
    finally { setBusy(false); }
  }, [attachInline, openAttachWindowFor, options.attachMode, options.pohunekBin, overlay, refresh, requestRecovery, selectedSession, sessionDetail, suspendForChild]);

  const openLink = useCallback((raw: string): void => {
    const checked = checkOpenUrl(raw, options.openUrlHosts);
    if (!checked.ok) { bumpStatus(`Not opened: ${checked.reason}`); return; }
    try {
      const child = Bun.spawn([options.openCommand, checked.href], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
      child.unref();
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
    setLinkChoice({ host: session.host, id: session.id, url: links[0]?.url ?? null, returnTo });
    setOverlay("links");
  }, [linksOf, openLink, originOf, work]);

  // The picker opens on the current project filter with its full list, so a stale search cannot hide that project.
  const openProjectPicker = useCallback((): void => {
    const index = projectChoices(snapshot?.sessions ?? [], "").findIndex((choice) => choice.label === projectFilter);
    setPick({ index: Math.max(0, index), search: "", filtering: false });
    setOverlay("projects");
  }, [projectFilter, snapshot]);

  const openFolder = useCallback(async (session: ControlSession): Promise<void> => {
    if (session.host !== "local") { bumpStatus("Remote paths can be copied but cannot be opened on this host"); return; }
    const path = session.worktreePath ?? session.cwd;
    if (!isAbsolute(path)) { bumpStatus("The session path is not absolute"); return; }
    try {
      if (!(await stat(path)).isDirectory()) { bumpStatus("The session path is not a directory"); return; }
      const child = Bun.spawn([options.openCommand, path], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
      child.unref();
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
      setOverlay("none");
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
      setWorkPreview(preview);
      setPreviewOffset(0);
      setOverlay("work-preview");
    } catch (error) { bumpStatus(`Plan preview: ${defaultStatus(error)}`); }
    finally { setBusy(false); }
  }, [busy, options.listTimeoutMs, options.selfBin, workDetail]);

  /** Asks for a stop or a remove of `target`; the flags are the ones the detail offers. */
  const requestConfirm = useCallback((target: ControlSession, kind: ConfirmAction, returnTo: Overlay): void => {
    const writable = !target.external && !["conflicting", "incompatible"].includes(target.runtimeState ?? "");
    const mutable = writable && target.runtimeState !== "lost";
    const active = ["running", "working", "starting", "reconnecting", "blocked"].includes(target.state);
    if (kind === "stop" ? !(mutable && active) : !writable) { bumpStatus(kind === "stop" ? "Only a live session can be stopped" : "This session cannot be removed"); return; }
    setConfirmSession(target);
    setConfirm(kind);
    setConfirmReturn(returnTo);
    setOverlay("confirm");
  }, []);

  // A confirmation names one target; leaving the confirm overlay by any path (Esc, a view change, a click) drops it,
  // so a later confirmation cannot act on a session the owner has stopped looking at.
  useEffect(() => {
    if (overlay !== "confirm") { setConfirm(null); setConfirmSession(null); }
  }, [overlay]);

  const selectIndex = useCallback((index: number): void => {
    const count = view === "Work" ? workRows?.length ?? 0 : view === "Sessions" ? sessions.length : view === "Hosts" ? hostRows.length : records.length;
    const next = Math.max(0, Math.min(count - 1, index));
    setCursor((old) => ({ ...old, [view]: next }));
    if (view === "Sessions") { const session = sessions[next]; setSessionKey(session === undefined ? null : `${session.host}/${session.id}`); }
    if (view === "Work") { const item = workRows?.[next]; setWorkKey(item === undefined ? null : rowId(item)); }
  }, [records.length, sessions, hostRows.length, view, workRows]);

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
    const count = view === "Work" ? workRows?.length ?? 0 : view === "Sessions" ? sessions.length : view === "Hosts" ? hostRows.length : records.length;
    if (count === 0) return;
    const targetIndex = Math.max(0, Math.min(count - 1, index));
    selectIndex(targetIndex);
    if (view === "Work") {
      const item = workRows?.[targetIndex];
      if (item === undefined) return;
      setWorkDetailKey(rowId(item));
      setWorkChoice(0);
      setOverlay("work-detail");
    } else if (view === "Sessions") {
      const session = sessions[targetIndex];
      if (session !== undefined) void inspectSessionAt(session.host, session.id);
    } else if (view === "Hosts") {
      const host = hostRows[targetIndex];
      if (host !== undefined) void inspectHost(host);
    } else {
      const record = records[targetIndex];
      if (record !== undefined) void openNotification(record);
    }
  }, [hostRows, inspectHost, inspectSessionAt, openNotification, records, selectIndex, sessions, view, workRows]);

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
    const assistant = overlay === "assistant";
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
    if (overlay !== "form" && overlay !== "assistant") return;
    if (created !== null) return;
    const clean = text.replaceAll("\u0000", "");
    const assistant = overlay === "assistant";
    // A pick field takes the paste as its query, like typed text; a text field takes it as text.
    setForm((old) => old.focus <= LAST_PICK_FIELD ? (pastedText(clean) === "" ? old : { ...old, search: old.search + pastedText(clean), highlight: 0 }) : changeTextField(old, clean, assistant, false));
  };
  usePaste((text) => {
    pendingEvents.current.push({ kind: "paste", text });
    setPressTick((old) => old + 1);
  });

  // The refusal on the status line is for the action that was running, so it goes once that action ends.
  useEffect(() => { if (!busy) setStatus((old) => old === BUSY_REFUSAL ? null : old); }, [busy]);

  const handleKey = (input: string, key: Key): void => {
    const mouse = parseMouseEvent(input);
    // Input that arrives while an action runs is refused on the status line, so the owner sees why nothing happened.
    if (busy && (mouse !== null || !input.startsWith("[<"))) { setStatus(BUSY_REFUSAL); return; }
    if (mouse !== null) { dispatchMouse(mouse); return; }
    if (input.startsWith("[<")) return;
    if (overlay === "form" || overlay === "assistant") {
      const assistant = overlay === "assistant";
      const pickField = form.focus <= LAST_PICK_FIELD;
      if (created !== null) { if (key.return) void attachCreated(); else if (key.escape) { if (options.mode === "new-session") exit(); else setOverlay("none"); } return; }
      // Esc first clears the query of a pick field; the next Esc leaves the form.
      if (key.escape) {
        if (form.search !== "") { setForm((old) => ({ ...old, search: "", highlight: 0 })); return; }
        if (options.mode === "new-session") exit(); else setOverlay("none");
        return;
      }
      if (key.ctrl && key.return) { void submitForm(); return; }
      if (key.return && form.focus === (assistant ? 7 : 8)) { void submitForm(); return; }
      if (key.tab) { setForm((old) => moveFocus(old, nextField(old.focus, key.shift ? -1 : 1, assistant, true))); return; }
      if (key.upArrow || key.downArrow) { setForm((old) => moveFocus(old, nextField(old.focus, key.upArrow ? -1 : 1, assistant, false))); return; }
      if (key.leftArrow || key.rightArrow) { changeFormChoice(key.leftArrow ? -1 : 1); return; }
      if (key.return && pickField) {
        if (form.search === "") { setForm((old) => moveFocus(old, nextField(old.focus, 1, assistant, false))); return; }
        const pick = formPick(form, launchOptions, actions, assistant);
        const item = pick?.matches[pick.highlight];
        if (item === undefined) { bumpStatus(`No ${formFieldLabel(assistant, form.focus).toLowerCase()} matches "${form.search}"; Backspace edits the query`); return; }
        applyPick(form.focus, item, assistant);
        setForm((old) => moveFocus(old, nextField(old.focus, 1, assistant, false)));
        return;
      }
      if (key.return && overlay === "form" && form.focus === 5) { setForm((old) => ({ ...old, prompt: old.prompt + "\n" })); return; }
      // The focus is read from the state the update applies to: a click that changed it may not have rendered yet.
      if (key.backspace || key.delete) {
        setForm((old) => old.focus <= LAST_PICK_FIELD ? (old.search === "" ? old : { ...old, search: old.search.slice(0, -1), highlight: 0 }) : changeTextField(old, "", assistant, true));
        return;
      }
      // Control characters are never text: an input without printable characters types nothing.
      if (!key.ctrl && !key.meta && typedText(input) !== "") {
        setForm((old) => old.focus <= LAST_PICK_FIELD ? (typedText(input) === "" ? old : { ...old, search: old.search + input, highlight: 0 }) : changeTextField(old, input, assistant, false));
      }
      return;
    }
    if (overlay === "confirm") {
      if (input.toLowerCase() === "y" && confirm !== null && confirmSession !== null) void runSessionAction({ kind: confirm, host: confirmSession.host, sessionId: confirmSession.id }, confirmSession);
      setOverlay(confirmReturn); setConfirm(null); setConfirmSession(null); return;
    }
    if (overlay === "recovery") {
      const request = recovery;
      setRecovery(null); setOverlay(request?.returnTo ?? "none");
      if (input.toLowerCase() === "y" && request !== null) confirmRecovery(request);
      return;
    }
    if (overlay === "rename" || overlay === "metadata") {
      if (key.escape) { setOverlay("session"); setEdit(""); return; }
      if (key.return && sessionDetail !== null) {
        if (overlay === "rename") void runSessionAction({ kind: "rename", host: sessionDetail.host, sessionId: sessionDetail.id, name: nullable(edit) });
        else {
          const separator = edit.indexOf("=");
          if (separator < 1) bumpStatus("Metadata needs key=value");
          else void runSessionAction({ kind: "metadata", host: sessionDetail.host, sessionId: sessionDetail.id, set: { [edit.slice(0, separator)]: edit.slice(separator + 1) } });
        }
        return;
      }
      if (key.backspace || key.delete) setEdit((old) => old.slice(0, -1));
      else if (!key.ctrl && !key.meta) setEdit((old) => old + input);
      return;
    }
    // Only Tab and Shift-Tab switch views. A list filter that is typed takes Tab for itself, as a text field does.
    const textFocused = editing !== null || (overlay === "projects" && pick.filtering);
    if ((key.tab || input === "\u001b[Z") && !textFocused && overlay !== "help" && options.mode === "main") {
      const backward = key.shift || input === "\u001b[Z";
      const direction = backward ? -1 : 1;
      setOverlay("none");
      // The next view is read from the state the update applies to, so each Tab of a run moves one view further.
      setView((old) => VIEWS[(VIEWS.indexOf(old) + direction + VIEWS.length) % VIEWS.length] ?? "Work");
      return;
    }
    // While a filter is typed every key is text: x, D, 1-4 and the arrows never act on the list.
    if (overlay === "none" && editing !== null) {
      if (key.escape) { editQuery(editing, () => ""); setEditing(null); return; }
      if (key.return) { setEditing(null); return; }
      if (key.tab) return;
      if (key.backspace || key.delete) { editQuery(editing, (old) => old.slice(0, -1)); return; }
      const typed = key.ctrl || key.meta ? "" : typedText(input);
      if (typed !== "") editQuery(editing, (old) => old + typed);
      return;
    }
    if (overlay === "none" && key.escape && queryOf(view) !== "") { editQuery(view, () => ""); return; }
    if (overlay === "none" && input === "/") { setEditing(view); return; }
    if (overlay === "none" && view === "Sessions" && (key.leftArrow || key.rightArrow || input === "[" || input === "]")) {
      jumpSection(key.rightArrow || input === "]" ? 1 : -1);
      return;
    }
    if (overlay === "none" && view === "Activity" && (key.leftArrow || key.rightArrow)) {
      const step = key.rightArrow ? 1 : -1;
      setScope((old) => SCOPES[(SCOPES.indexOf(old) + step + SCOPES.length) % SCOPES.length] ?? "Recent");
      setCursor((old) => ({ ...old, Activity: 0 }));
      return;
    }
    if (overlay === "help") { if (key.escape || input === "?" || input === "q") setOverlay("none"); return; }
    if (overlay === "projects") {
      const chooseProject = (): void => {
        const choice = pickChoices[pick.index];
        if (choice !== undefined) { setProjectFilter(choice.label); setCursor((old) => ({ ...old, Sessions: 0 })); }
        setOverlay("none");
      };
      if (pick.filtering) {
        if (key.escape) setPick((old) => ({ ...old, search: "", index: 0, filtering: false }));
        else if (key.return) chooseProject();
        else if (key.backspace || key.delete) setPick((old) => ({ ...old, search: old.search.slice(0, -1), index: 0 }));
        else if (input !== "" && !key.ctrl && !key.meta && !key.tab) setPick((old) => ({ ...old, search: old.search + input, index: 0 }));
        return;
      }
      if (key.escape) setOverlay("none");
      else if (key.upArrow) setPick((old) => ({ ...old, index: Math.max(0, old.index - 1) }));
      else if (key.downArrow) setPick((old) => ({ ...old, index: Math.min(pickChoices.length - 1, old.index + 1) }));
      else if (input === "/") setPick((old) => ({ ...old, filtering: true }));
      else if (key.return) chooseProject();
      return;
    }
    if (overlay === "work-preview") {
      if (key.escape) setOverlay("work-detail");
      else if (key.pageDown || key.downArrow) setPreviewOffset((old) => Math.min(previewMaxOffset, old + Math.max(1, previewHeight - 1)));
      else if (key.pageUp || key.upArrow) setPreviewOffset((old) => Math.max(0, old - Math.max(1, previewHeight - 1)));
      else if ((key.return || input === "r") && previewMatchesSelection) void workHandover(selectedWorkAction.name);
      return;
    }
    if (overlay === "work-detail") {
      if (key.escape) { setOverlay("none"); return; }
      if (key.upArrow || input === "k") setWorkChoice((old) => Math.max(0, old - 1));
      else if (key.downArrow || input === "j") setWorkChoice((old) => Math.min((workDetail?.actions.length ?? 1) - 1, old + 1));
      else if (key.return || input === "p") { const action = workDetail?.actions[workChoice]; if (action !== undefined) void previewWorkAction(action.name); }
      else if (input === "r") { const action = workDetail?.actions[workChoice]; if (action !== undefined) void workHandover(action.name); }
      else if (input === "o" && workDetail !== null) { const url = workDetail.pull_request?.url ?? workDetail.issue?.url; if (url !== undefined) openLink(url); }
      return;
    }
    if (overlay === "links") {
      const choice = linkChoice;
      if (choice === null) { setOverlay("none"); return; }
      const chosen = snapshot?.sessions.find((session) => session.host === choice.host && session.id === choice.id) ?? null;
      const links = chosen === null ? [] : linksOf(chosen);
      const close = (): void => { setLinkChoice(null); setOverlay(choice.returnTo); };
      if (chosen === null) {
        close();
        bumpStatus("The session of this chooser is no longer listed; no link opened");
        return;
      }
      const highlighted = Math.max(0, links.findIndex((link) => link.url === choice.url));
      const highlight = (index: number): void => { setLinkChoice({ ...choice, url: links[index]?.url ?? null }); };
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
          return;
        }
        close();
        openLink(link.url);
      } else if (/^[1-9]$/.test(input)) {
        if (Number(input) <= links.length) openNumbered(Number(input) - 1);
        else missing(Number(input));
      }
      return;
    }
    if (overlay === "session") {
      if (key.escape) { setOverlay("none"); return; }
      if (sessionDetail === null) return;
      if (key.pageDown || key.downArrow) { scrollDetail(overlayOffset + Math.max(1, detailHeight - 1), detailMaxOffset); return; }
      if (key.pageUp || key.upArrow) { scrollDetail(overlayOffset - Math.max(1, detailHeight - 1), detailMaxOffset); return; }
      if (input === "o" && sessionAttachable) void openSelected();
      else if (input === "r" && sessionRecoverable) void requestRecovery("resume", sessionDetail, "session");
      else if (input === "f" && sessionMutable && sessionDetail.canFork) void requestRecovery("fork", sessionDetail, "session");
      else if (input === "x" || input === "D") requestConfirm(sessionDetail, input === "x" ? "stop" : "remove", "session");
      else if ((input === "e" || input === "m") && sessionMutable) { setEdit(input === "e" ? sessionDetail.name ?? "" : ""); setOverlay(input === "e" ? "rename" : "metadata"); }
      else if (input === "p") restartOutput();
      else if (input === "l") chooseLink(sessionDetail, "session");
      else if (input === "u") void openFolder(sessionDetail);
      else if (input === "g") openBranch(sessionDetail);
      else if (input === "b") void copyValue(sessionDetail.branch ?? "");
      else if (input === "c") void copyValue(sessionDetail.worktreePath ?? sessionDetail.cwd);
      return;
    }
    if (overlay === "notification") {
      if (key.escape) setOverlay("none");
      else if (notificationDetail !== null && input === "o" && notificationDetail.sessionId !== null) void inspectSessionAt(notificationDetail.host, notificationDetail.sessionId);
      else if (notificationDetail !== null && (input === "a" || input === "x")) void updateNotification(notificationDetail, input === "a" ? "ack" : "archive");
      return;
    }
    if (overlay === "host") { if (key.escape) setOverlay("none"); return; }
    if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }
    if (input === "?") { setOverlay("help"); return; }
    if (["1", "2", "3", "4"].includes(input)) { setView(VIEWS[Number(input) - 1] ?? "Work"); return; }
    if (key.upArrow || input === "k") { move(-1); return; }
    if (key.downArrow || input === "j") { move(1); return; }
    if (input === "r") { setForkUnknown(false); mutationNotice.current = null; void refresh(); return; }
    if (view === "Work") {
      if (input === "m") setWorkFilters((old) => ({ ...old, actor: old.actor === "me" ? "all" : "me" }));
      else if (input === "f") setWorkFilters((old) => ({ ...old, actor: ACTOR_FILTERS[(ACTOR_FILTERS.indexOf(old.actor) + 1) % ACTOR_FILTERS.length] ?? "all" }));
      else if (input === "P" && work?.payload !== null && work !== null) {
        const projects = projectLabels(work.payload);
        const index = projects.indexOf(workFilters.project ?? "");
        setWorkFilters((old) => ({ ...old, project: projects[index + 1] ?? null }));
      }
      else if (input === "h") setWorkFilters((old) => ({ ...old, hideStale: !old.hideStale }));
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
      if (input === "c") { setScope((old) => SCOPES[(SCOPES.indexOf(old) + 1) % SCOPES.length] ?? "Recent"); setCursor((old) => ({ ...old, Activity: 0 })); }
      else if (input === "m") loadMoreActivity();
      else if (key.return) openRow(cursor.Activity);
    }
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

  const footer = overlay === "none" ? editing !== null ? FILTER_FOOTER : stdout.columns < layout.compactColumns ? "Tab views · ↑↓ select · / filter · Enter open · ? help" : view === "Sessions" && split ? SESSIONS_FOOTER : MAIN_FOOTER :
    overlay === "form" || overlay === "assistant" ? stdout.columns < layout.compactColumns ? "Click choice · ↑↓ field · Ctrl+Enter · Esc back" : FORM_FOOTER :
      overlay === "work-detail" ? "↑↓ choose · Enter/click preview · r or Run executes · Esc back" :
        overlay === "links" ? "↑↓ choose · Enter or 1-9 opens · Esc back" : overlay === "projects" ? "↑↓ choose · Enter selects · / filters · Esc back" : overlay === "work-preview" ? "↑↓ scroll plan · Enter or Run executes · Esc back" : "Esc back  ·  click a labeled action";
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
  if (overlay === "form" || overlay === "assistant") content = <FormView form={form} options={launchOptions} actions={actions} assistant={overlay === "assistant"} created={created} busy={busy} loading={formLoading}
    onFocus={(focus) => { setForm((old) => ({ ...moveFocus(old, focus), choice: 0 })); }}
    onPickChoice={(index) => {
      const assistant = overlay === "assistant";
      const item = formPick(form, launchOptions, actions, assistant)?.matches[index];
      if (item === undefined) return;
      setForm((old) => ({ ...old, highlight: index }));
      applyPick(form.focus, item, assistant);
    }}
    onScrollChoices={(direction, max) => { setForm((old) => ({ ...old, choice: Math.max(0, Math.min(Math.max(0, max), old.choice + direction)) })); }}
    onFollowHighlight={(start) => { setForm((old) => ({ ...old, choice: start })); }}
    onSubmit={() => { if (created === null) void submitForm(); else void attachCreated(); }}
    onCancel={() => { if (options.mode === "new-session") exit(); else setOverlay("none"); }} />;
  else if (overlay === "session" && sessionDetail !== null) content = <SessionDetail session={sessionDetail} screen={screen} notifications={detailNotifications} links={linksOf(sessionDetail)} noLinks={noLinkReason(sessionDetail, work, originOf(sessionDetail))}
    offset={overlayOffset} height={detailHeight} onWheel={(direction) => { scrollDetail(overlayOffset + direction * Math.max(1, detailHeight - 1), detailMaxOffset); }}
    onOpenLink={(index) => { openLinkNumber(sessionDetail, index + 1); }} />;
  else if (overlay === "links" && linkChoice !== null) {
    const chosen = snapshot?.sessions.find((session) => session.host === linkChoice.host && session.id === linkChoice.id) ?? null;
    const chosenLinks = chosen === null ? [] : linksOf(chosen);
    content = <LinkChooser links={chosenLinks} selected={Math.max(0, chosenLinks.findIndex((link) => link.url === linkChoice.url))} />;
  }
  else if (overlay === "recovery" && recovery !== null) content = <RecoveryConfirmation action={recovery.kind} session={recovery.session} />;
  else if (overlay === "confirm" && confirmReturn !== "none") content = <Message color="red" text={confirmText(confirm, confirmSession)} />;
  else if (overlay === "rename" || overlay === "metadata") content = <Text>{`${overlay === "rename" ? "Name" : "Metadata key=value"}: ${safeText(edit)}_  Enter save  Esc cancel`}</Text>;
  else if (overlay === "host") content = <Box flexDirection="column">
    <Section title="Host capabilities"><Text>{safeText(hostDetail === null ? "Unavailable" : `Daemon ${hostDetail.daemonVersion}; protocol ${hostDetail.protocolVersion}; agents ${hostDetail.supportedAgents.join(", ")}`)}</Text></Section>
    <Section title="Governance"><Text>{safeText(governance === null ? "Unavailable" : `Host ${governance.hostId}; enrollment ${governance.enrollment?.status ?? "never enrolled"}; owner ${governance.owner?.id ?? "none"}; quarantine ${governance.quarantine ?? "none"}`)}</Text></Section>
  </Box>;
  else if (overlay === "notification" && notificationDetail !== null) content = <Box flexDirection="column">
    <Section title="NOTIFICATION">
      <Text bold wrap="truncate-end">{safeText(notificationDetail.title)}</Text>
      <Text dimColor>{safeText(`${notificationDetail.host} · ${notificationDetail.status} · ${notificationDetail.createdAt}`)}</Text>
      <Text wrap="wrap">{safeText(notificationDetail.body)}</Text>
    </Section>
    <Text dimColor>{notificationDetail.sessionId === null ? "No linked session" : `Linked session: ${safeText(notificationDetail.sessionId)}`}</Text>
  </Box>;
  else if (overlay === "work-preview" && workPreview !== null) content = <WorkPreview preview={workPreview} width={previewWidth} height={previewHeight} offset={previewOffset} onWheel={(direction) => { setPreviewOffset((old) => Math.max(0, Math.min(previewMaxOffset, old + direction * Math.max(1, previewHeight - 1)))); }} />;
  else if (overlay === "work-detail") content = workDetail === null ? <Message text="This work item is no longer available. Go back and refresh." /> : <Box flexDirection="column">
    <Text bold color="cyan">WORK ITEM</Text>
    <Text bold wrap="truncate-end">{safeText(workDetail.issue?.title ?? workDetail.pull_request?.title ?? workDetail.key)}</Text>
    <Text dimColor wrap="truncate-end">{safeText(`${workDetail.project} · ${workDetail.key}`)}</Text>
    <Text>{safeText(`Next: ${workDetail.on_turn.actor} · ${workDetail.on_turn.reason}`)}</Text>
    <Text dimColor>{safeText(`${workDetail.issue === null ? "No issue" : `Issue: ${workDetail.issue.state}`} · ${workDetail.pull_request === null ? "No pull request" : `Pull request: ${workDetail.pull_request.checks} checks`} · ${workDetail.sessions.length} session(s)`)}</Text>
    <Text bold>{workDetail.actions.length === 0 ? "No actions available" : "Choose an action"}</Text>
    {workDetail.actions.map((action, index) => <MouseZone key={action.name} onClick={() => { setWorkChoice(index); void previewWorkAction(action.name); }}>
      <Text color={index === workChoice ? "cyan" : "white"} bold={index === workChoice}>{`${index === workChoice ? "▸" : " "} ${index + 1}. ${safeText(action.name)}`}</Text>
    </MouseZone>)}
    {workDetail.actions.length > 0 && <Text dimColor>Click or Enter previews the selected action; Run executes it</Text>}
  </Box>;
  else if (overlay === "projects") content = <ProjectPicker choices={pickChoices} selected={pick.index} search={pick.search} filtering={pick.filtering} limit={visibleRows} />;
  else if (overlay === "help") content = <Box flexDirection="column"><Text>Every list: ↑/↓ select, a click selects; Enter or a double click opens (Sessions: attaches when its side panel is visible); PgUp/PgDn scroll a detail; Esc returns.</Text><Text>Filter: / fuzzy-filters Work, Sessions, Hosts and Activity; P filters the project picker. While a filter is typed every key is text; Enter keeps it and Esc clears it.</Text><Text>Views: Tab or Shift-Tab cycles Work, Sessions, Hosts and Activity; 1–4 jump to one; ←/→ never switch views. ? help, q quit.</Text><Text>Sessions: ←/→ or [ ] jump between sections; x stops and D removes the highlighted session; l links, g branch on GitHub, u folder, b copy branch, c copy path.</Text><Text>Work: m mine, f actor, P project, h hide stale; choose an action in its detail. Activity: ←/→ or c change the scope.</Text><Text>Forms: ↑/↓ move between fields. In Host, Project, Agent and Action or Intent, typing filters the choices, ←/→ pick a match, Enter picks the highlighted match and moves on, Esc clears the query. Ctrl+Enter creates.</Text></Box>;
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
  if (overlay === "none") {
    if (view === "Work") toolbar = <Box gap={1} flexWrap="wrap">
      {selectedWork !== null && <ActionButton label="Open item" onClick={() => { openRow(selectedWorkIndex); }} primary />}
      <ActionButton label="New session" onClick={() => { openForm(false); }} />
      <ActionButton label={`Actor: ${workFilters.actor}`} onClick={() => { setWorkFilters((old) => ({ ...old, actor: ACTOR_FILTERS[(ACTOR_FILTERS.indexOf(old.actor) + 1) % ACTOR_FILTERS.length] ?? "all" })); }} />
      <ActionButton label={`Project: ${shorten(workFilters.project ?? "all", 12)}`} onClick={() => {
        if (work?.payload === null || work === null) return;
        const projects = projectLabels(work.payload);
        const index = projects.indexOf(workFilters.project ?? "");
        setWorkFilters((old) => ({ ...old, project: projects[index + 1] ?? null }));
      }} />
      <ActionButton label="Search /" onClick={() => { setEditing("Work"); }} />
      <ActionButton label={`Stale: ${workFilters.hideStale ? "hide" : "show"}`} onClick={() => { setWorkFilters((old) => ({ ...old, hideStale: !old.hideStale })); }} />
      <ActionButton label="Refresh" onClick={() => void refresh()} />
      <ActionButton label="Help ?" onClick={() => { setOverlay("help"); }} />
    </Box>;
    else if (view === "Sessions") toolbar = <Box gap={1} flexWrap="wrap">
      {selectedSession !== null && <ActionButton label="Open session" onClick={() => { openRow(selectedSessionIndex); }} primary />}
      <ActionButton label="New session" onClick={() => { openForm(false); }} />
      <ActionButton label="Assistant" onClick={() => { openForm(true); }} />
      <ActionButton label="Search /" onClick={() => { setEditing("Sessions"); }} />
      <ActionButton label={`Project: ${shorten(projectFilter ?? "all", 12)}`} onClick={() => { if (snapshot !== null) openProjectPicker(); }} />
      <ActionButton label="Refresh" onClick={() => void refresh()} />
      <ActionButton label="Help ?" onClick={() => { setOverlay("help"); }} />
    </Box>;
    else if (view === "Hosts") toolbar = <Box gap={1}>{selectedHost !== null && <ActionButton label="Open host" onClick={() => { openRow(cursor.Hosts); }} primary />}<ActionButton label="Search /" onClick={() => { setEditing("Hosts"); }} /><ActionButton label="Refresh" onClick={() => void refresh()} /></Box>;
    else toolbar = <Box gap={1} flexWrap="wrap">
      <ActionButton label={`Scope: ${scope}`} onClick={() => { setScope((old) => SCOPES[(SCOPES.indexOf(old) + 1) % SCOPES.length] ?? "Recent"); setCursor((old) => ({ ...old, Activity: 0 })); }} />
      <ActionButton label="Search /" onClick={() => { setEditing("Activity"); }} />
      {activity.cursor !== null && <ActionButton label="Load more" onClick={() => { loadMoreActivity(); }} />}
      {selectedRecord !== null && <ActionButton label="Open notification" onClick={() => { openRow(cursor.Activity); }} primary />}
    </Box>;
  } else if (overlay === "work-detail") toolbar = <Box gap={1} flexWrap="wrap">
    {selectedWorkAction !== undefined && <ActionButton label={`Run ${selectedWorkAction.name}`} onClick={() => { void workHandover(selectedWorkAction.name); }} primary />}
    {selectedWorkAction !== undefined && <ActionButton label="Preview plan" onClick={() => { void previewWorkAction(selectedWorkAction.name); }} />}
    {(workDetail?.pull_request?.url ?? workDetail?.issue?.url) !== undefined && <ActionButton label="Open link" onClick={() => { const url = workDetail?.pull_request?.url ?? workDetail?.issue?.url; if (url !== undefined) openLink(url); }} />}
    <ActionButton label="Back" onClick={() => { setOverlay("none"); }} />
  </Box>;
  else if (overlay === "work-preview") toolbar = <Box gap={1} flexWrap="wrap">
    {previewMatchesSelection && <ActionButton label={`Run ${selectedWorkAction.name}`} onClick={() => { void workHandover(selectedWorkAction.name); }} primary />}
    <ActionButton label="Back to item" onClick={() => { setOverlay("work-detail"); }} />
  </Box>;
  else if (overlay === "notification" && notificationDetail !== null) toolbar = <Box gap={1} flexWrap="wrap">
    {notificationDetail.sessionId !== null && <ActionButton label="Open session" onClick={() => { if (notificationDetail.sessionId !== null) void inspectSessionAt(notificationDetail.host, notificationDetail.sessionId); }} primary />}
    <ActionButton label="Acknowledge" onClick={() => void updateNotification(notificationDetail, "ack")} />
    <ActionButton label="Archive" onClick={() => void updateNotification(notificationDetail, "archive")} />
    <ActionButton label="Back" onClick={() => { setOverlay("none"); }} />
  </Box>;
  else if (overlay === "session" && sessionDetail !== null) toolbar = <Box gap={1} flexWrap="wrap">
    {sessionAttachable && <ActionButton label="Attach" onClick={() => void openSelected()} primary />}
    {sessionRecoverable && <ActionButton label="Resume" onClick={() => void requestRecovery("resume", sessionDetail, "session")} />}
    <ActionButton label="Refresh output" onClick={restartOutput} />
    {sessionMutable && sessionDetail.canFork && <ActionButton label="Fork" onClick={() => void requestRecovery("fork", sessionDetail, "session")} />}
    {sessionMutable && <ActionButton label="Rename" onClick={() => { setEdit(sessionDetail.name ?? ""); setOverlay("rename"); }} />}
    {sessionMutable && <ActionButton label="Metadata" onClick={() => { setEdit(""); setOverlay("metadata"); }} />}
    {sessionDetail.branch !== null && <ActionButton label="Copy branch" onClick={() => void copyValue(sessionDetail.branch ?? "")} />}
    <ActionButton label="Copy path" onClick={() => void copyValue(sessionDetail.worktreePath ?? sessionDetail.cwd)} />
    {linksOf(sessionDetail).length === 1 && <ActionButton label="Open link" onClick={() => { chooseLink(sessionDetail, "session"); }} />}
    {sessionDetail.host === "local" && <ActionButton label="Open folder" onClick={() => void openFolder(sessionDetail)} />}
    {sessionMutable && sessionActive && <ActionButton label="Stop" onClick={() => { requestConfirm(sessionDetail, "stop", "session"); }} />}
    {sessionWritable && <ActionButton label="Remove" onClick={() => { requestConfirm(sessionDetail, "remove", "session"); }} />}
    <ActionButton label="Back" onClick={() => { setOverlay("none"); }} />
  </Box>;
  else if (overlay === "recovery" && recovery !== null) toolbar = <Box gap={1}>
    <ActionButton label={`Confirm ${recovery.kind}`} onClick={() => { const request = recovery; setRecovery(null); setOverlay(request.returnTo); confirmRecovery(request); }} primary />
    <ActionButton label="Cancel" onClick={() => { const returnTo = recovery.returnTo; setRecovery(null); setOverlay(returnTo); }} />
  </Box>;
  else if (overlay === "confirm") toolbar = <Box gap={1}>
    <ActionButton label={`Confirm ${confirm ?? "action"}`} onClick={() => { const target = confirmSession; const kind = confirm; const returnTo = confirmReturn; setConfirm(null); setConfirmSession(null); setOverlay(returnTo); if (kind !== null && target !== null) void runSessionAction({ kind, host: target.host, sessionId: target.id }, target); }} primary />
    <ActionButton label="Cancel" onClick={() => { const returnTo = confirmReturn; setConfirm(null); setConfirmSession(null); setOverlay(returnTo); }} />
  </Box>;
  else if (overlay !== "form" && overlay !== "assistant") toolbar = <Box gap={1}>
    {(overlay === "rename" || overlay === "metadata") && sessionDetail !== null && <ActionButton label="Save" onClick={() => {
      if (overlay === "rename") void runSessionAction({ kind: "rename", host: sessionDetail.host, sessionId: sessionDetail.id, name: nullable(edit) });
      else { const separator = edit.indexOf("="); if (separator < 1) bumpStatus("Metadata needs key=value"); else void runSessionAction({ kind: "metadata", host: sessionDetail.host, sessionId: sessionDetail.id, set: { [edit.slice(0, separator)]: edit.slice(separator + 1) } }); }
    }} primary />}
    <ActionButton label="Back" onClick={() => { setOverlay(overlay === "rename" || overlay === "metadata" ? "session" : "none"); }} />
  </Box>;

  return <ScreenFrame title={options.mode === "new-session" ? "pohunek-work new-session" : "pohunek-work"}
    {...(options.mode === "main" ? { tabs: VIEWS, activeTab: VIEWS.indexOf(view), onTab: (index: number) => { setOverlay("none"); setView(VIEWS[index] ?? "Work"); } } : {})}
    subtitle={subtitle} footer={footer} status={status ?? work?.warning ?? null}>
    {content}
    {overlay === "confirm" && confirmReturn === "none" && <Message color="red" text={confirmText(confirm, confirmSession)} />}
    {toolbar}
  </ScreenFrame>;
}

/** The confirmation line for a stop or a remove; a remove names the worktree it may delete. */
function confirmText(kind: ConfirmAction | null, session: ControlSession | null): string {
  const name = session === null ? "session" : session.name ?? session.id;
  return kind === "remove" ? `Confirm remove of ${name}? y/N. Removal may delete its worktree.` : `Confirm ${kind ?? "action"} of ${name}? y/N`;
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
