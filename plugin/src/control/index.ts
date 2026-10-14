import { connectLocal, connectTcp, resolveRequestOrigin, type ConnectOptions } from "@pohunek/sdk";
import { exec, SpawnError } from "../util/exec.ts";
import {
  InvalidControlResponse, array, boolean, capabilities, count, governance, host as parseHost,
  notification, object, project, projectDetail, screen, session, string,
} from "./decode.ts";
import { SdkLink } from "./sdk-link.ts";
import type {
  ControlAction, ControlActionOutcome, ControlClient, ControlClientOptions, ControlError,
  ControlHost, ControlNotification, ControlProject, ControlResult, ControlSession, ControlSnapshot, ControlSnapshotError,
} from "./types.ts";

export type * from "./types.ts";

const PROTOCOL_VERSION = 4;
/** Quiet time after the last event of a host before that host is read again. */
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
  const reads = new Map<string, {
    sessions: ControlResult<readonly ControlSession[]>;
    notifications: ControlResult<readonly ControlNotification[]>;
    lastSessions: readonly ControlSession[];
    lastNotifications: readonly ControlNotification[];
  }>();
  const projectReads = new Map<string, ControlResult<readonly ControlProject[]>>();
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<(snapshot: ControlSnapshot) => void>();
  let hosts: ControlHost[] = [LOCAL_HOST];
  let discoveryError: ControlError | null = null;
  // Set by close(); a read that was pending when the client closed must not open a connection afterwards.
  let closed = false;

  function linkFor(route: string): SdkLink {
    if (closed) throw new Error("the control client is closed");
    const existing = links.get(route);
    if (existing !== undefined) return existing;
    const link = new SdkLink(route, () => {
      const record = hostRecords.get(route);
      if (record === undefined) return Promise.reject(new Error(`host ${route} is not listed`));
      if (route === "local") {
        if (options.localSocket === null) return Promise.reject(new Error("the local daemon socket cannot be resolved"));
        return connectLocal(options.localSocket, connectOptions(environment()));
      }
      if (record.address === null || record.port === null) return Promise.reject(new Error(`host ${route} has no address`));
      return connectTcp(route, { host: record.address, port: record.port }, connectOptions(environment()));
    }, () => { scheduleRead(route); }, options.timeoutMs, options.reconnectMaxMs);
    links.set(route, link);
    return link;
  }

  function assemble(): ControlSnapshot {
    const sessions: ControlSession[] = [];
    const notifications: ControlNotification[] = [];
    const projects: ControlProject[] = [];
    const errors: ControlSnapshotError[] = [];
    if (discoveryError !== null) errors.push({ host: "local", scope: "discovery", error: discoveryError });
    for (const host of hosts) {
      const row = reads.get(host.route);
      if (row !== undefined) {
        // A failed read reports its error and keeps the records of the last successful read of that scope.
        if (row.sessions.ok) sessions.push(...row.sessions.data);
        else {
          sessions.push(...row.lastSessions);
          errors.push({ host: host.route, scope: "sessions", error: row.sessions.error });
        }
        if (row.notifications.ok) notifications.push(...row.notifications.data);
        else {
          notifications.push(...row.lastNotifications);
          errors.push({ host: host.route, scope: "notifications", error: row.notifications.error });
        }
      }
      const projectRead = projectReads.get(host.route);
      if (projectRead !== undefined) {
        if (projectRead.ok) projects.push(...projectRead.data);
        else errors.push({ host: host.route, scope: "projects", error: projectRead.error });
      }
    }
    return { hosts, sessions, projects, notifications, errors };
  }

  function publish(): void {
    const snapshot = assemble();
    for (const listener of listeners) listener(snapshot);
  }

  async function readHost(route: string): Promise<void> {
    const link = linkFor(route);
    const [sessions, notifications] = await Promise.all([link.sessions(), link.notifications(options.notificationsPageSize)]);
    const previous = reads.get(route);
    reads.set(route, {
      sessions,
      notifications,
      lastSessions: sessions.ok ? sessions.data : previous?.lastSessions ?? [],
      lastNotifications: notifications.ok ? notifications.data : previous?.lastNotifications ?? [],
    });
  }

  function scheduleRead(route: string): void {
    if (closed) return;
    const pending = settling.get(route);
    if (pending !== undefined) clearTimeout(pending);
    settling.set(route, setTimeout(() => {
      settling.delete(route);
      void readHost(route).then(publish, () => undefined);
    }, EVENT_SETTLE_MS));
  }

  async function refresh(): Promise<ControlSnapshot> {
    const discovered = await read(["host", "discover", "--json"], raw =>
      array(raw, "$.ok").map((item, index) => parseHost(item, `$.ok[${String(index)}]`)));
    if (closed) return assemble();
    discoveryError = discovered.ok ? null : discovered.error;
    hosts = [LOCAL_HOST, ...(discovered.ok ? discovered.data : [])];
    hostRecords.clear();
    for (const host of hosts) hostRecords.set(host.route, host);
    for (const route of [...links.keys()]) {
      if (!hostRecords.has(route)) {
        await links.get(route)?.close();
        links.delete(route);
        reads.delete(route);
        projectReads.delete(route);
      }
    }
    const targets = hosts.filter(item => item.classification === "local" || item.classification === "reachable_daemon");
    await Promise.all(targets.map(async target => {
      const [, projects] = await Promise.all([readHost(target.route), projectList(target.route)]);
      projectReads.set(target.route, projects);
    }));
    return assemble();
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
          if (removed.error.code === "timeout" || removed.error.cliCode === "request_timeout") {
            return failure("outcome_unknown", `${wasStopped ? "session stopped; " : ""}removal outcome is unknown: the daemon did not answer`);
          }
          // A stop that succeeded before the failed removal stays visible, so the owner knows what changed.
          return failure("command_failed", wasStopped ? `session stopped but not removed: ${removed.error.message}` : removed.error.message, removed.error.cliCode === undefined ? {} : { cliCode: removed.error.cliCode });
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

  /** A mutation that timed out may still have been applied; the outcome is reported as unknown, never as failed. */
  function viaSdkOutcome(action: ControlAction, result: ControlResult<ControlActionOutcome>): ControlResult<ControlActionOutcome> {
    if (result.ok || result.error.code === "outcome_unknown") return result;
    if (result.error.code !== "timeout" && result.error.cliCode !== "request_timeout") return result;
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
    async close() {
      closed = true;
      for (const timer of settling.values()) clearTimeout(timer);
      settling.clear();
      await Promise.all([...links.values()].map(async link => { await link.close(); }));
      links.clear();
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
      return linkFor(host).output(id, request);
    },
    showProject: (host, reference) => read(onHost(host, ["project", "show", reference]), raw => projectDetail(raw, "$.ok", host)),
    act,
  };
}
