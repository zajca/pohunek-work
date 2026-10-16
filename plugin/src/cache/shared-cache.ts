// Shared cache of provider source results in the state directory. Every local process (`list`, the TUI's
// list child, `watch`, sessions that run `list`) reads through it: a result read from the provider is served
// for `[cache] max_age_secs` to all of them, one process fetches while the others wait for that fetch and take
// its outcome, a failed refresh keeps the last good data marked stale, and a rate-limit response stops every
// process from asking the provider until its reset.
//
// The state lives in `<state>/cache/cache.sqlite` (WAL, mode 0600): `entries` holds the last good result and the
// last failed attempt of each key, `inflight` the fetch that holds a key (owner pid, token, heartbeat), and
// `backoffs` the instant before which a provider is not asked. Every decision and every write is one
// `BEGIN IMMEDIATE` transaction, so a read, a claim, a takeover or a store never interleaves with another
// process's. The owner refreshes its heartbeat while its fetch runs; a fetch whose owner is gone or whose
// heartbeat is older than `lock_timeout_ms` may be taken over. Concurrent readers of a key share one fetch.

import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CacheConfig } from "../types/config.ts";
import type { SourceErrorCode, SourceName, SourceResult } from "../types/sources.ts";

/** Owner read and write only: the cache holds GitHub and Linear data about the owner's work. */
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const CACHE_SUBDIRECTORY = "cache";
const DATABASE_FILE = "cache.sqlite";
const SALT_FILE = "identity.salt";
/** Files SQLite keeps beside the database in WAL mode; they receive the same mode once they exist. */
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  cache_key TEXT PRIMARY KEY,
  fetched_at_ms INTEGER,
  value TEXT,
  failed_started_at_ms INTEGER,
  failed_code TEXT,
  failed_message TEXT,
  failed_retry_at_ms INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS inflight (
  cache_key TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  token TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  heartbeat_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS backoffs (
  provider TEXT PRIMARY KEY,
  until_ms INTEGER NOT NULL
) STRICT;
`;

export interface CacheRequest<T> {
  /** Provider whose back-off applies to the result, e.g. `github` or `linear`. */
  readonly provider: string;
  /** Source name the result is reported under. */
  readonly source: SourceName;
  /** Identifies the result: every input that changes what the provider returns belongs in it. */
  readonly key: string;
  /** Reads the result from the provider; the cache calls it at most once per fetch. */
  readonly fetch: () => Promise<SourceResult<T>>;
  /** Serializes the data for the store. */
  readonly encode: (data: T) => unknown;
  /** Restores the data; null when the stored shape is not the one `encode` writes. */
  readonly decode: (raw: unknown) => T | null;
}

export interface SharedCache {
  /**
   * The result for `request`: the stored data when it is fresh, the outcome of a fetch that was in flight when
   * the call arrived, or a new fetch made by this call. `refresh` bypasses the max age but still joins a fetch in flight.
   */
  read<T>(request: CacheRequest<T>): Promise<SourceResult<T>>;
  /**
   * Opaque identity of the account a credential belongs to, for a cache key. It is an HMAC of the credential under a
   * random salt kept in the cache directory, so the store holds neither the credential nor an unsalted digest of it.
   * Computed locally; no provider is asked.
   */
  identityOf(credential: string): Promise<string>;
}

export interface SharedCacheOptions {
  /** Directory of the state; the cache lives in a subdirectory of it. */
  readonly stateDir: string;
  readonly config: CacheConfig;
  /** Bypasses the max age for this call; the call still joins a fetch that is in flight. */
  readonly refresh: boolean;
  /** Clock; the system clock when absent. */
  readonly now?: () => number;
}

interface StoredSuccess {
  readonly fetchedAtMs: number;
  readonly value: unknown;
}

interface StoredFailure {
  readonly startedAtMs: number;
  readonly code: SourceErrorCode;
  readonly message: string;
  readonly retryAtMs: number | null;
}

interface Stored {
  readonly success: StoredSuccess | null;
  readonly failure: StoredFailure | null;
}

interface InflightRow {
  readonly ownerPid: number;
  readonly token: string;
  readonly startedAtMs: number;
  readonly heartbeatMs: number;
}

/** What one decision transaction tells the caller to do. */
type Decision<T> =
  | { readonly kind: "served"; readonly result: SourceResult<T> }
  | { readonly kind: "wait"; readonly attemptStartedAtMs: number }
  | { readonly kind: "claim"; readonly token: string; readonly startedAtMs: number };

interface EntryRow {
  readonly fetched_at_ms: number | null;
  readonly value: string | null;
  readonly failed_started_at_ms: number | null;
  readonly failed_code: string | null;
  readonly failed_message: string | null;
  readonly failed_retry_at_ms: number | null;
}

interface InflightDbRow {
  readonly owner_pid: number;
  readonly token: string;
  readonly started_at_ms: number;
  readonly heartbeat_ms: number;
}

export function createSharedCache(options: SharedCacheOptions): SharedCache {
  const now = options.now ?? Date.now;
  const { config } = options;
  let store: Promise<Store> | null = null;

  /** One store per cache object: the database is opened on first use and shared by its reads. */
  function openStore(): Promise<Store> {
    // A failed open is not kept: the next read opens the database again.
    store ??= Store.open(join(options.stateDir, CACHE_SUBDIRECTORY), config).catch((error: unknown) => {
      store = null;
      throw error;
    });
    return store;
  }

  let salt: Promise<string> | null = null;
  function loadSalt(): Promise<string> {
    salt ??= readOrCreateSalt(join(options.stateDir, CACHE_SUBDIRECTORY)).catch((error: unknown) => {
      salt = null;
      throw error;
    });
    return salt;
  }

  return {
    async identityOf(credential: string): Promise<string> {
      const key = await loadSalt();
      return createHmac("sha256", key).update(credential).digest("hex").slice(0, IDENTITY_HEX_LENGTH);
    },

    async read<T>(request: CacheRequest<T>): Promise<SourceResult<T>> {
      const requestedAtMs = now();
      let db: Store;
      try {
        db = await openStore();
      } catch (error) {
        if (isBusy(error)) return busyFailure(request.source, now());
        throw error;
      }
      const keyDigest = digest(request.key);
      let waitingFor: number | null = null;
      for (;;) {
        let decision: Decision<T>;
        try {
          decision = db.decide(request, { keyDigest, requestedAtMs, waitingFor, refresh: options.refresh, now, config });
        } catch (error) {
          if (isBusy(error)) return busyFailure(request.source, now());
          throw error;
        }
        if (decision.kind === "served") return decision.result;
        if (decision.kind === "wait") {
          waitingFor = decision.attemptStartedAtMs;
          await new Promise((resolve) => setTimeout(resolve, config.lockPollMs));
          continue;
        }
        return fetchAndStore(request, db, keyDigest, decision.token, decision.startedAtMs, config, now);
      }
    },
  };
}

/** Runs the provider read this process claimed, keeps its heartbeat alive, and stores the outcome. */
async function fetchAndStore<T>(
  request: CacheRequest<T>,
  db: Store,
  keyDigest: string,
  token: string,
  startedAtMs: number,
  config: CacheConfig,
  now: () => number,
): Promise<SourceResult<T>> {
  const timer = setInterval(() => {
    db.heartbeat(keyDigest, token, now());
  }, config.lockPollMs);
  try {
    const answer = await request.fetch();
    // A rate limit that names no reset is retried after the fallback, and that instant is what the caller reports.
    const result = !answer.ok && answer.code === "rate_limited" && answer.retryAtMs === undefined
      ? { ...answer, retryAtMs: now() + config.fallbackBackoffMs }
      : answer;
    try {
      if (!result.ok && result.code === "rate_limited" && result.retryAtMs !== undefined) {
        db.recordBackoff(request.provider, result.retryAtMs);
      }
      return db.complete(request, { keyDigest, token, startedAtMs, result });
    } catch (error) {
      // The provider answered but the store stayed busy: the caller gets the answer; the next read fetches again.
      if (!isBusy(error)) throw error;
      return result.ok ? { ...result, fetchedAtMs: startedAtMs } : result;
    }
  } finally {
    clearInterval(timer);
    db.release(keyDigest, token);
  }
}

/** Every database operation of the cache; each method is one transaction, so no await happens inside one. */
class Store {
  private readonly db: Database;
  private readonly statements: {
    readonly entry: ReturnType<Database["query"]>;
    readonly inflight: ReturnType<Database["query"]>;
    readonly backoff: ReturnType<Database["query"]>;
  };

  private constructor(db: Database) {
    this.db = db;
    this.statements = {
      entry: db.query("SELECT fetched_at_ms, value, failed_started_at_ms, failed_code, failed_message, failed_retry_at_ms FROM entries WHERE cache_key = ?"),
      inflight: db.query("SELECT owner_pid, token, started_at_ms, heartbeat_ms FROM inflight WHERE cache_key = ?"),
      backoff: db.query("SELECT until_ms FROM backoffs WHERE provider = ?"),
    };
  }

  /**
   * Creates the directory and the file with mode 0600 before SQLite opens them, then enables WAL and the schema.
   * The first switch to WAL and the schema can report a lock without waiting on busy_timeout, so a busy open is
   * retried every `lock_poll_ms` until the busy budget is spent.
   */
  static async open(directory: string, config: CacheConfig): Promise<Store> {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    const file = join(directory, DATABASE_FILE);
    const handle = await open(file, "a", FILE_MODE);
    await handle.close();
    await chmod(file, FILE_MODE);
    const deadline = Date.now() + config.busyTimeoutMs;
    for (;;) {
      try {
        const store = new Store(openDatabase(file, config.busyTimeoutMs));
        await chmodSidecars(file);
        return store;
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, config.lockPollMs));
      }
    }
  }

  /** One transaction: the decision for the caller, including the claim of the key when it fetches. */
  decide<T>(
    request: CacheRequest<T>,
    input: {
      readonly keyDigest: string;
      readonly requestedAtMs: number;
      readonly waitingFor: number | null;
      readonly refresh: boolean;
      readonly now: () => number;
      readonly config: CacheConfig;
    },
  ): Decision<T> {
    return this.db.transaction((): Decision<T> => {
      const t = input.now();
      const stored = this.readStored(input.keyDigest);
      const inflight = this.readInflight(input.keyDigest);
      const liveFetch = inflight !== null && isLive(inflight, t, input.config.lockTimeoutMs) ? inflight : null;
      if (input.waitingFor !== null) {
        if (liveFetch !== null && liveFetch.startedAtMs === input.waitingFor) {
          return { kind: "wait", attemptStartedAtMs: input.waitingFor };
        }
        const outcome = outcomeOfAttempt(request, stored, input.waitingFor);
        if (outcome !== null) return { kind: "served", result: outcome };
      }
      const good = lastGood(request, stored);
      if (!input.refresh && good !== null && t - good.fetchedAtMs < input.config.maxAgeMs) {
        return { kind: "served", result: successOf(request, good) };
      }
      if (liveFetch !== null) return { kind: "wait", attemptStartedAtMs: liveFetch.startedAtMs };
      if (stored.failure !== null && stored.failure.startedAtMs >= input.requestedAtMs) {
        return { kind: "served", result: failureOf(request, stored.failure, good) };
      }
      const blockedUntil = this.readBackoff(request.provider);
      if (blockedUntil !== null && blockedUntil > t) {
        return { kind: "served", result: failureOf(request, backoffFailure(blockedUntil), good) };
      }
      // No live fetch holds the key here, so any row left is abandoned and this claim replaces it.
      const token = randomBytes(16).toString("hex");
      this.db
        .query("INSERT OR REPLACE INTO inflight (cache_key, owner_pid, token, started_at_ms, heartbeat_ms) VALUES (?, ?, ?, ?, ?)")
        .run(input.keyDigest, process.pid, token, t, t);
      return { kind: "claim", token, startedAtMs: t };
    }).immediate();
  }

  heartbeat(keyDigest: string, token: string, atMs: number): void {
    try {
      this.db.query("UPDATE inflight SET heartbeat_ms = ? WHERE cache_key = ? AND token = ?").run(atMs, keyDigest, token);
    } catch (error) {
      // A missed heartbeat lets the lock expire; it must not end the fetch it guards.
      if (!isBusy(error)) throw error;
    }
  }

  recordBackoff(provider: string, untilMs: number): void {
    // Own transaction, and the later reset wins: a late rate limit still blocks until its reset.
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO backoffs (provider, until_ms) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET until_ms = MAX(until_ms, excluded.until_ms)")
        .run(provider, untilMs);
    }).immediate();
  }

  /**
   * Stores the outcome of a fetch and releases its claim in one transaction. A success replaces the stored one
   * only when its fetch started after it; a failure is stored only when it started after the stored success
   * and after the stored failure. Returns the outcome the caller reports.
   */
  complete<T>(
    request: CacheRequest<T>,
    input: { readonly keyDigest: string; readonly token: string; readonly startedAtMs: number; readonly result: SourceResult<T> },
  ): SourceResult<T> {
    return this.db.transaction((): SourceResult<T> => {
      const { result, startedAtMs, keyDigest } = input;
      if (result.ok) {
        this.db
          .query(
            `INSERT INTO entries (cache_key, fetched_at_ms, value, failed_started_at_ms, failed_code, failed_message, failed_retry_at_ms)
             VALUES (?, ?, ?, NULL, NULL, NULL, NULL)
             ON CONFLICT(cache_key) DO UPDATE SET
               fetched_at_ms = excluded.fetched_at_ms, value = excluded.value,
               failed_started_at_ms = NULL, failed_code = NULL, failed_message = NULL, failed_retry_at_ms = NULL
             WHERE (entries.fetched_at_ms IS NULL OR excluded.fetched_at_ms > entries.fetched_at_ms)
               AND (entries.failed_started_at_ms IS NULL OR excluded.fetched_at_ms > entries.failed_started_at_ms)`,
          )
          .run(keyDigest, startedAtMs, JSON.stringify(request.encode(result.data)));
      } else {
        this.db
          .query(
            `INSERT INTO entries (cache_key, fetched_at_ms, value, failed_started_at_ms, failed_code, failed_message, failed_retry_at_ms)
             VALUES (?, NULL, NULL, ?, ?, ?, ?)
             ON CONFLICT(cache_key) DO UPDATE SET
               failed_started_at_ms = excluded.failed_started_at_ms, failed_code = excluded.failed_code,
               failed_message = excluded.failed_message, failed_retry_at_ms = excluded.failed_retry_at_ms
             WHERE (entries.fetched_at_ms IS NULL OR excluded.failed_started_at_ms > entries.fetched_at_ms)
               AND (entries.failed_started_at_ms IS NULL OR excluded.failed_started_at_ms > entries.failed_started_at_ms)`,
          )
          .run(keyDigest, startedAtMs, result.code, result.message, result.retryAtMs ?? null);
      }
      this.db.query("DELETE FROM inflight WHERE cache_key = ? AND token = ?").run(keyDigest, input.token);
      const stored = this.readStored(keyDigest);
      if (result.ok) {
        // The caller gets the answer it fetched; the store keeps only what is newer than what it holds.
        return { ...result, fetchedAtMs: startedAtMs };
      }
      const failure: StoredFailure = { startedAtMs, code: result.code, message: result.message, retryAtMs: result.retryAtMs ?? null };
      return failureOf(request, failure, lastGood(request, stored));
    }).immediate();
  }

  /** Removes the claim of `token` when it still holds the key; a no-op after `complete` or a takeover. */
  release(keyDigest: string, token: string): void {
    this.db.query("DELETE FROM inflight WHERE cache_key = ? AND token = ?").run(keyDigest, token);
  }

  private readStored(keyDigest: string): Stored {
    const row = this.statements.entry.get(keyDigest) as EntryRow | null;
    if (row === null) return { success: null, failure: null };
    const success: StoredSuccess | null =
      row.fetched_at_ms === null || row.value === null ? null : parseStoredValue(row.value, row.fetched_at_ms);
    const failure: StoredFailure | null =
      row.failed_started_at_ms === null || row.failed_code === null || row.failed_message === null
        ? null
        : {
            startedAtMs: row.failed_started_at_ms,
            code: row.failed_code as SourceErrorCode,
            message: row.failed_message,
            retryAtMs: row.failed_retry_at_ms,
          };
    return { success, failure };
  }

  private readInflight(keyDigest: string): InflightRow | null {
    const row = this.statements.inflight.get(keyDigest) as InflightDbRow | null;
    if (row === null) return null;
    return { ownerPid: row.owner_pid, token: row.token, startedAtMs: row.started_at_ms, heartbeatMs: row.heartbeat_ms };
  }

  private readBackoff(provider: string): number | null {
    const row = this.statements.backoff.get(provider) as { until_ms: number } | null;
    return row === null ? null : row.until_ms;
  }
}

function isLive(row: InflightRow, atMs: number, lockTimeoutMs: number): boolean {
  return atMs - row.heartbeatMs <= lockTimeoutMs && isProcessAlive(row.ownerPid);
}

/** The stored success with its data decoded; null when there is none or its stored value no longer decodes. */
function lastGood<T>(request: CacheRequest<T>, stored: Stored): { readonly data: T; readonly fetchedAtMs: number } | null {
  if (stored.success === null) return null;
  const data = request.decode(stored.success.value);
  return data === null ? null : { data, fetchedAtMs: stored.success.fetchedAtMs };
}

/** What a waiter takes from the attempt it waited for: a success or a failure that started with that attempt. */
function outcomeOfAttempt<T>(request: CacheRequest<T>, stored: Stored, attemptStartedAtMs: number): SourceResult<T> | null {
  const good = lastGood(request, stored);
  if (good !== null && good.fetchedAtMs >= attemptStartedAtMs) return successOf(request, good);
  if (stored.failure !== null && stored.failure.startedAtMs >= attemptStartedAtMs) {
    return failureOf(request, stored.failure, good);
  }
  return null;
}

function successOf<T>(request: CacheRequest<T>, good: { readonly data: T; readonly fetchedAtMs: number }): SourceResult<T> {
  return { ok: true, source: request.source, data: good.data, durationMs: 0, fetchedAtMs: good.fetchedAtMs };
}

/** A failure, with the last good data (marked stale) when there is one. */
function failureOf<T>(
  request: CacheRequest<T>,
  failure: StoredFailure,
  lastGoodData: { readonly data: T; readonly fetchedAtMs: number } | null,
): SourceResult<T> {
  const retry = failure.retryAtMs === null ? {} : { retryAtMs: failure.retryAtMs };
  if (lastGoodData !== null) {
    return {
      ok: false,
      stale: true,
      source: request.source,
      code: failure.code,
      message: failure.message,
      data: lastGoodData.data,
      fetchedAtMs: lastGoodData.fetchedAtMs,
      durationMs: 0,
      ...retry,
    };
  }
  return { ok: false, source: request.source, code: failure.code, message: failure.message, durationMs: 0, ...retry };
}

function backoffFailure(untilMs: number): StoredFailure {
  return {
    startedAtMs: untilMs,
    code: "rate_limited",
    message: "GitHub rate limit reached; the provider is not asked again before the reset",
    retryAtMs: untilMs,
  };
}

function busyFailure<T>(source: SourceName, atMs: number): SourceResult<T> {
  return {
    ok: false,
    source,
    code: "unavailable",
    message: `the shared cache is busy (no lock within busy_timeout_ms at ${new Date(atMs).toISOString()})`,
    durationMs: 0,
  };
}

function parseStoredValue(text: string, fetchedAtMs: number): StoredSuccess | null {
  try {
    return { fetchedAtMs, value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Hex characters of the identity digest: 128 bits, enough to tell accounts apart in a per-user cache. */
const IDENTITY_HEX_LENGTH = 32;
/** Bytes of the random salt behind `identityOf`. */
const SALT_BYTES = 32;

/**
 * The salt is written to a temporary file and linked into place, so the file appears complete or not at all.
 * Every process reads the same salt once it exists.
 */
async function readOrCreateSalt(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const file = join(directory, SALT_FILE);
  const candidate = randomBytes(SALT_BYTES).toString("hex");
  const temporary = `${file}.${process.pid.toString()}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", FILE_MODE);
  try {
    await handle.writeFile(candidate);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, file);
    return candidate;
  } catch (error) {
    if (!isErrnoCode(error, "EEXIST")) throw error;
  } finally {
    await unlinkIfPresent(temporary);
  }
  const text = (await readFile(file, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error("the cache identity salt is damaged; remove the cache directory to recreate it");
  return text;
}

/** The database is locked by another connection: SQLITE_BUSY, or the message SQLite gives for it. */
function isBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return code === "SQLITE_BUSY" || (typeof message === "string" && message.includes("database is locked"));
}

function openDatabase(file: string, busyTimeoutMs: number): Database {
  const db = new Database(file, { create: true });
  try {
    db.run(`PRAGMA busy_timeout = ${busyTimeoutMs.toString()}`);
    db.run("PRAGMA journal_mode = WAL");
    db.run(SCHEMA);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function chmodSidecars(file: string): Promise<void> {
  for (const suffix of SIDECAR_SUFFIXES) {
    await chmod(`${file}${suffix}`, FILE_MODE).catch((error: unknown) => {
      if (!isErrnoCode(error, "ENOENT")) throw error;
    });
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** Signal 0 checks existence without sending anything; EPERM means the process exists under another user. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrnoCode(error, "ESRCH");
  }
}
