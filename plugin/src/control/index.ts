import { exec, SpawnError } from "../util/exec.ts";
import {
  InvalidControlResponse, array, boolean, capabilities, count, governance, host as parseHost,
  notification, object, project, projectDetail, screen, session, string,
} from "./decode.ts";
import type {
  ControlAction, ControlActionOutcome, ControlClient, ControlClientOptions, ControlError,
  ControlHost, ControlNotification, ControlProject, ControlResult, ControlSession, ControlSnapshot, ControlSnapshotError,
} from "./types.ts";

export type * from "./types.ts";

const PROTOCOL_VERSION = 4;
const ACTIVE_NOTIFICATION_STATUSES = ["unread", "read"] as const;
const LOCAL_HOST: ControlHost = { route: "local", dialable: true, name: "Local", classification: "local", daemonVersion: null, address: null };

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

function originError(): ControlError | null {
  const session = process.env["POHUNEK_SESSION_ID"] !== undefined;
  const daemon = process.env["POHUNEK_DAEMON_ID"] !== undefined;
  return session === daemon ? null : {
    code: "origin_environment",
    message: "Set both POHUNEK_SESSION_ID and POHUNEK_DAEMON_ID, or unset both.",
  };
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
      !Number.isSafeInteger(options.notificationsPageSize) || options.notificationsPageSize < 1) {
    throw new TypeError("control client requires binary, positive timeoutMs and positive notificationsPageSize");
  }

  async function call(args: readonly string[]): Promise<ControlResult<unknown>> {
    const invalidOrigin = originError();
    if (invalidOrigin !== null) { return { ok: false, error: invalidOrigin }; }
    try {
      const result = await exec([options.binary, ...args], { timeoutMs: options.timeoutMs });
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
  const sessionList = (host: string): Promise<ControlResult<readonly ControlSession[]>> => read(onHost(host, ["session", "list"]), raw =>
    array(raw, "$.ok").map((item, index) => session(item, `$.ok[${String(index)}]`, host)));
  const projectList = (host: string): Promise<ControlResult<readonly ControlProject[]>> => read(onHost(host, ["project", "list"]), raw =>
    array(raw, "$.ok").map((item, index) => project(item, `$.ok[${String(index)}]`, host)));

  async function notificationList(host: string): Promise<ControlResult<readonly ControlNotification[]>> {
    const records: ControlNotification[] = [];
    for (const status of ACTIVE_NOTIFICATION_STATUSES) {
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const args = onHost(host, ["notifications", "list", "--limit", String(options.notificationsPageSize), "--status", status,
          ...(cursor === null ? [] : ["--cursor", cursor])]);
        const page = await read(args, raw => {
          const obj = object(raw, "$.ok");
          const items = array(obj["notifications"], "$.ok.notifications")
            .map((item, index) => notification(item, `$.ok.notifications[${String(index)}]`, host));
          const next = obj["next_cursor"];
          if (next !== undefined && next !== null && (typeof next !== "string" || next === "")) {
            throw new InvalidControlResponse("$.ok.next_cursor: expected a non-empty string");
          }
          return { items, next };
        });
        if (!page.ok) { return page; }
        records.push(...page.data.items);
        cursor = page.data.next ?? null;
        if (cursor !== null && seen.has(cursor)) { return failure("invalid_response", "pohunek returned a repeated notifications cursor"); }
        if (cursor !== null) { seen.add(cursor); }
      } while (cursor !== null);
    }
    return { ok: true, data: records };
  }

  async function refresh(): Promise<ControlSnapshot> {
    const hosts: ControlHost[] = [LOCAL_HOST];
    const errors: ControlSnapshotError[] = [];
    const discovered = await read(["host", "discover", "--json"], raw =>
      array(raw, "$.ok").map((item, index) => parseHost(item, `$.ok[${String(index)}]`)));
    if (discovered.ok) { hosts.push(...discovered.data); }
    else { errors.push({ host: "local", scope: "discovery", error: discovered.error }); }

    const targets = hosts.filter(item => item.classification === "local" || item.classification === "reachable_daemon");
    const rows = await Promise.all(targets.map(async target => {
      const [sessions, projects, notifications] = await Promise.all([
        sessionList(target.route), projectList(target.route), notificationList(target.route),
      ]);
      return { target, sessions, projects, notifications };
    }));
    const sessions: ControlSnapshot["sessions"][number][] = [];
    const projects: ControlSnapshot["projects"][number][] = [];
    const notifications: ControlNotification[] = [];
    for (const row of rows) {
      if (row.sessions.ok) { sessions.push(...row.sessions.data); }
      else { errors.push({ host: row.target.route, scope: "sessions", error: row.sessions.error }); }
      if (row.projects.ok) { projects.push(...row.projects.data); }
      else { errors.push({ host: row.target.route, scope: "projects", error: row.projects.error }); }
      if (row.notifications.ok) { notifications.push(...row.notifications.data); }
      else { errors.push({ host: row.target.route, scope: "notifications", error: row.notifications.error }); }
    }
    return { hosts, sessions, projects, notifications, errors };
  }

  async function act(action: ControlAction): Promise<ControlResult<ControlActionOutcome>> {
    const host = action.host;
    if (host.startsWith("undialable:")) { return failure("unavailable", "the selected host has no dialable identity"); }
    const invalidTarget = bareIdError("sessionId" in action ? action.sessionId : action.notificationId);
    if (invalidTarget !== null) { return { ok: false, error: invalidTarget }; }
    switch (action.kind) {
      case "stop": return read(onHost(host, ["session", "stop", action.sessionId]), raw =>
        ({ kind: "stop", stopped: boolean(object(raw, "$.ok"), "stopped", "$.ok") }));
      case "remove": return read(onHost(host, ["session", "rm", action.sessionId]), raw => {
        const obj = object(raw, "$.ok");
        return { kind: "remove", removed: boolean(obj, "removed", "$.ok"), stopped: boolean(obj, "stopped", "$.ok"),
          worktreesRemoved: count(obj, "worktrees_removed", "$.ok"), worktreesFailed: count(obj, "worktrees_failed", "$.ok") };
      });
      case "resume": return read(onHost(host, ["session", "resume", action.sessionId]), raw =>
        ({ kind: "resume", session: session(object(raw, "$.ok")["session"], "$.ok.session", host) }));
      case "rename": return read(action.name === null
        ? onHost(host, ["session", "rename", action.sessionId, "--clear"])
        : ["--host", host, "session", "rename", action.sessionId, "--json", "--", action.name], raw =>
        ({ kind: "rename", session: session(object(raw, "$.ok")["session"], "$.ok.session", host) }));
      case "fork": return read(onHost(host, ["session", "fork", action.sessionId,
        ...(action.name === undefined ? [] : [`--name=${action.name}`])]), raw =>
        ({ kind: "fork", session: session(raw, "$.ok", host) }));
      case "metadata": {
        const set = Object.entries(action.set ?? {});
        const clear = action.clear ?? [];
        if (set.length === 0 && clear.length === 0) {
          return failure("command_failed", "metadata action requires at least one set or clear entry");
        }
        if (set.some(([key]) => key === "" || key.includes("=")) || clear.some(key => key === "" || key.includes("="))) {
          return failure("command_failed", "metadata keys must be non-empty and cannot contain '='");
        }
        const args = ["session", "metadata", action.sessionId,
          ...set.map(([key, value]) => `--set=${key}=${value}`), ...clear.map(key => `--clear=${key}`)];
        return read(onHost(host, args), raw =>
          ({ kind: "metadata", session: session(object(raw, "$.ok")["session"], "$.ok.session", host) }));
      }
      case "read": case "ack": case "archive": return read(onHost(host, ["notifications", action.kind, action.notificationId]), raw =>
        ({ kind: action.kind, notification: notification(object(raw, "$.ok")["record"], "$.ok.record", host) }));
    }
  }

  return {
    refresh,
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
    showProject: (host, reference) => read(onHost(host, ["project", "show", reference]), raw => projectDetail(raw, "$.ok", host)),
    act,
  };
}
