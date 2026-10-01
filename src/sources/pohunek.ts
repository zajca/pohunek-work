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
import { exec as defaultExec, SpawnError, type Exec } from "../util/exec.ts";

/** Protocol version this plugin speaks; must lie inside the CLI's [minimum, maximum]. */
export const SUPPORTED_PROTOCOL_VERSION = 3;

const SESSION_ENV = "POHUNEK_SESSION_ID";
const DAEMON_ENV = "POHUNEK_DAEMON_ID";
const NOTIFICATION_STATUSES = ["unread", "read"] as const;

export interface PohunekClientDeps {
  readonly exec?: Exec;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PohunekClient {
  listProjects(): Promise<SourceResult<readonly PohunekProject[]>>;
  listSessions(): Promise<SourceResult<readonly PohunekSession[]>>;
  /** Unread and read notifications of every kind; rules filter later. */
  listNotifications(): Promise<SourceResult<readonly PohunekNotification[]>>;
}

/** A session is live when it runs and its runtime has not been lost. */
export function isLiveSession(session: PohunekSession): boolean {
  return session.state === "running" && session.runtimeState !== "lost";
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

function reqNumber(obj: Json, key: string, path: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : invalid(`${path}.${key}`, "a number");
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
    state: reqString(obj, "state", path),
    activity: optString(obj, "activity", path),
    runtimeState,
    metadata,
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
  const errClass = typeof err["class"] === "string" ? err["class"] : "unknown";
  return fail("unavailable", `pohunek error ${code} (class ${errClass})`);
}

export function createPohunekClient(config: PohunekConfig, deps: PohunekClientDeps = {}): PohunekClient {
  const run = deps.exec ?? defaultExec;
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

  async function call(args: readonly string[]): Promise<RunOutcome> {
    let result;
    try {
      result = await run([config.bin, ...args], { timeoutMs: config.timeoutMs });
    } catch (error) {
      if (error instanceof SpawnError) {
        return fail("unavailable", `cannot start ${config.bin}`);
      }
      throw error;
    }
    if (result.timedOut) {
      return fail("timeout", `pohunek did not answer within ${String(config.timeoutMs)} ms`);
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
