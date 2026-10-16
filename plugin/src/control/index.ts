import { connectLocal, connectTcp, resolveRequestOrigin, type Client, type ConnectOptions } from "@pohunek/sdk";
import { exec, SpawnError } from "../util/exec.ts";
import {
  InvalidControlResponse, array, boolean, capabilities, count, governance, host as parseHost,
  notification, object, project, projectDetail, screen, session, string,
} from "./decode.ts";
import { isUnresolvedAction } from "../ink/attention.ts";
import { sdkFailure, SdkLink } from "./sdk-link.ts";
import type {
  ControlAction, ControlActionOutcome, ControlClient, ControlClientOptions, ControlError,
  ControlActivityPage, ControlActivityScope, ControlHost, ControlNotificationChange, ControlNotification, ControlProject, ControlResult, ControlSession, ControlSnapshot, ControlSnapshotError,
} from "./types.ts";

export type * from "./types.ts";

const PROTOCOL_VERSION = 4;
/** Delay between the first event of a host and the read it schedules; the events before that read join it. */
const EVENT_SETTLE_MS = 100;
const LOCAL_HOST: ControlHost = { route: "local", dialable: true, name: "Local", classification: "local", daemonVersion: null, address: null, port: null };

function failure(code: ControlError["code"], message: string, extra: Partial<ControlError> = {}): ControlResult<never> {
  return { ok: false, error: { code, message, ...extra } };
}

function parseEnvelope(stdout: string, exitCode: number | null): ControlResult<unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); }
  catch { return failure("invalid_response", `pohunek exited with code ${String(exitCode)} and did not return JSON`); }
  try {
    const envelope = object(parsed, "$");
    string(envelope, "cli_version", "$");
    const protocol = object(envelope["protocol"], "$.protocol");
    const minimum = count(protocol, "minimum", "$.protocol");
    const maximum = count(protocol, "maximum", "$.protocol");
    const hasOk = "ok" in envelope;
    const hasErr = "err" in envelope;
    if (hasOk === hasErr) { throw new InvalidControlResponse("$: expected exactly one of ok and err"); }
    if (PROTOCOL_VERSION < minimum || PROTOCOL_VERSION > maximum) {
      return failure("protocol_mismatch", `plugin supports protocol ${String(PROTOCOL_VERSION)}, pohunek offers ${String(minimum)}-${String(maximum)}`);
    }
    if (hasErr) {
      const err = object(envelope["err"], "$.err");
      const cliCode = string(err, "code", "$.err");
      const cliClass = string(err, "class", "$.err");
      if (cliCode === "incomplete_origin_environment") {
        return failure("origin_environment", "Set both POHUNEK_SESSION_ID and POHUNEK_DAEMON_ID, or unset both.", { cliCode, cliClass });
      }
      return failure(cliCode === "request_timeout" ? "timeout" : "command_failed", `pohunek error ${cliCode}`, { cliCode, cliClass });
    }
    if (exitCode !== 0) { return failure("invalid_response", `pohunek exited with code ${String(exitCode)} but reported ok`); }
    return { ok: true, data: envelope["ok"] };
  } catch (error) {
    if (error instanceof InvalidControlResponse) { return failure("invalid_response", error.message); }
    throw error;
  }
}

/** The cursors of an activity page: each host with more records maps to its next cursor; a host without an entry is complete. */
function parseActivityCursor(cursor: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    return entries.every(([, value]) => typeof value === "string" && value !== "") ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}

/** A daemon answer that refused the request; a transport failure or a timeout does not say whether it was applied. */
function definitiveRefusal(error: ControlError): boolean {
  return error.code === "command_failed" && ["configuration", "daemon", "runtime", "discovery"].includes(error.cliClass ?? "");
}

const ORIGIN_ENVIRONMENT_MESSAGE = "Set both POHUNEK_SESSION_ID and POHUNEK_DAEMON_ID, or unset both.";

function originError(env: Readonly<Record<string, string | undefined>>): ControlError | null {
  const session = env["POHUNEK_SESSION_ID"] !== undefined;
  const daemon = env["POHUNEK_DAEMON_ID"] !== undefined;
  return session === daemon ? null : {
    code: "origin_environment",
    message: ORIGIN_ENVIRONMENT_MESSAGE,
  };
}

/**
 * Connect options that carry the origin of a TUI hosted in a managed session, so the daemon refuses mutations
 * aimed at that session. The SDK does not read these variables itself. A half-set pair fails the connection,
 * because a connection without the origin would let the TUI mutate its own session.
 */
function connectOptions(env: Readonly<Record<string, string | undefined>>): ConnectOptions {
  const sessionId = env["POHUNEK_SESSION_ID"];
  const daemonId = env["POHUNEK_DAEMON_ID"];
  if (sessionId === undefined && daemonId === undefined) return {};
  if (sessionId === undefined || daemonId === undefined) throw new Error(ORIGIN_ENVIRONMENT_MESSAGE);
  return { origin: resolveRequestOrigin({ sessionId, daemonId }) };
}

/** The outcome of the last read of one scope on a host, and the records of its last successful read. */
interface ScopeRead<T> {
  readonly result: ControlResult<readonly T[]>;
  readonly last: readonly T[];
}

/** A failed read keeps the records of the last successful one; the result still reports the failure. */
function scopeRead<T>(result: ControlResult<readonly T[]>, previous: ScopeRead<T> | undefined): ScopeRead<T> {
  return { result, last: result.ok ? result.data : previous?.last ?? [] };
}

/** One notification that a daemon event names; a null record removes the notification from the list. */
interface NotificationChange {
  readonly id: string;
  readonly record: ControlNotification | null;
}

/** The change a notification event carries (its record in any status, null when it is deleted), or null when the event does not carry enough to apply it. */
function notificationChange(kind: string, event: Readonly<Record<string, unknown>>, route: string): NotificationChange | null {
  try {
    if (kind === "notification_deleted") return { id: string(event, "notification_id", "$"), record: null };
    if (kind !== "notification_created" && kind !== "notification_updated") return null;
    const record = notification(event["record"], "$.record", route);
    return { id: record.id, record };
  } catch (error) {
    if (error instanceof InvalidControlResponse) return null;
    throw error;
  }
}

function applyNotificationChange(records: readonly ControlNotification[], change: NotificationChange): ControlNotification[] {
  const others = records.filter(record => record.id !== change.id);
  return change.record === null ? others : [...others, change.record];
}

function bareIdError(id: string): ControlError | null {
  let hasControl = false;
  for (let index = 0; index < id.length; index += 1) {
    if (id.charCodeAt(index) < 32) { hasControl = true; break; }
  }
  if (id === "" || id.startsWith("-") || id.includes("/") || hasControl) {
    return { code: "command_failed", message: "target must be an unqualified id on the selected host" };
  }
  return null;
}

export function createControlClient(options: ControlClientOptions): ControlClient {
  if (!options.binary || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
      !Number.isSafeInteger(options.notificationsPageSize) || options.notificationsPageSize < 1 ||
      !Number.isSafeInteger(options.reconnectMaxMs) || options.reconnectMaxMs < 1) {
    throw new TypeError("control client requires binary, positive timeoutMs, positive notificationsPageSize and positive reconnectMaxMs");
  }
  const environment = (): Readonly<Record<string, string | undefined>> => options.env ?? process.env;

  async function call(args: readonly string[]): Promise<ControlResult<unknown>> {
    const invalidOrigin = originError(environment());
    if (invalidOrigin !== null) { return { ok: false, error: invalidOrigin }; }
    try {
      const result = await exec([options.binary, ...args], { timeoutMs: options.timeoutMs, ...(options.env === undefined ? {} : { env: options.env }) });
      return result.timedOut ? failure("timeout", `pohunek did not answer within ${String(options.timeoutMs)} ms`)
        : parseEnvelope(result.stdout, result.exitCode);
    } catch (error) {
      if (error instanceof SpawnError) { return failure("unavailable", `cannot start ${options.binary}`); }
      throw error;
    }
  }

  async function read<T>(args: readonly string[], parse: (raw: unknown) => T): Promise<ControlResult<T>> {
    const result = await call(args);
    if (!result.ok) { return result; }
    try { return { ok: true, data: parse(result.data) }; }
    catch (error) {
      if (error instanceof InvalidControlResponse) { return failure("invalid_response", error.message); }
      throw error;
    }
  }

  const onHost = (host: string, args: readonly string[]): readonly string[] => ["--host", host, ...args, "--json"];
  const projectList = (host: string): Promise<ControlResult<readonly ControlProject[]>> => read(onHost(host, ["project", "list"]), raw =>
    array(raw, "$.ok").map((item, index) => project(item, `$.ok[${String(index)}]`, host)));

  // The session and notification reads of each host go through its SDK link; the CLI keeps
  // host discovery, projects and every mutation.
  const hostRecords = new Map<string, ControlHost>([["local", LOCAL_HOST]]);
  const links = new Map<string, SdkLink>();
  const sessionReads = new Map<string, ScopeRead<ControlSession>>();
  const notificationReads = new Map<string, ScopeRead<ControlNotification>>();
  // The full notification read of a route while it is in flight; `again` asks for one more read after it returns.
  const notificationReading = new Map<string, { again: boolean; done: Promise<void> }>();
  // Changes that events deliver during a full notification read; they are applied on top of the records it returns.
  const bufferedChanges = new Map<string, NotificationChange[]>();
  const projectReads = new Map<string, ControlResult<readonly ControlProject[]>>();
  // A scheduled read per route; events that arrive before it runs join it instead of postponing it.
  const settling = new Map<string, { notifications: boolean; timer: ReturnType<typeof setTimeout> }>();
  // Notification changes publish once per settle window instead of once per event.
  let publishing: ReturnType<typeof setTimeout> | null = null;
  // Output polls get their own connection, so a long poll never queues behind the reads and mutations of the route.
  const outputLinks = new Map<string, SdkLink>();
  const listeners = new Set<(snapshot: ControlSnapshot) => void>();
  const notificationListeners = new Set<(change: ControlNotificationChange) => void>();
  let hosts: ControlHost[] = [LOCAL_HOST];
  let discoveryError: ControlError | null = null;
  // Set by close(); a read that was pending when the client closed must not open a connection afterwards.
  let closed = false;

  function connectorFor(route: string): () => Promise<Client> {
    return () => {
      const record = hostRecords.get(route);
      if (record === undefined) return Promise.reject(new Error(`host ${route} is not listed`));
      if (route === "local") {
        if (options.localSocket === null) return Promise.reject(new Error("the local daemon socket cannot be resolved"));
        return connectLocal(options.localSocket, connectOptions(environment()));
      }
      if (record.address === null || record.port === null) return Promise.reject(new Error(`host ${route} has no address`));
      return connectTcp(route, { host: record.address, port: record.port }, connectOptions(environment()));
    };
  }

  function linkFor(route: string): SdkLink {
    if (closed) throw new Error("the control client is closed");
    const existing = links.get(route);
    if (existing !== undefined) return existing;
    const link = new SdkLink(route, connectorFor(route), (kind, event) => { onLinkEvent(route, kind, event); }, options.timeoutMs, options.reconnectMaxMs);
    links.set(route, link);
    return link;
  }

  function outputLinkFor(route: string): SdkLink {
    if (closed) throw new Error("the control client is closed");
    const existing = outputLinks.get(route);
    if (existing !== undefined) return existing;
    // A reconnect of this link publishes a snapshot, so the panel reads its output again; the link's own events are not needed.
    const link = new SdkLink(route, connectorFor(route), (kind) => { if (kind === "") scheduleRead(route, false); }, options.timeoutMs, options.reconnectMaxMs, false);
    outputLinks.set(route, link);
    return link;
  }

  async function readActivity(route: string, scope: ControlActivityScope, cursor: string | null): Promise<{ readonly route: string; readonly result: ControlResult<{ readonly records: readonly ControlNotification[]; readonly next: string | null }> }> {
    try {
      return { route, result: await linkFor(route).activityPage(scope, options.notificationsPageSize, cursor) };
    } catch (error) {
      return { route, result: { ok: false, error: sdkFailure(error) } };
    }
  }

  /** The activity scope of every host, one page per host; a host that fails fails the page, which keeps the records shown before. */
  async function activity(scope: ControlActivityScope, cursor: string | null): Promise<ControlResult<ControlActivityPage>> {
    const previous = cursor === null ? {} : parseActivityCursor(cursor);
    if (previous === null) return failure("command_failed", "activity cursor is not valid");
    const routes = cursor === null
      ? hosts.filter(item => item.classification === "local" || item.classification === "reachable_daemon").map(item => item.route)
      : Object.keys(previous);
    const pages = await Promise.all(routes.map(route => readActivity(route, scope, previous[route] ?? null)));
    const records: ControlNotification[] = [];
    const next: Record<string, string> = {};
    for (const { route, result } of pages) {
      if (!result.ok) return result;
      records.push(...result.data.records);
      if (result.data.next !== null) next[route] = result.data.next;
    }
    records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { ok: true, data: { records, cursor: Object.keys(next).length === 0 ? null : JSON.stringify(next) } };
  }

  function assemble(): ControlSnapshot {
    const sessions: ControlSession[] = [];
    const notifications: ControlNotification[] = [];
    const projects: ControlProject[] = [];
    const errors: ControlSnapshotError[] = [];
    const pendingNotifications: string[] = [];
    if (discoveryError !== null) errors.push({ host: "local", scope: "discovery", error: discoveryError });
    for (const host of hosts) {
      const sessionRead = sessionReads.get(host.route);
      if (sessionRead !== undefined) {
        if (sessionRead.result.ok) sessions.push(...sessionRead.result.data);
        else {
          sessions.push(...sessionRead.last);
          errors.push({ host: host.route, scope: "sessions", error: sessionRead.result.error });
        }
      }
      const notificationRead = notificationReads.get(host.route);
      if (notificationRead === undefined) pendingNotifications.push(host.route);
      else if (notificationRead.result.ok) notifications.push(...notificationRead.result.data);
      else {
        notifications.push(...notificationRead.last);
        errors.push({ host: host.route, scope: "notifications", error: notificationRead.result.error });
      }
      const projectRead = projectReads.get(host.route);
      if (projectRead !== undefined) {
        if (projectRead.ok) projects.push(...projectRead.data);
        else errors.push({ host: host.route, scope: "projects", error: projectRead.error });
      }
    }
    return { hosts, sessions, projects, notifications, errors, pendingNotifications };
  }

  function publish(): void {
    const snapshot = assemble();
    for (const listener of listeners) listener(snapshot);
  }

  function schedulePublish(): void {
    publishing ??= setTimeout(() => {
      publishing = null;
      publish();
    }, EVENT_SETTLE_MS);
  }

  /** The sessions of a host are stored and published before its notifications are read. */
  async function readHost(route: string, withNotifications: boolean): Promise<void> {
    await readSessions(route);
    publish();
    if (withNotifications) {
      await readNotifications(route);
      publish();
    }
  }

  async function readSessions(route: string): Promise<void> {
    const result = await linkFor(route).sessions();
    // A read that finished after its host was removed or the client closed stores nothing.
    if (closed || !hostRecords.has(route)) return;
    sessionReads.set(route, scopeRead(result, sessionReads.get(route)));
  }

  /** At most one full notification read runs per route; a request during it runs one more read after it. */
  function readNotifications(route: string): Promise<void> {
    const running = notificationReading.get(route);
    if (running !== undefined) {
      running.again = true;
      return running.done;
    }
    const run: { again: boolean; done: Promise<void> } = { again: true, done: Promise.resolve() };
    notificationReading.set(route, run);
    run.done = (async () => {
      try {
        while (run.again) {
          run.again = false;
          await readNotificationsOnce(route);
        }
      } finally {
        notificationReading.delete(route);
      }
    })();
    return run.done;
  }

  async function readNotificationsOnce(route: string): Promise<void> {
    bufferedChanges.set(route, []);
    try {
      const result = await linkFor(route).attention(options.notificationsPageSize);
      const changes = bufferedChanges.get(route) ?? [];
      if (closed || !hostRecords.has(route)) return;
      const outcome: ControlResult<readonly ControlNotification[]> = result.ok
        ? { ok: true, data: changes.reduce(applyNotificationChange, result.data) }
        : result;
      notificationReads.set(route, scopeRead(outcome, notificationReads.get(route)));
    } finally {
      bufferedChanges.delete(route);
    }
  }

  /**
   * A notification event applies its change to the records already read, so a burst of events does not page the
   * notifications again. A scope without a successful read is read in full, which reports its failure again.
   */
  function onLinkEvent(route: string, kind: string, event: Readonly<Record<string, unknown>>): void {
    if (closed || !hostRecords.has(route)) return;
    // Session events read the sessions alone; a connection change reads every scope.
    if (kind === "") { scheduleRead(route, true); return; }
    if (!kind.startsWith("notification")) { scheduleRead(route, false); return; }
    const change = notificationChange(kind, event, route);
    if (change === null) { scheduleRead(route, true); return; }
    for (const listener of notificationListeners) listener({ host: route, id: change.id, record: change.record });
    // The attention list keeps the unresolved actions only; a change to any other record removes it from the list.
    const attention: NotificationChange = { id: change.id, record: change.record !== null && isUnresolvedAction(change.record) ? change.record : null };
    const buffer = bufferedChanges.get(route);
    if (buffer !== undefined) {
      buffer.push(attention);
      return;
    }
    const current = notificationReads.get(route);
    if (current === undefined || !current.result.ok) {
      void readNotifications(route).then(publish, () => undefined);
      return;
    }
    notificationReads.set(route, scopeRead({ ok: true, data: applyNotificationChange(current.result.data, attention) }, current));
    schedulePublish();
  }

  function scheduleRead(route: string, notifications: boolean): void {
    if (closed || !hostRecords.has(route)) return;
    const pending = settling.get(route);
    if (pending !== undefined) {
      pending.notifications ||= notifications;
      return;
    }
    const entry = { notifications, timer: setTimeout(() => {
      settling.delete(route);
      void readHost(route, entry.notifications).catch(() => undefined);
    }, EVENT_SETTLE_MS) };
    settling.set(route, entry);
  }

  async function refresh(): Promise<ControlSnapshot> {
    const discovered = await read(["host", "discover", "--json"], raw =>
      array(raw, "$.ok").map((item, index) => parseHost(item, `$.ok[${String(index)}]`)));
    if (closed) return assemble();
    discoveryError = discovered.ok ? null : discovered.error;
    hosts = [LOCAL_HOST, ...(discovered.ok ? discovered.data : [])];
    hostRecords.clear();
    for (const host of hosts) hostRecords.set(host.route, host);
    for (const route of new Set([...links.keys(), ...outputLinks.keys()])) {
      if (!hostRecords.has(route)) {
        await links.get(route)?.close();
        links.delete(route);
        await outputLinks.get(route)?.close();
        outputLinks.delete(route);
        sessionReads.delete(route);
        notificationReads.delete(route);
        projectReads.delete(route);
      }
    }
    publish();
    const targets = hosts.filter(item => item.classification === "local" || item.classification === "reachable_daemon");
    await Promise.all(targets.map(async target => {
      const [, projects] = await Promise.all([readHost(target.route, true), projectList(target.route)]);
      projectReads.set(target.route, projects);
      publish();
    }));
    return assemble();
  }

  async function readSessionNotifications(host: string, id: string): Promise<ControlResult<readonly ControlNotification[]>> {
    try {
      return await linkFor(host).sessionNotifications(id, options.notificationsPageSize);
    } catch (error) {
      return { ok: false, error: sdkFailure(error) };
    }
  }

  /** Session mutations go through the SDK of the pinned release; a live session is stopped before it is removed, as the CLI does. */
  async function sdkAct(action: ControlAction): Promise<ControlResult<ControlActionOutcome> | null> {
    if ("notificationId" in action) return notificationAct(action);
    if (!("sessionId" in action)) return null;
    const host = action.host;
    const link = linkFor(host);
    const sessionId = action.sessionId;
    const stopped = async (): Promise<ControlResult<boolean>> => {
      const result = await link.request("session.stop", sessionId);
      if (!result.ok) return result;
      return { ok: true, data: boolean(object(result.data, "$"), "stopped", "$") };
    };
    const sessionReply = (result: ControlResult<unknown>, kind: "resume" | "rename" | "metadata"): ControlResult<ControlActionOutcome> => {
      if (!result.ok) return result;
      const payload = object(result.data, "$");
      return { ok: true, data: { kind, session: session(payload["session"], "$.session", host) } as ControlActionOutcome };
    };
    switch (action.kind) {
      case "stop": {
        const result = await stopped();
        return result.ok ? { ok: true, data: { kind: "stop", stopped: result.data } } : result;
      }
      case "remove": {
        const inspected = await link.request("session.inspect", sessionId);
        if (!inspected.ok) return inspected;
        const state = string(object(inspected.data, "$"), "state", "$");
        const live = ["running", "working", "starting", "reconnecting", "blocked"].includes(state);
        let wasStopped = false;
        if (live) {
          const result = await stopped();
          if (!result.ok) return result;
          wasStopped = result.data;
        }
        const removed = await link.request("session.remove", sessionId);
        if (!removed.ok) {
          // Only a definitive daemon answer says the removal did not happen; a lost reply may hide a removal that did.
          if (!definitiveRefusal(removed.error)) {
            return failure("outcome_unknown", `${wasStopped ? "session stopped; " : ""}removal outcome is unknown: ${removed.error.message}`);
          }
          // A stop that succeeded before the refused removal stays visible, so the owner knows what changed.
          return failure("command_failed", wasStopped ? `session stopped but not removed: ${removed.error.message}` : removed.error.message, { ...(removed.error.cliCode === undefined ? {} : { cliCode: removed.error.cliCode }), ...(removed.error.cliClass === undefined ? {} : { cliClass: removed.error.cliClass }) });
        }
        const payload = object(removed.data, "$");
        return { ok: true, data: { kind: "remove", removed: boolean(payload, "removed", "$"), stopped: wasStopped || boolean(payload, "stopped", "$"),
          worktreesRemoved: count(payload, "worktrees_removed", "$"), worktreesFailed: count(payload, "worktrees_failed", "$") } };
      }
      case "resume": return sessionReply(await link.request("session.resume", sessionId), "resume");
      case "fork": {
        // The fork reply is the forked session itself, not an envelope around it.
        const forked = await link.request("session.fork", {
          session_id: sessionId, cwd_mode: "same", cols: action.cols, rows: action.rows, ...(action.name === undefined ? {} : { name: action.name }),
        });
        return forked.ok ? { ok: true, data: { kind: "fork", session: session(forked.data, "$", host) } } : forked;
      }
      case "rename": return sessionReply(await link.request("session.rename", action.name === null ? { session_id: sessionId } : { session_id: sessionId, name: action.name }), "rename");
      case "metadata": {
        const set = Object.entries(action.set ?? {});
        const clear = action.clear ?? [];
        if (set.length === 0 && clear.length === 0) return failure("command_failed", "metadata action requires at least one set or clear entry");
        if (set.some(([key]) => key === "" || key.includes("=")) || clear.some(key => key === "" || key.includes("="))) {
          return failure("command_failed", "metadata keys must be non-empty and cannot contain '='");
        }
        const metadata: Record<string, string | null> = { ...Object.fromEntries(set), ...Object.fromEntries(clear.map(key => [key, null])) };
        return sessionReply(await link.request("session.set_metadata", { session_id: sessionId, metadata }), "metadata");
      }
      default: return null;
    }
  }

  /** Notification reads and acknowledgements go through the SDK's update method, one notification per call. */
  async function notificationAct(action: Extract<ControlAction, { readonly notificationId: string }>): Promise<ControlResult<ControlActionOutcome>> {
    const status = { read: "read", ack: "acknowledged", archive: "archived" } as const;
    const link = linkFor(action.host);
    const result = await link.request("notification.update", { id: action.notificationId, status: status[action.kind] });
    if (!result.ok) return result;
    const record = object(result.data, "$")["record"];
    return { ok: true, data: { kind: action.kind, notification: notification(record, "$.record", action.host) } };
  }

  /** A mutation that failed after it was sent may still have been applied; only a definitive daemon refusal is a failure. */
  function viaSdkOutcome(action: ControlAction, result: ControlResult<ControlActionOutcome>): ControlResult<ControlActionOutcome> {
    if (result.ok || result.error.code === "outcome_unknown" || result.error.code === "unavailable") return result;
    if (definitiveRefusal(result.error)) return result;
    return failure("outcome_unknown", `${action.kind} outcome is unknown: the daemon did not answer; refresh and look before retrying`);
  }

  async function act(action: ControlAction): Promise<ControlResult<ControlActionOutcome>> {
    const host = action.host;
    if (host.startsWith("undialable:")) { return failure("unavailable", "the selected host has no dialable identity"); }
    const invalidTarget = bareIdError("sessionId" in action ? action.sessionId : action.notificationId);
    if (invalidTarget !== null) { return { ok: false, error: invalidTarget }; }
    const viaSdk = await sdkAct(action);
    if (viaSdk !== null) return viaSdkOutcome(action, viaSdk);
    switch (action.kind) {
      default: return failure("command_failed", `${action.kind} is handled over the SDK`);
    }
  }

  return {
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeNotifications(listener) {
      notificationListeners.add(listener);
      return () => { notificationListeners.delete(listener); };
    },
    async close() {
      closed = true;
      for (const entry of settling.values()) clearTimeout(entry.timer);
      settling.clear();
      if (publishing !== null) clearTimeout(publishing);
      publishing = null;
      await Promise.all([...links.values(), ...outputLinks.values()].map(async link => { await link.close(); }));
      links.clear();
      outputLinks.clear();
    },
    inspectHost: host => host.startsWith("undialable:") ? Promise.resolve(failure("unavailable", "the selected host has no dialable identity"))
      : read(["host", "inspect", host, "--json"], raw => capabilities(raw, "$.ok")),
    inspectGovernance: host => host.startsWith("undialable:") ? Promise.resolve(failure("unavailable", "the selected host has no dialable identity"))
      : read(["host", "governance", "inspect", host, "--json"], raw => governance(raw, "$.ok")),
    inspectSession: (host, id) => {
      const invalidTarget = bareIdError(id);
      return invalidTarget === null ? read(onHost(host, ["session", "inspect", id]), raw => session(raw, "$.ok", host))
        : Promise.resolve({ ok: false, error: invalidTarget });
    },
    screen: (host, id) => {
      const invalidTarget = bareIdError(id);
      return invalidTarget === null ? read(onHost(host, ["session", "screen", id]), raw => screen(raw, "$.ok"))
        : Promise.resolve({ ok: false, error: invalidTarget });
    },
    output: (host, id, request) => {
      const invalidTarget = bareIdError(id);
      if (invalidTarget !== null) return Promise.resolve({ ok: false, error: invalidTarget });
      if (host.startsWith("undialable:")) return Promise.resolve(failure("unavailable", "the selected host has no dialable identity"));
      return outputLinkFor(host).output(id, request);
    },
    activity: (scope, cursor) => activity(scope, cursor),
    sessionNotifications: (host, id) => {
      const invalidTarget = bareIdError(id);
      if (invalidTarget !== null) return Promise.resolve({ ok: false, error: invalidTarget });
      if (host.startsWith("undialable:")) return Promise.resolve(failure("unavailable", "the selected host has no dialable identity"));
      return readSessionNotifications(host, id);
    },
    showProject: (host, reference) => read(onHost(host, ["project", "show", reference]), raw => projectDetail(raw, "$.ok", host)),
    act,
  };
}
