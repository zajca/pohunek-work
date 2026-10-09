import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Box, render, Text, useApp, useInput, usePaste, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createControlClient, type ControlAction, type ControlGovernance, type ControlHostCapabilities, type ControlNotification, type ControlScreen, type ControlSession, type ControlSnapshot } from "../control/index.ts";
import { createSessionLauncher, type ActionChoice, type LaunchOptions, type LaunchRequest, type CreatedSession } from "../session-launch/index.ts";
import { checkOpenUrl } from "../tui/actions.ts";
import { staleCutoff } from "../output/stale.ts";
import { ACTOR_FILTERS, filterRows, projectLabels, rowId, type Filters } from "../tui/rows.ts";
import { exec, execInteractive, execInteractiveCapture } from "../util/exec.ts";
import { loadWork, previewWork, workActionArgv, type WorkSnapshot } from "./work.ts";
import { ActionButton, Message, ScreenFrame, safeText, Section, shorten } from "./components.tsx";
import { MouseProvider, MouseZone, parseMouseEvent, setMouseTracking, useMouseDispatch } from "./mouse.tsx";
import { layout } from "./config.ts";
import { decodeDoEnvelope } from "../tui/decode.ts";
import { ActivityView, HostsView, orderedSessions, SessionsView, SessionDetail, WorkView, activityRecords, type ActivityScope, type ViewName } from "./views.tsx";

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
  readonly initialView: "mine" | "all";
  readonly stalePrDays: number;
  readonly openUrlHosts: readonly string[];
  readonly openCommand: string;
  readonly clipboardCommand?: string;
  readonly onSnapshot?: (snapshot: ControlSnapshot) => void;
  readonly log?: (event: string, detail?: string) => void;
}

type Overlay = "none" | "session" | "host" | "notification" | "form" | "assistant" | "confirm" | "rename" | "metadata" | "work-actions" | "help";
type ConfirmAction = "stop" | "remove";
const VIEWS: readonly ViewName[] = ["Work", "Sessions", "Hosts", "Activity"];
const SCOPES: readonly ActivityScope[] = ["Recent", "Unread", "Archived"];

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
  readonly search: string;
  readonly choice: number;
}

const EMPTY_FORM: LaunchForm = { host: "local", project: null, agent: null, action: null, name: "", prompt: "", branch: "", baseBranch: "", intent: "help", focus: 1, search: "", choice: 0 };

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function sameSession(a: ControlSession, b: ControlSession): boolean {
  return a.host === b.host && a.id === b.id && a.state === b.state && a.runtimeState === b.runtimeState && a.updatedAt === b.updatedAt;
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

function sessionLinkUrl(session: ControlSession): string | null {
  const metadata = session.metadata;
  return metadata["work.link.id"] !== undefined ? metadata["work.link.url"] ?? null : metadata["link.url"] ?? null;
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

function FormView({ form, options, actions, assistant, created, busy, onFocus, onChoice, onPickChoice, onScrollChoices, onSubmit, onCancel }: {
  readonly form: LaunchForm; readonly options: LaunchOptions | null; readonly actions: readonly ActionChoice[]; readonly assistant: boolean;
  readonly created: CreatedSession | null; readonly busy: boolean;
  readonly onFocus: (index: number) => void;
  readonly onChoice: (direction: -1 | 1) => void;
  readonly onPickChoice: (index: number) => void;
  readonly onScrollChoices: (direction: -1 | 1, max: number) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { stdout } = useStdout();
  const compact = stdout.rows < layout.compactRows || stdout.columns < layout.compactColumns;
  const hostChoices = options?.hosts.map((host) => host.label) ?? [];
  const projectChoices = options?.projects.filter((project) => `${project.id} ${project.label}`.toLowerCase().includes(form.search.toLowerCase())).map((project) => project.label) ?? [];
  const agentChoices = options?.agents.filter((agent) => !assistant || agent.assistantCapable).map((agent) => agent.label) ?? [];
  const choices = form.focus === 0 ? hostChoices : form.focus === 1 ? projectChoices : form.focus === 2 ? ["default", ...agentChoices] :
    form.focus === 3 ? assistant ? ["help", "setup", "project", "update", "debug"] : ["blank session", ...actions.map((action) => action.label)] : [];
  const choiceStart = Math.min(form.choice, Math.max(0, choices.length - layout.visibleChoices));
  const fields = [
    hostChoices.find((_, index) => options?.hosts[index]?.id === form.host) ?? form.host,
    options?.projects.find((project) => project.id === form.project)?.label ?? "none",
    options?.agents.find((agent) => agent.id === form.agent)?.label ?? "default",
    assistant ? form.intent : actions.find((action) => action.id === form.action)?.label ?? "blank session",
    assistant ? "Free-form request unavailable in core CLI" : form.name,
    assistant ? form.branch : form.prompt,
    assistant ? form.baseBranch : form.branch,
    ...(assistant ? [] : [form.baseBranch]),
  ];
  return <Box flexDirection="column">
    <Text bold color="cyan">{assistant ? "NEW ASSISTANT" : "NEW SESSION"}</Text>
    {created === null && !compact && choices.length === 0 && <Text dimColor>Click a field to edit it. Click a selected choice again to cycle options.</Text>}
    {created !== null && <Message color="green" text={`Created ${created.host}/${created.sessionId}. Creation is locked.`} />}
    {created?.warnings.map((warning, index) => <Message key={index} text={`Launch warning: ${warning}`} />)}
    {created === null && options?.warning !== null && options?.warning !== undefined && <Text color="yellow" wrap="truncate-end">{safeText(options.warning)}</Text>}
    {created === null && fields.map((value, index) => <MouseZone key={index} onClick={assistant && index === 4 ? undefined : () => { if (form.focus === index && index <= 3) onChoice(1); else onFocus(index); }}>
      <Text color={assistant && index === 4 ? "gray" : form.focus === index ? "cyan" : "white"} bold={form.focus === index} wrap="truncate-end">
        {`${form.focus === index ? "▸" : " "} ${formFieldLabel(assistant, index).padEnd(16)} ${index <= 3 ? "‹ " : ""}${shorten(value || (index <= 3 ? "none" : "(empty)"), 60)}${index <= 3 ? " ›" : form.focus === index ? "_" : ""}`}
      </Text>
    </MouseZone>)}
    {!compact && created === null && choices.length > 0 && <MouseZone flexDirection="column" width="100%" onWheel={(direction) => { onScrollChoices(direction, choices.length - layout.visibleChoices); }}>
      <Text dimColor>{`Choose ${formFieldLabel(assistant, form.focus).toLowerCase()}${choices.length > layout.visibleChoices ? ` (${choiceStart + 1}–${Math.min(choiceStart + layout.visibleChoices, choices.length)} / ${choices.length}; wheel for more)` : ""}`}</Text>
      {choices.slice(choiceStart, choiceStart + layout.visibleChoices).map((choice, index) => <MouseZone key={`${choiceStart + index}/${choice}`} onClick={() => { onPickChoice(choiceStart + index); }}>
        <Text color="cyan">{`  ${choiceStart + index + 1}. ${shorten(choice, 65)}`}</Text>
      </MouseZone>)}
    </MouseZone>}
    <Box gap={1}>
      <ActionButton label={created === null ? "Create and attach" : "Attach session"} onClick={onSubmit} primary />
      <ActionButton label={created === null ? "Cancel" : "Close"} onClick={onCancel} />
    </Box>
    {created === null && form.focus === 1 && form.search !== "" && <Text dimColor wrap="truncate-end">{`Search: ${safeText(form.search)} (${projectChoices.length} matches)`}</Text>}
    {created === null && !compact && form.focus === 0 && <Text dimColor wrap="truncate-end">{`Hosts: ${hostChoices.join(", ") || "loading"}`}</Text>}
    {created === null && !compact && form.focus === 2 && <Text dimColor wrap="truncate-end">{`Agents: ${agentChoices.join(", ") || "loading"}`}</Text>}
    {created === null && !compact && form.focus === 3 && !assistant && <Text dimColor wrap="truncate-end">{`Actions: blank session, ${actions.map((action) => action.label).join(", ")}`}</Text>}
    <Text dimColor wrap="truncate-end">{busy ? "Working…" : created === null ? "Tab field  ←/→ choice  Ctrl+Enter create  Esc cancel" : "Enter retry attach  Esc close"}</Text>
  </Box>;
}

function InkApplication({ options, setExitCode }: { readonly options: InkTuiOptions; readonly setExitCode: (code: number) => void }): ReactNode {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const dispatchMouse = useMouseDispatch();
  const control = useMemo(() => createControlClient({ binary: options.pohunekBin, timeoutMs: options.timeoutMs, notificationsPageSize: options.notificationsPageSize }), [options.pohunekBin, options.timeoutMs, options.notificationsPageSize]);
  const newLauncher = useCallback(() => createSessionLauncher({ bin: options.pohunekBin, queryTimeoutMs: options.timeoutMs, launchTimeoutMs: options.launchTimeoutMs, launchKillMarginMs: options.launchKillMarginMs }), [options.pohunekBin, options.timeoutMs, options.launchTimeoutMs, options.launchKillMarginMs]);
  const [launcher, setLauncher] = useState(newLauncher);
  const [view, setView] = useState<ViewName>("Work");
  const [overlay, setOverlay] = useState<Overlay>(options.mode === "new-session" ? "form" : "none");
  const [snapshot, setSnapshot] = useState<ControlSnapshot | null>(null);
  const [work, setWork] = useState<WorkSnapshot | null>(null);
  const [workFilters, setWorkFilters] = useState<Filters>({ actor: options.initialView === "mine" ? "me" : "all", project: null, text: "", hideStale: false });
  const [workSearch, setWorkSearch] = useState(false);
  const [workKey, setWorkKey] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<Record<ViewName, number>>({ Work: 0, Sessions: 0, Hosts: 0, Activity: 0 });
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [scope, setScope] = useState<ActivityScope>("Recent");
  const [sessionDetail, setSessionDetail] = useState<ControlSession | null>(null);
  const [detailOffset, setDetailOffset] = useState(0);
  const [screen, setScreen] = useState<ControlScreen | null>(null);
  const [hostDetail, setHostDetail] = useState<ControlHostCapabilities | null>(null);
  const [governance, setGovernance] = useState<ControlGovernance | null>(null);
  const [notificationDetail, setNotificationDetail] = useState<ControlNotification | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [edit, setEdit] = useState("");
  const [form, setForm] = useState<LaunchForm>(EMPTY_FORM);
  const [launchOptions, setLaunchOptions] = useState<LaunchOptions | null>(null);
  const [actions, setActions] = useState<readonly ActionChoice[]>([]);
  const [created, setCreated] = useState<CreatedSession | null>(null);
  const [workChoice, setWorkChoice] = useState(0);
  const refreshBusy = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    const restore = (): void => { setMouseTracking(false); };
    process.on("exit", restore);
    setMouseTracking(true);
    return () => { process.removeListener("exit", restore); restore(); };
  }, []);

  const suspendForChild = useCallback(async <T,>(action: () => Promise<T>): Promise<T> => {
    setMouseTracking(false);
    let result!: T;
    try {
      await suspendTerminal(async () => { result = await action(); });
      return result;
    }
    finally { if (alive.current) setMouseTracking(true); }
  }, [suspendTerminal]);

  const sessions = useMemo(() => snapshot === null ? [] : orderedSessions(snapshot, projectFilter), [snapshot, projectFilter]);
  const records = useMemo(() => snapshot === null ? [] : activityRecords(snapshot, scope), [snapshot, scope]);
  const workRows = useMemo(() => work?.payload === null || work === null ? null : filterRows(work.payload, workFilters, staleCutoff(Date.now(), options.stalePrDays)), [work, workFilters, options.stalePrDays]);
  const selectedWork = workRows?.find((item) => rowId(item) === workKey) ?? selectedAt(workRows ?? [], cursor.Work);
  const selectedWorkIndex = selectedWork === null ? 0 : workRows?.indexOf(selectedWork) ?? 0;
  const selectedSession = sessions.find((session) => `${session.host}/${session.id}` === sessionKey) ?? selectedAt(sessions, cursor.Sessions);
  const selectedSessionIndex = selectedSession === null ? 0 : sessions.indexOf(selectedSession);
  const selectedHost = selectedAt(snapshot?.hosts ?? [], cursor.Hosts);
  const selectedRecord = selectedAt(records, cursor.Activity);
  const visibleRows = Math.max(2, Math.floor((stdout.rows - layout.listReservedRows) / 2));

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    try {
      const [nextControl, nextWork] = await Promise.allSettled([
        control.refresh(), options.mode === "main" ? loadWork(options.selfBin, options.listTimeoutMs) : Promise.resolve(null),
      ]);
      if (!alive.current) return;
      if (nextControl.status === "fulfilled") {
        setSnapshot((previous) => retainUnavailable(previous, nextControl.value));
        try { options.onSnapshot?.(nextControl.value); }
        catch (error) { options.log?.("snapshot_callback_failed", defaultStatus(error)); }
        setStale(false);
        if (nextControl.value.errors.length > 0) setStatus(`${nextControl.value.errors.length} source(s) unavailable; mutating actions are paused`);
      } else {
        setStale(true);
        setStatus(`Control refresh failed: ${defaultStatus(nextControl.reason)}`);
      }
      if (nextWork.status === "fulfilled" && nextWork.value !== null) {
        const latest = nextWork.value;
        setWork((previous) => latest.payload === null && previous?.payload !== null && previous !== null ?
          { ...previous, partial: true, warning: latest.warning ?? "Work refresh unavailable; showing last good rows" } : latest);
      } else if (nextWork.status === "rejected") {
        const warning = `Work refresh failed: ${defaultStatus(nextWork.reason)}`;
        setWork((previous) => previous === null ? null : { ...previous, partial: true, warning });
        setStatus(warning);
      }
    } finally {
      refreshBusy.current = false;
    }
  }, [control, options.listTimeoutMs, options.mode, options.onSnapshot, options.selfBin]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, options.refreshIntervalMs);
    return () => { alive.current = false; clearInterval(timer); };
  }, [options.refreshIntervalMs, refresh]);

  const loadForm = useCallback(async (host: string, preferredProject: string | null = null, assistant = false): Promise<void> => {
    try {
      const loaded = await launcher.loadOptions(host);
      const project = loaded.projects.find((entry) => entry.id === preferredProject || entry.label === preferredProject)?.id ?? loaded.projects[0]?.id ?? null;
      const eligibleAgents = loaded.agents.filter((agent) => !assistant || agent.assistantCapable);
      setLaunchOptions(loaded);
      setForm((previous) => ({ ...previous, host, project, choice: 0,
        action: previous.host === host ? previous.action : null,
        prompt: previous.host === host ? previous.prompt : "",
        branch: previous.host === host ? previous.branch : "",
        baseBranch: previous.host === host ? previous.baseBranch : "",
        agent: eligibleAgents.find((agent) => agent.id === previous.agent)?.id ?? eligibleAgents[0]?.id ?? null }));
      setActions(project === null ? [] : await launcher.loadActions(host, project));
    } catch (error) {
      setStatus(`Launch options: ${defaultStatus(error)}`);
    }
  }, [launcher]);

  const chooseProject = useCallback(async (project: string): Promise<void> => {
    setForm((old) => ({ ...old, project, action: null, agent: null, prompt: "", branch: "", baseBranch: "", search: "", choice: 0 }));
    setActions([]);
    try { setActions(await launcher.loadActions(form.host, project)); }
    catch (error) { setStatus(`Project actions: ${defaultStatus(error)}`); }
  }, [form.host, launcher]);

  const chooseAction = useCallback(async (action: string | null): Promise<void> => {
    if (action === null || form.project === null) { setForm((old) => ({ ...old, action: null, agent: null, prompt: "", branch: "", baseBranch: "" })); return; }
    setBusy(true);
    try {
      const resolved = await launcher.resolveAction(form.host, form.project, action);
      setForm((old) => ({ ...old, action, agent: resolved.agent, branch: resolved.branch ?? "", baseBranch: resolved.baseBranch ?? "", prompt: resolved.prompt }));
    } catch (error) { setStatus(`Action template: ${defaultStatus(error)}`); }
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

  const attachCreated = useCallback(async (): Promise<void> => {
    if (created === null || busy) return;
    setBusy(true);
    try {
      await suspendForChild(async () => {
        const result = await launcher.attachSession();
        if (result.exitCode !== 0) throw new Error(`attach exited ${String(result.exitCode)}`);
      });
      if (options.mode === "new-session") { setExitCode(0); exit(); }
      else { setCreated(null); setOverlay("none"); await refresh(); }
    } catch (error) {
      if (options.mode === "new-session") setExitCode(2);
      setStatus(`Session ${created.host}/${created.sessionId} exists; attach failed: ${defaultStatus(error)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, created, exit, launcher, options.mode, refresh, setExitCode, suspendForChild]);

  const submitForm = useCallback(async (): Promise<void> => {
    if (busy || created !== null) return;
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
        setStatus(`Created ${result.host}/${result.sessionId} with ${result.warnings.length} warning(s); review before attaching`);
        return;
      }
      setStatus(`Created ${result.host}/${result.sessionId}; attaching…`);
      try {
        await suspendForChild(async () => {
          const attached = await launcher.attachSession();
          if (attached.exitCode !== 0) throw new Error(`attach exited ${String(attached.exitCode)}`);
        });
        if (options.mode === "new-session") { setExitCode(0); exit(); }
        else { setCreated(null); setOverlay("none"); await refresh(); }
      } catch (error) {
        if (options.mode === "new-session") setExitCode(2);
        setStatus(`Session ${result.host}/${result.sessionId} exists; attach failed: ${defaultStatus(error)}`);
      }
    } catch (error) {
      if (options.mode === "new-session") setExitCode(2);
      setStatus(defaultStatus(error));
    } finally {
      setBusy(false);
    }
  }, [busy, created, exit, form, launcher, options.mode, overlay, refresh, setExitCode, suspendForChild]);

  const inspectSessionAt = useCallback(async (host: string, id: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await control.inspectSession(host, id);
      if (!result.ok) { setStatus(result.error.message); return; }
      setSessionDetail(result.data);
      setDetailOffset(0);
      setSessionKey(`${host}/${id}`);
      setView("Sessions");
      setScreen(null);
      setOverlay("session");
    } catch (error) { setStatus(defaultStatus(error)); }
    finally { setBusy(false); }
  }, [control]);

  const inspectSelected = useCallback(async (): Promise<void> => {
    if (selectedSession !== null) await inspectSessionAt(selectedSession.host, selectedSession.id);
  }, [inspectSessionAt, selectedSession]);

  const inspectSelectedHost = useCallback(async (): Promise<void> => {
    if (selectedHost === null) return;
    if (!selectedHost.dialable) { setStatus(`Host ${selectedHost.name} has no dialable identity`); return; }
    setBusy(true);
    try {
      const [capabilities, policy] = await Promise.all([
        control.inspectHost(selectedHost.route), control.inspectGovernance(selectedHost.route),
      ]);
      setHostDetail(capabilities.ok ? capabilities.data : null);
      setGovernance(policy.ok ? policy.data : null);
      const failures = [capabilities.ok ? null : capabilities.error.message, policy.ok ? null : policy.error.message].filter((message): message is string => message !== null);
      if (failures.length > 0) setStatus(failures.join("; "));
      setOverlay("host");
    } catch (error) { setStatus(defaultStatus(error)); }
    finally { setBusy(false); }
  }, [control, selectedHost]);

  const openNotification = useCallback(async (record: ControlNotification): Promise<void> => {
    setNotificationDetail(record);
    setOverlay("notification");
    if (record.status === "unread") {
      if (stale || snapshot?.errors.some((error) => error.host === record.host && error.scope === "notifications")) {
        setStatus("Notification data is stale; it was not marked read");
      } else {
        try {
          const result = await control.act({ kind: "read", host: record.host, notificationId: record.id });
          if (!result.ok) setStatus(`Mark read failed: ${result.error.message}`);
          else await refresh();
        } catch (error) { setStatus(`Mark read failed: ${defaultStatus(error)}`); }
      }
    }
    if (record.sessionId !== null) await inspectSessionAt(record.host, record.sessionId);
  }, [control, inspectSessionAt, refresh, snapshot, stale]);

  const updateNotification = useCallback(async (record: ControlNotification, kind: "ack" | "archive"): Promise<void> => {
    if (stale || snapshot?.errors.some((error) => error.host === record.host && error.scope === "notifications")) {
      setStatus("Notification data is stale; refresh before changing it"); return;
    }
    try {
      const result = await control.act({ kind, host: record.host, notificationId: record.id });
      if (!result.ok) setStatus(`${kind} failed: ${result.error.message}`);
      else await refresh();
    } catch (error) { setStatus(`${kind} failed: ${defaultStatus(error)}`); }
  }, [control, refresh, snapshot, stale]);

  const runSessionAction = useCallback(async (action: ControlAction): Promise<void> => {
    if (sessionDetail === null || busy || stale || snapshot?.errors.some((error) => error.host === sessionDetail.host)) {
      setStatus("Session data is stale or unavailable; refresh before changing it");
      return;
    }
    setBusy(true);
    try {
      const latest = await control.inspectSession(sessionDetail.host, sessionDetail.id);
      if (!latest.ok) { setStatus(latest.error.message); return; }
      if (!sameSession(sessionDetail, latest.data)) { setSessionDetail(latest.data); setStatus("Session changed; review the new state before acting"); return; }
      if (latest.data.external || ["conflicting", "incompatible"].includes(latest.data.runtimeState ?? "")) {
        setStatus("This runtime is read-only"); return;
      }
      const outcome = await control.act(action);
      if (!outcome.ok) { setStatus(outcome.error.message); return; }
      if (outcome.data.kind === "remove" && (!outcome.data.removed || outcome.data.worktreesFailed > 0)) {
        setStatus(`Removal unverified; session ${sessionDetail.host}/${sessionDetail.id} may remain. Inspect before retrying.`);
        await refresh();
        return;
      }
      if (outcome.data.kind === "stop" && !outcome.data.stopped) {
        setStatus(`Stop unverified; inspect session ${sessionDetail.host}/${sessionDetail.id}`);
        await refresh();
        return;
      }
      setStatus(`${action.kind} completed`);
      setOverlay("none");
      if (outcome.data.kind === "resume") {
        const resumed = outcome.data.session;
        try {
          await suspendForChild(async () => {
            const code = await execInteractive([options.pohunekBin, "attach", "--host", resumed.host, "--", resumed.id]);
            if (code !== 0) throw new Error(`attach exited ${String(code)}`);
          });
        } catch (error) { setStatus(`Session resumed at ${resumed.host}/${resumed.id}; attach failed: ${defaultStatus(error)}`); }
      }
      await refresh();
    } catch (error) { setStatus(defaultStatus(error)); }
    finally { setBusy(false); }
  }, [busy, control, options.pohunekBin, refresh, sessionDetail, snapshot, stale, suspendForChild]);

  const openSelected = useCallback(async (): Promise<void> => {
    const target = overlay === "session" ? sessionDetail : selectedSession;
    if (target === null) return;
    setBusy(true);
    try {
      let attachHost = target.host;
      let attachId = target.id;
      if (target.external || ["conflicting", "incompatible", "lost"].includes(target.runtimeState ?? "")) {
        setStatus("This session cannot be opened from the TUI"); return;
      }
      if (target.canResume && target.state !== "running") {
        if (stale || snapshot?.errors.some((error) => error.host === target.host)) { setStatus("Session data is stale; refresh before resuming"); return; }
        const latest = await control.inspectSession(target.host, target.id);
        if (!latest.ok) { setStatus(latest.error.message); return; }
        if (!sameSession(target, latest.data)) { setStatus("Session changed; review the new state before resuming"); return; }
        const resumed = await control.act({ kind: "resume", host: target.host, sessionId: target.id });
        if (!resumed.ok) { setStatus(resumed.error.message); return; }
        if (resumed.data.kind !== "resume") { setStatus("Resume returned an unexpected result; inspect the session before attaching"); return; }
        attachHost = resumed.data.session.host;
        attachId = resumed.data.session.id;
      }
      await suspendForChild(async () => {
        const code = await execInteractive([options.pohunekBin, "attach", "--host", attachHost, "--", attachId]);
        if (code !== 0) throw new Error(`attach exited ${String(code)}`);
      });
      await refresh();
    } catch (error) { setStatus(`Attach: ${defaultStatus(error)}`); }
    finally { setBusy(false); }
  }, [control, options.pohunekBin, overlay, refresh, selectedSession, sessionDetail, snapshot, stale, suspendForChild]);

  const openLink = useCallback((raw: string): void => {
    const checked = checkOpenUrl(raw, options.openUrlHosts);
    if (!checked.ok) { setStatus(checked.reason); return; }
    try {
      const child = Bun.spawn([options.openCommand, checked.href], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
      child.unref();
      setStatus(`Opened ${checked.host}`);
    } catch (error) { setStatus(`Open link: ${defaultStatus(error)}`); }
  }, [options.openCommand, options.openUrlHosts]);

  const openFolder = useCallback(async (session: ControlSession): Promise<void> => {
    if (session.host !== "local") { setStatus("Remote paths can be copied but cannot be opened on this host"); return; }
    const path = session.worktreePath ?? session.cwd;
    if (!isAbsolute(path)) { setStatus("The session path is not absolute"); return; }
    try {
      if (!(await stat(path)).isDirectory()) { setStatus("The session path is not a directory"); return; }
      const child = Bun.spawn([options.openCommand, path], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
      child.unref();
      setStatus("Opened session folder");
    } catch (error) { setStatus(`Open folder: ${defaultStatus(error)}`); }
  }, [options.openCommand]);

  const copyValue = useCallback(async (value: string): Promise<void> => {
    if (options.clipboardCommand === undefined) { setStatus(`Select and copy this value: ${safeText(value)}`); return; }
    try {
      const result = await exec([options.clipboardCommand], { timeoutMs: options.timeoutMs, stdin: value });
      setStatus(result.exitCode === 0 && !result.timedOut ? "Copied to clipboard" : "Clipboard command failed");
    } catch (error) { setStatus(`Clipboard command failed: ${defaultStatus(error)}`); }
  }, [options.clipboardCommand, options.timeoutMs]);

  const workHandover = useCallback(async (action: string): Promise<void> => {
    if (selectedWork === null || busy) return;
    const checked = workActionArgv(options.selfBin, selectedWork.key, action, selectedWork.project);
    if (!checked.ok) { setStatus(checked.reason); return; }
    setBusy(true);
    try {
      let report: string;
      if (action === "attach") {
        const code = await suspendForChild(() => execInteractive(checked.argv));
        report = code === 0 ? "Detached from work session" : `Attach ended with ${code === null ? "a signal" : `exit ${String(code)}`}`;
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
      await refresh();
      setStatus(report);
    } catch (error) { setStatus(`Work action: ${defaultStatus(error)}`); }
    finally { setBusy(false); }
  }, [busy, options.selfBin, refresh, selectedWork, suspendForChild]);

  const selectIndex = useCallback((index: number): void => {
    const count = view === "Work" ? workRows?.length ?? 0 : view === "Sessions" ? sessions.length : view === "Hosts" ? snapshot?.hosts.length ?? 0 : records.length;
    const next = Math.max(0, Math.min(count - 1, index));
    setCursor((old) => ({ ...old, [view]: next }));
    if (view === "Sessions") { const session = sessions[next]; setSessionKey(session === undefined ? null : `${session.host}/${session.id}`); }
    if (view === "Work") { const item = workRows?.[next]; setWorkKey(item === undefined ? null : rowId(item)); }
  }, [records.length, sessions, snapshot?.hosts.length, view, workRows]);

  const move = useCallback((delta: number): void => {
    const current = view === "Sessions" ? selectedSessionIndex : view === "Work" ? selectedWorkIndex : cursor[view];
    selectIndex(current + delta);
  }, [cursor, selectedSessionIndex, selectedWorkIndex, selectIndex, view]);

  const changeFormChoice = useCallback((delta: number): void => {
    if (launchOptions === null) return;
    if (form.focus === 0) {
      const index = launchOptions.hosts.findIndex((host) => host.id === form.host);
      const target = launchOptions.hosts[(index + delta + launchOptions.hosts.length) % launchOptions.hosts.length];
      if (target !== undefined) void loadForm(target.id, form.project, overlay === "assistant");
    } else if (form.focus === 1) {
      const matches = launchOptions.projects.filter((project) => `${project.id} ${project.label}`.toLowerCase().includes(form.search.toLowerCase()));
      const index = matches.findIndex((project) => project.id === form.project);
      const target = matches[(index + delta + matches.length) % matches.length];
      if (target !== undefined) void chooseProject(target.id);
    } else if (form.focus === 2) {
      const matches = launchOptions.agents.filter((agent) => overlay !== "assistant" || agent.assistantCapable);
      const index = matches.findIndex((agent) => agent.id === form.agent);
      const target = matches[(index + delta + matches.length) % matches.length];
      if (target !== undefined) setForm((old) => ({ ...old, agent: target.id }));
    } else if (form.focus === 3 && overlay === "form") {
      const choices = [null, ...actions.map((action) => action.id)];
      const index = choices.indexOf(form.action);
      void chooseAction(choices[(index + delta + choices.length) % choices.length] ?? null);
    } else if (form.focus === 3 && overlay === "assistant") {
      const intents = ["help", "setup", "project", "update", "debug"] as const;
      const index = intents.indexOf(form.intent);
      setForm((old) => ({ ...old, intent: intents[(index + delta + intents.length) % intents.length] ?? "help" }));
    }
  }, [actions, chooseAction, chooseProject, form, launchOptions, loadForm, overlay]);

  usePaste((text) => {
    if (overlay !== "form" && overlay !== "assistant") return;
    if (created !== null || busy) return;
    const clean = text.replaceAll("\u0000", "");
    setForm((old) => changeTextField(old, clean, overlay === "assistant", false));
  });

  useInput((input, key) => {
    const mouse = parseMouseEvent(input);
    if (mouse !== null) { if (!busy) dispatchMouse(mouse); return; }
    if (input.startsWith("[<")) return;
    if (busy) return;
    if (overlay === "form" || overlay === "assistant") {
      if (created !== null) { if (key.return) void attachCreated(); else if (key.escape) { if (options.mode === "new-session") exit(); else setOverlay("none"); } return; }
      if (key.escape) { if (options.mode === "new-session") exit(); else setOverlay("none"); return; }
      if (key.ctrl && key.return) { void submitForm(); return; }
      if (key.return && form.focus === (overlay === "assistant" ? 7 : 8)) { void submitForm(); return; }
      if (key.tab) {
        setForm((old) => {
          const count = overlay === "assistant" ? 8 : 9;
          let next = (old.focus + (key.shift ? count - 1 : 1)) % count;
          if (overlay === "assistant" && next === 4) next = key.shift ? 3 : 5;
          return { ...old, focus: next, search: "", choice: 0 };
        });
        return;
      }
      if (key.leftArrow || key.upArrow) { changeFormChoice(-1); return; }
      if (key.rightArrow || key.downArrow) { changeFormChoice(1); return; }
      if (key.return && form.focus === 1) { setForm((old) => ({ ...old, search: "", focus: 2 })); return; }
      if (key.return && overlay === "form" && form.focus === 5) { setForm((old) => ({ ...old, prompt: old.prompt + "\n" })); return; }
      if (key.backspace || key.delete) { setForm((old) => changeTextField(old, "", overlay === "assistant", true)); return; }
      if (!key.ctrl && !key.meta && input !== "") setForm((old) => changeTextField(old, input, overlay === "assistant", false));
      return;
    }
    if (overlay === "confirm") {
      if (input.toLowerCase() === "y" && confirm !== null && sessionDetail !== null) void runSessionAction({ kind: confirm, host: sessionDetail.host, sessionId: sessionDetail.id });
      setOverlay("session"); setConfirm(null); return;
    }
    if (overlay === "rename" || overlay === "metadata") {
      if (key.escape) { setOverlay("session"); setEdit(""); return; }
      if (key.return && sessionDetail !== null) {
        if (overlay === "rename") void runSessionAction({ kind: "rename", host: sessionDetail.host, sessionId: sessionDetail.id, name: nullable(edit) });
        else {
          const separator = edit.indexOf("=");
          if (separator < 1) setStatus("Metadata needs key=value");
          else void runSessionAction({ kind: "metadata", host: sessionDetail.host, sessionId: sessionDetail.id, set: { [edit.slice(0, separator)]: edit.slice(separator + 1) } });
        }
        return;
      }
      if (key.backspace || key.delete) setEdit((old) => old.slice(0, -1));
      else if (!key.ctrl && !key.meta) setEdit((old) => old + input);
      return;
    }
    if (overlay === "help") { if (key.escape || input === "?" || input === "q") setOverlay("none"); return; }
    if (overlay === "work-actions") {
      if (key.escape) { setOverlay("none"); return; }
      if (key.upArrow || input === "k") setWorkChoice((old) => Math.max(0, old - 1));
      else if (key.downArrow || input === "j") setWorkChoice((old) => Math.min((selectedWork?.actions.length ?? 1) - 1, old + 1));
      else if (key.return) { const action = selectedWork?.actions[workChoice]; if (action !== undefined) void workHandover(action.name); }
      return;
    }
    if (overlay === "session") {
      if (key.escape) { setOverlay("none"); return; }
      if (sessionDetail === null) return;
      if (key.pageDown || key.downArrow) { setDetailOffset((old) => old + layout.detailScrollStep); return; }
      if (key.pageUp || key.upArrow) { setDetailOffset((old) => Math.max(0, old - layout.detailScrollStep)); return; }
      if (input === "o") void openSelected();
      else if (input === "r") void runSessionAction({ kind: "resume", host: sessionDetail.host, sessionId: sessionDetail.id });
      else if (input === "f") void runSessionAction({ kind: "fork", host: sessionDetail.host, sessionId: sessionDetail.id });
      else if (input === "x" || input === "D") { setConfirm(input === "x" ? "stop" : "remove"); setOverlay("confirm"); }
      else if (input === "e" || input === "m") { setEdit(input === "e" ? sessionDetail.name ?? "" : ""); setOverlay(input === "e" ? "rename" : "metadata"); }
      else if (input === "p") void control.screen(sessionDetail.host, sessionDetail.id).then((result) => {
        if (result.ok) { setScreen(result.data); setDetailOffset(Number.MAX_SAFE_INTEGER); }
        else setStatus(result.error.message);
      }).catch((error: unknown) => { setStatus(defaultStatus(error)); });
      else if (input === "l") { const url = sessionLinkUrl(sessionDetail); if (url !== null) openLink(url); else setStatus("No work link on this session"); }
      else if (input === "u") void openFolder(sessionDetail);
      else if (input === "c") void copyValue(sessionDetail.branch ?? "");
      else if (input === "C") void copyValue(sessionDetail.worktreePath ?? sessionDetail.cwd);
      return;
    }
    if (overlay === "host" || overlay === "notification") { if (key.escape) setOverlay("none"); return; }
    if (workSearch) {
      if (key.escape) { setWorkFilters((old) => ({ ...old, text: "" })); setWorkSearch(false); return; }
      if (key.return) { setWorkSearch(false); return; }
      if (key.backspace || key.delete) setWorkFilters((old) => ({ ...old, text: old.text.slice(0, -1) }));
      else if (!key.ctrl && !key.meta && input !== "") setWorkFilters((old) => ({ ...old, text: old.text + input.replaceAll("\r", " ").replaceAll("\n", " ") }));
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) { exit(); return; }
    if (input === "?") { setOverlay("help"); return; }
    if (["1", "2", "3", "4"].includes(input)) { setView(VIEWS[Number(input) - 1] ?? "Work"); return; }
    if (key.upArrow || input === "k") { move(-1); return; }
    if (key.downArrow || input === "j") { move(1); return; }
    if (input === "r") { void refresh(); return; }
    if (view === "Work") {
      if (input === "m") setWorkFilters((old) => ({ ...old, actor: old.actor === "me" ? "all" : "me" }));
      else if (input === "f") setWorkFilters((old) => ({ ...old, actor: ACTOR_FILTERS[(ACTOR_FILTERS.indexOf(old.actor) + 1) % ACTOR_FILTERS.length] ?? "all" }));
      else if (input === "P" && work?.payload !== null && work !== null) {
        const projects = projectLabels(work.payload);
        const index = projects.indexOf(workFilters.project ?? "");
        setWorkFilters((old) => ({ ...old, project: projects[index + 1] ?? null }));
      }
      else if (input === "/") setWorkSearch(true);
      else if (input === "h") setWorkFilters((old) => ({ ...old, hideStale: !old.hideStale }));
      else if (key.return && selectedWork?.actions[0] !== undefined) void workHandover(selectedWork.actions[0].name);
      else if (input === "a") { setWorkChoice(0); setOverlay("work-actions"); }
      else if (input === "t") void workHandover("attach");
      else if (input === "o" && selectedWork !== null) { const url = selectedWork.pull_request?.url ?? selectedWork.issue?.url; if (url !== undefined) openLink(url); }
      else if (input === "p" && selectedWork?.actions[0] !== undefined) void previewWork(options.selfBin, options.listTimeoutMs, selectedWork.key, selectedWork.actions[0].name, selectedWork.project).then((result) => {
        setStatus(typeof result === "string" ? result : JSON.stringify(result));
      }).catch((error: unknown) => { setStatus(defaultStatus(error)); });
      else if (input === "n") openForm(false);
      else if (input === "s") setView("Sessions");
    } else if (view === "Sessions") {
      if (key.return) void inspectSelected();
      else if (input === "o") void openSelected();
      else if (input === "n") openForm(false);
      else if (input === "a") openForm(true);
      else if (input === "P" && snapshot !== null) { const projects = [...new Set(snapshot.sessions.map((session) => session.projectLabel ?? session.projectId).filter((name): name is string => name !== null))].sort(); const index = projects.indexOf(projectFilter ?? ""); setProjectFilter(projects[index + 1] ?? null); setCursor((old) => ({ ...old, Sessions: 0 })); }
    } else if (view === "Hosts") {
      if (key.return) void inspectSelectedHost();
    } else {
      if (input === "c") { setScope((old) => SCOPES[(SCOPES.indexOf(old) + 1) % SCOPES.length] ?? "Recent"); setCursor((old) => ({ ...old, Activity: 0 })); }
      else if (selectedRecord !== null && key.return) void openNotification(selectedRecord);
      else if (selectedRecord !== null && (input === "a" || input === "x")) void updateNotification(selectedRecord, input === "a" ? "ack" : "archive");
    }
  });

  const footer = overlay === "none" ? stdout.columns < layout.compactColumns ? "↑↓ select  ·  Enter action  ·  ? help  ·  q quit" : "Click or use ↑/↓ to select  ·  Enter action  ·  1–4 switch  ·  ? help  ·  q quit" : "Esc back  ·  Tab moves between form fields";
  const subtitle = stale ? "STALE: last good data; writes disabled" : snapshot?.errors.length ? `${snapshot.errors.length} host/source error(s); affected writes disabled` : null;
  const listInteraction = { onSelect: selectIndex, onWheel: move, width: Math.max(20, stdout.columns - 4) };

  let content: ReactNode;
  if (overlay === "form" || overlay === "assistant") content = <FormView form={form} options={launchOptions} actions={actions} assistant={overlay === "assistant"} created={created} busy={busy}
    onFocus={(focus) => { setForm((old) => ({ ...old, focus, choice: 0 })); }} onChoice={changeFormChoice}
    onPickChoice={(index) => {
      if (form.focus === 3 && overlay === "assistant") {
        const intents = ["help", "setup", "project", "update", "debug"] as const;
        setForm((old) => ({ ...old, intent: intents[index] ?? old.intent }));
        return;
      }
      if (launchOptions === null) return;
      if (form.focus === 0) { const host = launchOptions.hosts[index]; if (host !== undefined) void loadForm(host.id, form.project, overlay === "assistant"); }
      else if (form.focus === 1) {
        const project = launchOptions.projects.filter((entry) => `${entry.id} ${entry.label}`.toLowerCase().includes(form.search.toLowerCase()))[index];
        if (project !== undefined) void chooseProject(project.id);
      } else if (form.focus === 2) {
        const agent = launchOptions.agents.filter((entry) => overlay !== "assistant" || entry.assistantCapable)[index - 1];
        setForm((old) => ({ ...old, agent: index === 0 ? null : agent?.id ?? old.agent }));
      } else if (form.focus === 3) void chooseAction(index === 0 ? null : actions[index - 1]?.id ?? null);
    }}
    onScrollChoices={(direction, max) => { setForm((old) => ({ ...old, choice: Math.max(0, Math.min(Math.max(0, max), old.choice + direction)) })); }}
    onSubmit={() => { if (created === null) void submitForm(); else void attachCreated(); }}
    onCancel={() => { if (options.mode === "new-session") exit(); else setOverlay("none"); }} />;
  else if (overlay === "session" && sessionDetail !== null) content = <SessionDetail session={sessionDetail} screen={screen}
    offset={detailOffset} height={Math.max(4, stdout.rows - layout.detailReservedRows)} onWheel={(direction) => { setDetailOffset((old) => Math.max(0, old + direction * layout.detailScrollStep)); }} />;
  else if (overlay === "confirm") content = <Message color="red" text={`Confirm ${confirm ?? "action"} of ${sessionDetail?.name ?? sessionDetail?.id ?? "session"}? y/N. Removal may delete its worktree.`} />;
  else if (overlay === "rename" || overlay === "metadata") content = <Text>{`${overlay === "rename" ? "Name" : "Metadata key=value"}: ${safeText(edit)}_  Enter save  Esc cancel`}</Text>;
  else if (overlay === "host") content = <Box flexDirection="column">
    <Section title="Host capabilities"><Text>{safeText(hostDetail === null ? "Unavailable" : `Daemon ${hostDetail.daemonVersion}; protocol ${hostDetail.protocolVersion}; agents ${hostDetail.supportedAgents.join(", ")}`)}</Text></Section>
    <Section title="Governance"><Text>{safeText(governance === null ? "Unavailable" : `Host ${governance.hostId}; enrollment ${governance.enrollment?.status ?? "never enrolled"}; owner ${governance.owner?.id ?? "none"}; quarantine ${governance.quarantine ?? "none"}`)}</Text></Section>
  </Box>;
  else if (overlay === "notification") content = <Box flexDirection="column"><Section title="Notification"><Text>{safeText(notificationDetail?.title ?? "")}</Text><Text>{safeText(notificationDetail?.body ?? "")}</Text></Section></Box>;
  else if (overlay === "work-actions") content = <Box flexDirection="column"><Text bold>Work actions</Text>{selectedWork?.actions.map((action, index) =>
    <MouseZone key={action.name} onClick={() => void workHandover(action.name)}><Text inverse={index === workChoice}>{safeText(action.name)}</Text></MouseZone>)}</Box>;
  else if (overlay === "help") content = <Box flexDirection="column"><Text>Work: Enter action, a choose, p preview, t attach, o URL, m mine/all, f actor, P project, / search, h stale</Text><Text>Sessions: Enter detail, o attach, n new session, a Assistant, P project</Text><Text>Hosts: Enter inspect. Activity: c scope, Enter read, a acknowledge, x archive.</Text></Box>;
  else if (view === "Work") content = <WorkView rows={workRows} selected={selectedWorkIndex} limit={visibleRows} filter={`Actor ${workFilters.actor}  Project ${workFilters.project ?? "all"}  Search ${workFilters.text || "none"}  Hide stale ${workFilters.hideStale ? "on" : "off"}${work?.partial ? "  PARTIAL" : ""}`} warning={work?.warning ?? null} searchActive={workSearch} searchText={workFilters.text} {...listInteraction} />;
  else if (view === "Sessions") content = <SessionsView snapshot={snapshot} sessions={sessions} selected={selectedSessionIndex} limit={visibleRows} project={projectFilter} {...listInteraction} />;
  else if (view === "Hosts") content = <HostsView hosts={snapshot?.hosts ?? []} selected={cursor.Hosts} limit={visibleRows} {...listInteraction} />;
  else content = <ActivityView records={records} selected={cursor.Activity} scope={scope} limit={visibleRows} {...listInteraction} />;

  let toolbar: ReactNode = null;
  if (overlay === "none") {
    if (view === "Work") toolbar = <Box gap={1} flexWrap="wrap">
      <ActionButton label="New session" onClick={() => { openForm(false); }} primary />
      {selectedWork !== null && <ActionButton label="Actions" onClick={() => { setWorkChoice(0); setOverlay("work-actions"); }} />}
      <ActionButton label={`Actor: ${workFilters.actor}`} onClick={() => { setWorkFilters((old) => ({ ...old, actor: ACTOR_FILTERS[(ACTOR_FILTERS.indexOf(old.actor) + 1) % ACTOR_FILTERS.length] ?? "all" })); }} />
      <ActionButton label={`Project: ${shorten(workFilters.project ?? "all", 12)}`} onClick={() => {
        if (work?.payload === null || work === null) return;
        const projects = projectLabels(work.payload);
        const index = projects.indexOf(workFilters.project ?? "");
        setWorkFilters((old) => ({ ...old, project: projects[index + 1] ?? null }));
      }} />
      <ActionButton label="Search /" onClick={() => { setWorkSearch(true); }} />
      <ActionButton label={`Stale: ${workFilters.hideStale ? "hide" : "show"}`} onClick={() => { setWorkFilters((old) => ({ ...old, hideStale: !old.hideStale })); }} />
      <ActionButton label="Refresh" onClick={() => void refresh()} />
      <ActionButton label="Help ?" onClick={() => { setOverlay("help"); }} />
    </Box>;
    else if (view === "Sessions") toolbar = <Box gap={1} flexWrap="wrap">
      <ActionButton label="New session" onClick={() => { openForm(false); }} primary />
      <ActionButton label="Assistant" onClick={() => { openForm(true); }} />
      {selectedSession !== null && <ActionButton label="Details" onClick={() => void inspectSelected()} />}
      {selectedSession !== null && <ActionButton label="Attach" onClick={() => void openSelected()} />}
      <ActionButton label={`Project: ${shorten(projectFilter ?? "all", 12)}`} onClick={() => {
        if (snapshot === null) return;
        const projects = [...new Set(snapshot.sessions.map((session) => session.projectLabel ?? session.projectId).filter((name): name is string => name !== null))].sort();
        const index = projects.indexOf(projectFilter ?? "");
        setProjectFilter(projects[index + 1] ?? null);
        setCursor((old) => ({ ...old, Sessions: 0 }));
      }} />
      <ActionButton label="Refresh" onClick={() => void refresh()} />
      <ActionButton label="Help ?" onClick={() => { setOverlay("help"); }} />
    </Box>;
    else if (view === "Hosts") toolbar = <Box gap={1}><ActionButton label="Inspect host" onClick={() => void inspectSelectedHost()} primary /><ActionButton label="Refresh" onClick={() => void refresh()} /></Box>;
    else toolbar = <Box gap={1} flexWrap="wrap">
      <ActionButton label={`Scope: ${scope}`} onClick={() => { setScope((old) => SCOPES[(SCOPES.indexOf(old) + 1) % SCOPES.length] ?? "Recent"); setCursor((old) => ({ ...old, Activity: 0 })); }} />
      {selectedRecord !== null && <ActionButton label="Open" onClick={() => void openNotification(selectedRecord)} primary />}
      {selectedRecord !== null && <ActionButton label="Acknowledge" onClick={() => void updateNotification(selectedRecord, "ack")} />}
      {selectedRecord !== null && <ActionButton label="Archive" onClick={() => void updateNotification(selectedRecord, "archive")} />}
    </Box>;
  } else if (overlay === "session" && sessionDetail !== null) toolbar = <Box gap={1} flexWrap="wrap">
    <ActionButton label="Attach" onClick={() => void openSelected()} primary />
    <ActionButton label="Resume" onClick={() => void runSessionAction({ kind: "resume", host: sessionDetail.host, sessionId: sessionDetail.id })} />
    <ActionButton label="Screen" onClick={() => { void control.screen(sessionDetail.host, sessionDetail.id).then((result) => { if (result.ok) { setScreen(result.data); setDetailOffset(Number.MAX_SAFE_INTEGER); } else setStatus(result.error.message); }).catch((error: unknown) => { setStatus(defaultStatus(error)); }); }} />
    <ActionButton label="Fork" onClick={() => void runSessionAction({ kind: "fork", host: sessionDetail.host, sessionId: sessionDetail.id })} />
    <ActionButton label="Rename" onClick={() => { setEdit(sessionDetail.name ?? ""); setOverlay("rename"); }} />
    <ActionButton label="Metadata" onClick={() => { setEdit(""); setOverlay("metadata"); }} />
    <ActionButton label="Copy branch" onClick={() => void copyValue(sessionDetail.branch ?? "")} />
    <ActionButton label="Copy path" onClick={() => void copyValue(sessionDetail.worktreePath ?? sessionDetail.cwd)} />
    {sessionLinkUrl(sessionDetail) !== null && <ActionButton label="Open link" onClick={() => { const url = sessionLinkUrl(sessionDetail); if (url !== null) openLink(url); }} />}
    {sessionDetail.host === "local" && <ActionButton label="Open folder" onClick={() => void openFolder(sessionDetail)} />}
    <ActionButton label="Stop" onClick={() => { setConfirm("stop"); setOverlay("confirm"); }} />
    <ActionButton label="Remove" onClick={() => { setConfirm("remove"); setOverlay("confirm"); }} />
    <ActionButton label="Back" onClick={() => { setOverlay("none"); }} />
  </Box>;
  else if (overlay === "confirm") toolbar = <Box gap={1}>
    <ActionButton label={`Confirm ${confirm ?? "action"}`} onClick={() => { if (confirm !== null && sessionDetail !== null) void runSessionAction({ kind: confirm, host: sessionDetail.host, sessionId: sessionDetail.id }); setConfirm(null); setOverlay("session"); }} primary />
    <ActionButton label="Cancel" onClick={() => { setConfirm(null); setOverlay("session"); }} />
  </Box>;
  else if (overlay !== "form" && overlay !== "assistant") toolbar = <Box gap={1}>
    {(overlay === "rename" || overlay === "metadata") && sessionDetail !== null && <ActionButton label="Save" onClick={() => {
      if (overlay === "rename") void runSessionAction({ kind: "rename", host: sessionDetail.host, sessionId: sessionDetail.id, name: nullable(edit) });
      else { const separator = edit.indexOf("="); if (separator < 1) setStatus("Metadata needs key=value"); else void runSessionAction({ kind: "metadata", host: sessionDetail.host, sessionId: sessionDetail.id, set: { [edit.slice(0, separator)]: edit.slice(separator + 1) } }); }
    }} primary />}
    <ActionButton label="Back" onClick={() => { setOverlay(overlay === "rename" || overlay === "metadata" ? "session" : "none"); }} />
  </Box>;

  return <ScreenFrame title={options.mode === "new-session" ? "pohunek-work new-session" : "pohunek-work"}
    {...(options.mode === "main" ? { tabs: VIEWS, activeTab: VIEWS.indexOf(view), onTab: (index: number) => { setOverlay("none"); setView(VIEWS[index] ?? "Work"); } } : {})}
    subtitle={subtitle} footer={footer} status={status ?? work?.warning ?? null}>
    {content}
    {toolbar}
  </ScreenFrame>;
}

export async function runInkTui(options: InkTuiOptions): Promise<number> {
  let exitCode = 0;
  const instance = render(<MouseProvider><InkApplication options={options} setExitCode={(code) => { exitCode = code; }} /></MouseProvider>, { alternateScreen: true, interactive: true, exitOnCtrlC: false, patchConsole: false });
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
