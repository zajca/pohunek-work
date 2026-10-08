// Pohunek source: reads projects, sessions and notifications through the
// installed CLI with `--json`. Only argv arrays are used; the child inherits
// the caller's environment untouched.

import type { PohunekConfig } from "../types/config.ts";
import type {
  PohunekNotification,
  PohunekProject,
  PohunekSession,
  SourceErrorCode,
  SourceResult,
} from "../types/sources.ts";
import {
  exec as defaultExec,
  execInteractive as defaultExecInteractive,
  SpawnError,
  type Exec,
  type InteractiveExec,
} from "../util/exec.ts";

/** Protocol version this plugin speaks; must lie inside the CLI's [minimum, maximum]. */
export const SUPPORTED_PROTOCOL_VERSION = 4;

const SESSION_ENV = "POHUNEK_SESSION_ID";
const DAEMON_ENV = "POHUNEK_DAEMON_ID";
const NOTIFICATION_STATUSES = ["unread", "read"] as const;
/** Every lifecycle status pohunek defines; any other value is an invalid response. */
const KNOWN_NOTIFICATION_STATUSES: readonly string[] = ["unread", "read", "acknowledged", "archived", "deleted"];

export interface PohunekClientDeps {
  readonly exec?: Exec;
  readonly execInteractive?: InteractiveExec;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PohunekClient {
  listProjects(): Promise<SourceResult<readonly PohunekProject[]>>;
  listSessions(): Promise<SourceResult<readonly PohunekSession[]>>;
  /** Unread and read notifications of every kind; rules filter later. */
  listNotifications(): Promise<SourceResult<readonly PohunekNotification[]>>;
  /** Runs `pohunek session new` with `args` (without the `--json` flag) and returns the created session. */
  launchSession(request: LaunchRequest): Promise<SourceResult<LaunchedSession>>;
  /**
   * Runs `pohunek session wait <id> --activity working` once; the CLI blocks
   * until the session works or `timeoutMs` passes (core accepts 1..8000).
   * `execTimeoutMs` bounds the process itself.
   */
  waitSession(request: WaitRequest): Promise<SourceResult<WaitedSession>>;
  /** Git worktrees of one project as `project show` reports them, with their head commits. */
  listWorktrees(project: string): Promise<SourceResult<readonly PohunekWorktree[]>>;
  /** Runs `pohunek attach <id>` on the caller's terminal; resolves with its exit code when the owner detaches. */
  attach(sessionId: string): Promise<SourceResult<number | null>>;
  /** Runs `pohunek session stop <id>`. */
  stopSession(sessionId: string, timeoutMs: number): Promise<SourceResult<StoppedSession>>;
  /** Runs `pohunek session rm <id>`; never passes `--accept-unconfirmed-cleanup`. */
  removeSession(sessionId: string, timeoutMs: number): Promise<SourceResult<RemovedSession>>;
  /** Runs `pohunek session diff <id>`; only the size of the diff is kept. */
  diffSession(sessionId: string, timeoutMs: number): Promise<SourceResult<SessionDiff>>;
}

export interface StoppedSession {
  readonly stopped: boolean;
}

export interface RemovedSession {
  readonly removed: boolean;
  readonly stopped: boolean;
  readonly worktreesRemoved: number;
  readonly worktreesFailed: number;
  /** Processes pohunek could not confirm as ended; the plugin never accepts them. */
  readonly acceptedUnconfirmedProcesses: number;
}

export interface SessionDiff {
  readonly base: string;
  /** The daemon cut the diff, so it does not show every change. */
  readonly truncated: boolean;
  /** UTF-8 byte length of the diff text; the text itself is not kept. */
  readonly diffBytes: number;
}

export interface LaunchedSession {
  readonly session: PohunekSession;
  /**
   * Kinds of the daemon's launch warnings (for example `fetch`,
   * `base_branch_fallback`): the session was created, but not as requested.
   */
  readonly warnings: readonly string[];
  /**
   * Warnings of a lifecycle hook (`hook`, which also covers the `.pohunek/setup` fallback) or of the
   * reserved `setup_script` kind: the project's setup did not run to completion, so the session starts in
   * an unprovisioned worktree.
   */
  readonly setupFailures: readonly SetupFailure[];
}

/** Daemon-written text of one failed setup hook; core discards the hook's own output, so none of it is here. */
export interface SetupFailure {
  readonly kind: string;
  readonly message: string;
  readonly detail: string | null;
}

/** Warning kinds that mean the project's setup failed. */
export const SETUP_WARNING_KINDS: readonly string[] = ["hook", "setup_script"];

export interface WaitRequest {
  readonly sessionId: string;
  /** Wait budget handed to `session wait --timeout-ms`. */
  readonly timeoutMs: number;
  /** Longest time the pohunek process may run. */
  readonly execTimeoutMs: number;
}

export interface WaitedSession {
  /** `activity_matched` when the session reached the awaited activity, `timeout` when the wait budget ran out. */
  readonly reason: "activity_matched" | "timeout";
  /** The session as the daemon reports it when the wait ended. */
  readonly session: PohunekSession;
}

export interface PohunekWorktree {
  readonly path: string;
  /** Null for a detached head. */
  readonly branch: string | null;
  /** Full commit SHA of the worktree head. */
  readonly head: string;
  /** Session that owns the worktree; null for worktrees pohunek did not create. */
  readonly sessionId: string | null;
}

export interface LaunchRequest {
  /** Arguments after `session new`; `--json` is appended by the client. */
  readonly args: readonly string[];
  /** Initial text for the session, sent on stdin (`--input-stdin` must be in `args`). */
  readonly stdin: string;
  readonly timeoutMs: number;
}

/** A session is live when it runs and its runtime has not been lost. */
export function isLiveSession(session: PohunekSession): boolean {
  return session.state === "running" && session.runtimeState !== "lost";
}

/** Session metadata key that names what a session was started for (`implement`, `babysit`, ...). */
export const ROLE_KEY = "work.role";

/**
 * The worktree of an item, given its linked sessions: the session that owns
 * one, the implementing session first; null when none owns a worktree.
 */
export function worktreeOf(sessions: readonly PohunekSession[]): string | null {
  const owners = sessions.filter((s) => s.worktreePath !== null);
  const owner = owners.find((s) => s.metadata[ROLE_KEY] === "implement") ?? owners[0];
  return owner?.worktreePath ?? null;
}

const REPO_SEGMENT = "[A-Za-z0-9_.-]+";
const ORIGIN_PATTERNS: readonly RegExp[] = [
  new RegExp(`^git@github\\.com:(${REPO_SEGMENT})/(${REPO_SEGMENT}?)(?:\\.git)?/?$`),
  new RegExp(`^https://(?:[^@/]+@)?github\\.com/(${REPO_SEGMENT})/(${REPO_SEGMENT}?)(?:\\.git)?/?$`),
  new RegExp(`^ssh://git@github\\.com(?::\\d+)?/(${REPO_SEGMENT})/(${REPO_SEGMENT}?)(?:\\.git)?/?$`),
];

/** Extracts `owner/name` from a GitHub origin URL; null for any other form. */
export function parseOriginRepo(originUrl: string): string | null {
  for (const pattern of ORIGIN_PATTERNS) {
    const match = pattern.exec(originUrl.trim());
    const owner = match?.[1];
    const name = match?.[2];
    if (owner !== undefined && name !== undefined && name !== "" && name !== "." && name !== "..") {
      return `${owner}/${name}`;
    }
  }
  return null;
}

// ------------------------------------------------------------ validation

class InvalidResponse extends Error {}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, expected: string): never {
  throw new InvalidResponse(`${path}: expected ${expected}`);
}

function asObject(value: unknown, path: string): Json {
  return isObject(value) ? value : invalid(path, "an object");
}

function asArray(value: unknown, path: string): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : invalid(path, "an array");
}

function reqString(obj: Json, key: string, path: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : invalid(`${path}.${key}`, "a string");
}

function optString(obj: Json, key: string, path: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === "string" ? value : invalid(`${path}.${key}`, "a string");
}

function optArray(obj: Json, key: string, path: string): readonly unknown[] {
  const value = obj[key];
  return value === undefined || value === null ? [] : asArray(value, `${path}.${key}`);
}

function reqNumber(obj: Json, key: string, path: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : invalid(`${path}.${key}`, "a number");
}

function reqBoolean(obj: Json, key: string, path: string): boolean {
  const value = obj[key];
  return typeof value === "boolean" ? value : invalid(`${path}.${key}`, "a boolean");
}

function reqCount(obj: Json, key: string, path: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid(`${path}.${key}`, "a non-negative integer");
}

function parseSession(raw: unknown, path: string): PohunekSession {
  const obj = asObject(raw, path);
  const runtimeRaw = obj["runtime"];
  const runtimeState =
    runtimeRaw === undefined || runtimeRaw === null
      ? null
      : optString(asObject(runtimeRaw, `${path}.runtime`), "state", `${path}.runtime`);

  const metadata: Record<string, string> = {};
  const metadataRaw = obj["metadata"];
  if (metadataRaw !== undefined && metadataRaw !== null) {
    for (const [key, value] of Object.entries(asObject(metadataRaw, `${path}.metadata`))) {
      metadata[key] = typeof value === "string" ? value : invalid(`${path}.metadata.${key}`, "a string");
    }
  }

  return {
    id: reqString(obj, "id", path),
    name: optString(obj, "name", path),
    projectLabel: optString(obj, "project_label", path),
    branch: optString(obj, "branch", path),
    worktreePath: optString(obj, "worktree_path", path),
    cwd: optString(obj, "cwd", path),
    state: reqString(obj, "state", path),
    activity: optString(obj, "activity", path),
    runtimeState,
    updatedAt: optString(obj, "updated_at", path),
    metadata,
  };
}

/** Only the warning kinds are kept: their messages quote branch names, which can be provider text. */
function parseLaunchWarnings(obj: Json, path: string): string[] {
  const raw = obj["warnings"];
  if (raw === undefined || raw === null) {
    return [];
  }
  return asArray(raw, `${path}.warnings`).map((entry, index) =>
    reqString(asObject(entry, `${path}.warnings[${String(index)}]`), "kind", `${path}.warnings[${String(index)}]`),
  );
}

function parseSetupFailures(obj: Json, path: string): SetupFailure[] {
  const raw = obj["warnings"];
  if (raw === undefined || raw === null) {
    return [];
  }
  return asArray(raw, `${path}.warnings`).flatMap((entry, index) => {
    const warningPath = `${path}.warnings[${String(index)}]`;
    const warning = asObject(entry, warningPath);
    const kind = reqString(warning, "kind", warningPath);
    if (!SETUP_WARNING_KINDS.includes(kind)) {
      return [];
    }
    return [{ kind, message: reqString(warning, "message", warningPath), detail: optString(warning, "detail", warningPath) }];
  });
}

function parseWorktree(raw: unknown, path: string): PohunekWorktree {
  const obj = asObject(raw, path);
  return {
    path: reqString(obj, "path", path),
    branch: optString(obj, "branch", path),
    head: reqString(obj, "head", path),
    sessionId: optString(obj, "session_id", path),
  };
}

function parseProject(raw: unknown, path: string): PohunekProject {
  const obj = asObject(raw, path);
  return {
    id: reqString(obj, "id", path),
    label: reqString(obj, "label", path),
    originUrl: optString(obj, "origin_url", path),
    defaultBaseBranch: optString(obj, "default_base_branch", path),
  };
}

/** An entry without kind or status is an invalid response: skipping it could hide a blocked agent. */
function parseNotification(raw: unknown, path: string): PohunekNotification {
  const obj = asObject(raw, path);
  const kind = obj["kind"];
  const status = obj["status"];
  if (typeof kind !== "string") {
    return invalid(`${path}.kind`, "a string");
  }
  if (typeof status !== "string") {
    return invalid(`${path}.status`, "a string");
  }
  if (!KNOWN_NOTIFICATION_STATUSES.includes(status)) {
    return invalid(`${path}.status`, `one of ${KNOWN_NOTIFICATION_STATUSES.join(", ")}`);
  }
  return {
    id: reqString(obj, "id", path),
    kind,
    status: status as PohunekNotification["status"],
    sessionId: optString(obj, "session_id", path),
    createdAt: reqString(obj, "created_at", path),
  };
}

// --------------------------------------------------------------- runner

interface Failure {
  readonly code: SourceErrorCode;
  readonly message: string;
}

type RunOutcome = { readonly ok: true; readonly payload: unknown } | { readonly ok: false; readonly failure: Failure };

function fail(code: SourceErrorCode, message: string): { readonly ok: false; readonly failure: Failure } {
  return { ok: false, failure: { code, message } };
}

function parseEnvelope(stdout: string, exitCode: number | null): RunOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail(
      "invalid_response",
      exitCode === 0
        ? "pohunek stdout is not valid JSON"
        : `pohunek exited with code ${String(exitCode)} and stdout is not valid JSON`,
    );
  }

  try {
    const envelope = asObject(parsed, "$");
    reqString(envelope, "cli_version", "$");
    const protocol = asObject(envelope["protocol"], "$.protocol");
    const minimum = reqNumber(protocol, "minimum", "$.protocol");
    const maximum = reqNumber(protocol, "maximum", "$.protocol");
    const hasOk = "ok" in envelope;
    const hasErr = "err" in envelope;
    if (hasOk === hasErr) {
      return invalid("$", "exactly one of ok and err");
    }
    if (SUPPORTED_PROTOCOL_VERSION < minimum || SUPPORTED_PROTOCOL_VERSION > maximum) {
      return fail(
        "protocol_mismatch",
        `plugin supports protocol ${String(SUPPORTED_PROTOCOL_VERSION)}, pohunek offers ${String(minimum)}-${String(maximum)}`,
      );
    }
    if (hasErr) {
      return mapErr(asObject(envelope["err"], "$.err"));
    }
    if (exitCode !== 0) {
      return fail("invalid_response", `pohunek exited with code ${String(exitCode)} but reported ok`);
    }
    return { ok: true, payload: envelope["ok"] };
  } catch (error) {
    if (error instanceof InvalidResponse) {
      return fail("invalid_response", error.message);
    }
    throw error;
  }
}

function mapErr(err: Json): RunOutcome {
  const code = reqString(err, "code", "$.err");
  if (code === "incomplete_origin_environment") {
    return fail(
      "origin_environment",
      `pohunek rejected the environment (${code}): set both ${SESSION_ENV} and ${DAEMON_ENV}, or unset both; the plugin did not change them`,
    );
  }
  // The CLI gave up waiting while the daemon may still finish the request.
  if (code === "request_timeout") {
    return fail("timeout", `pohunek error ${code}`);
  }
  const errClass = typeof err["class"] === "string" ? err["class"] : "unknown";
  return fail("unavailable", `pohunek error ${code} (class ${errClass})`);
}

export function createPohunekClient(config: PohunekConfig, deps: PohunekClientDeps = {}): PohunekClient {
  const run = deps.exec ?? defaultExec;
  const runInteractive = deps.execInteractive ?? defaultExecInteractive;
  const env = deps.env ?? process.env;

  function checkOrigin(): Failure | null {
    const hasSession = env[SESSION_ENV] !== undefined;
    const hasDaemon = env[DAEMON_ENV] !== undefined;
    if (hasSession === hasDaemon) {
      return null;
    }
    const present = hasSession ? SESSION_ENV : DAEMON_ENV;
    const missing = hasSession ? DAEMON_ENV : SESSION_ENV;
    return {
      code: "origin_environment",
      message: `only ${present} is set; ${missing} is missing. Set both ${SESSION_ENV} and ${DAEMON_ENV}, or unset both. Nothing was unset by the plugin.`,
    };
  }

  async function call(
    args: readonly string[],
    options: { readonly stdin?: string; readonly timeoutMs?: number } = {},
  ): Promise<RunOutcome> {
    const timeoutMs = options.timeoutMs ?? config.timeoutMs;
    let result;
    try {
      result = await run([config.bin, ...args], {
        timeoutMs,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
    } catch (error) {
      if (error instanceof SpawnError) {
        return fail("unavailable", `cannot start ${config.bin}`);
      }
      throw error;
    }
    if (result.timedOut) {
      return fail("timeout", `pohunek did not answer within ${String(timeoutMs)} ms`);
    }
    return parseEnvelope(result.stdout, result.exitCode);
  }

  async function wrap<T>(body: () => Promise<{ ok: true; data: T } | { ok: false; failure: Failure }>): Promise<SourceResult<T>> {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    const origin = checkOrigin();
    if (origin !== null) {
      return { ok: false, source: "pohunek", ...origin, durationMs: elapsed() };
    }
    try {
      const outcome = await body();
      if (outcome.ok) {
        return { ok: true, source: "pohunek", data: outcome.data, durationMs: elapsed() };
      }
      return { ok: false, source: "pohunek", ...outcome.failure, durationMs: elapsed() };
    } catch (error) {
      if (error instanceof InvalidResponse) {
        return { ok: false, source: "pohunek", code: "invalid_response", message: error.message, durationMs: elapsed() };
      }
      throw error;
    }
  }

  async function listArray<T>(
    args: readonly string[],
    parse: (raw: unknown, path: string) => T,
  ): Promise<SourceResult<readonly T[]>> {
    return wrap(async () => {
      const outcome = await call(args);
      if (!outcome.ok) {
        return outcome;
      }
      const items = asArray(outcome.payload, "$.ok").map((raw, index) => parse(raw, `$.ok[${String(index)}]`));
      return { ok: true, data: items };
    });
  }

  return {
    listProjects: () => listArray(["project", "list", "--json"], parseProject),
    listSessions: () => listArray(["session", "list", "--json"], parseSession),
    launchSession: (request) =>
      wrap(async () => {
        const outcome = await call(["session", "new", ...request.args, "--json"], {
          stdin: request.stdin,
          timeoutMs: request.timeoutMs,
        });
        if (!outcome.ok) {
          return outcome;
        }
        const session = parseSession(outcome.payload, "$.ok");
        const payload = asObject(outcome.payload, "$.ok");
        return { ok: true, data: { session, warnings: parseLaunchWarnings(payload, "$.ok"), setupFailures: parseSetupFailures(payload, "$.ok") } };
      }),
    waitSession: (request) =>
      wrap(async () => {
        const outcome = await call(
          ["session", "wait", request.sessionId, "--activity", "working", "--timeout-ms", String(request.timeoutMs), "--json"],
          { timeoutMs: request.execTimeoutMs },
        );
        if (!outcome.ok) {
          return outcome;
        }
        const payload = asObject(outcome.payload, "$.ok");
        const reason = payload["reason"];
        if (reason !== "activity_matched" && reason !== "timeout") {
          return invalid("$.ok.reason", "activity_matched or timeout");
        }
        return { ok: true, data: { reason, session: parseSession(payload["session"], "$.ok.session") } };
      }),
    listWorktrees: (project) =>
      wrap(async () => {
        const outcome = await call(["project", "show", project, "--json"]);
        if (!outcome.ok) {
          return outcome;
        }
        const payload = asObject(outcome.payload, "$.ok");
        const worktrees = asArray(payload["worktrees"], "$.ok.worktrees").map((raw, index) =>
          parseWorktree(raw, `$.ok.worktrees[${String(index)}]`),
        );
        return { ok: true, data: worktrees };
      }),
    attach: (sessionId) =>
      wrap(async () => {
        try {
          return { ok: true, data: await runInteractive([config.bin, "attach", sessionId]) };
        } catch (error) {
          if (error instanceof SpawnError) {
            return fail("unavailable", `cannot start ${config.bin}`);
          }
          throw error;
        }
      }),
    stopSession: (sessionId, timeoutMs) =>
      wrap(async () => {
        const outcome = await call(["session", "stop", sessionId, "--json"], { timeoutMs });
        if (!outcome.ok) {
          return outcome;
        }
        return { ok: true, data: { stopped: reqBoolean(asObject(outcome.payload, "$.ok"), "stopped", "$.ok") } };
      }),
    removeSession: (sessionId, timeoutMs) =>
      wrap(async () => {
        const outcome = await call(["session", "rm", sessionId, "--json"], { timeoutMs });
        if (!outcome.ok) {
          return outcome;
        }
        const payload = asObject(outcome.payload, "$.ok");
        return {
          ok: true,
          data: {
            removed: reqBoolean(payload, "removed", "$.ok"),
            stopped: reqBoolean(payload, "stopped", "$.ok"),
            worktreesRemoved: reqCount(payload, "worktrees_removed", "$.ok"),
            worktreesFailed: reqCount(payload, "worktrees_failed", "$.ok"),
            // pohunek omits the field when no process was accepted.
            acceptedUnconfirmedProcesses: optArray(payload, "accepted_unconfirmed_processes", "$.ok").length,
          },
        };
      }),
    diffSession: (sessionId, timeoutMs) =>
      wrap(async () => {
        const outcome = await call(["session", "diff", sessionId, "--json"], { timeoutMs });
        if (!outcome.ok) {
          return outcome;
        }
        const payload = asObject(outcome.payload, "$.ok");
        return {
          ok: true,
          data: {
            base: reqString(payload, "base", "$.ok"),
            truncated: reqBoolean(payload, "truncated", "$.ok"),
            diffBytes: new TextEncoder().encode(reqString(payload, "diff", "$.ok")).length,
          },
        };
      }),
    listNotifications: () =>
      wrap(async () => {
        const collected: PohunekNotification[] = [];
        for (const status of NOTIFICATION_STATUSES) {
          const seen = new Set<string>();
          let cursor: string | null = null;
          do {
            const args = [
              "notifications", "list", "--json",
              "--limit", String(config.notificationsPageSize),
              "--status", status,
              ...(cursor === null ? [] : ["--cursor", cursor]),
            ];
            const outcome = await call(args);
            if (!outcome.ok) {
              return outcome;
            }
            const page = asObject(outcome.payload, "$.ok");
            const entries = asArray(page["notifications"], "$.ok.notifications");
            entries.forEach((raw, index) => {
              collected.push(parseNotification(raw, `$.ok.notifications[${String(index)}]`));
            });
            const next = page["next_cursor"];
            if (next === undefined || next === null) {
              cursor = null;
            } else if (typeof next !== "string" || next === "") {
              return invalid("$.ok.next_cursor", "a non-empty string");
            } else if (seen.has(next)) {
              return fail("invalid_response", "pohunek returned a repeated notifications cursor");
            } else {
              seen.add(next);
              cursor = next;
            }
          } while (cursor !== null);
        }
        return { ok: true, data: collected };
      }),
  };
}
