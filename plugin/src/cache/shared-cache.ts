// Shared cache of provider source results in the state directory. Every local process (`list`, the
// TUI's list child, `watch`, sessions that run `list`) reads through it: a result read from the
// provider is served for `[cache] max_age_secs` to all of them, a fetch holds the lock of its result
// so concurrent callers wait for it instead of asking again, a failed refresh keeps the last good data
// marked stale, and a rate-limit response stops every process from asking the provider until its reset.
//
// Files: `<key>.json` holds the last good result and the last failed attempt, `<key>.lock` the holder
// of a fetch, `backoff-<provider>.json` the instant before which the provider is not asked. Writes go
// through a temporary file and a rename, so a reader sees the old file or the new one, never a part.
//
// A lock names its owner by pid and a random token. The holder refreshes the lock's mtime every
// `lock_poll_ms` while its fetch runs, so a lock is abandoned only when its holder is gone or has
// stopped refreshing it for `lock_timeout_ms`; a slow fetch of a live process is never taken over. A result
// is stored only when its fetch started after the stored one, so a late result cannot overwrite newer data.

import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { CacheConfig } from "../types/config.ts";
import type { SourceErrorCode, SourceName, SourceResult } from "../types/sources.ts";

/** Owner read and write only: the cache holds GitHub and Linear data about the owner's work. */
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const ENTRY_VERSION = 1;
const CACHE_SUBDIRECTORY = "cache";

export interface CacheRequest<T> {
  /** Provider whose back-off applies to the result, e.g. `github` or `linear`. */
  readonly provider: string;
  /** Source name the result is reported under. */
  readonly source: SourceName;
  /** Identifies the result: every input that changes what the provider returns belongs in it. */
  readonly key: string;
  /** Reads the result from the provider; the cache calls it at most once per fetch. */
  readonly fetch: () => Promise<SourceResult<T>>;
  /** Serializes the data for the cache file. */
  readonly encode: (data: T) => unknown;
  /** Restores the data; null when the stored shape is not the one `encode` writes. */
  readonly decode: (raw: unknown) => T | null;
}

export interface SharedCache {
  /**
   * The result for `request`: the cached data when it is fresh, the outcome of a fetch another
   * process started after this call began, or a new fetch made under the lock of the result.
   */
  read<T>(request: CacheRequest<T>): Promise<SourceResult<T>>;
}

export interface SharedCacheOptions {
  /** Directory of the state; the cache lives in a subdirectory of it. */
  readonly stateDir: string;
  readonly config: CacheConfig;
  /** Bypasses the max age: a result is accepted only when its fetch started after the call began. */
  readonly refresh: boolean;
  /** Clock; the system clock when absent. */
  readonly now?: () => number;
}

interface SuccessRecord {
  readonly fetchedAtMs: number;
  readonly value: unknown;
}

interface FailureRecord {
  readonly startedAtMs: number;
  readonly code: SourceErrorCode;
  readonly message: string;
  readonly retryAtMs: number | null;
}

interface EntryFile {
  readonly version: typeof ENTRY_VERSION;
  readonly success: SuccessRecord | null;
  readonly failure: FailureRecord | null;
}

interface BackoffFile {
  readonly version: typeof ENTRY_VERSION;
  readonly untilMs: number;
}

interface LockFile {
  readonly pid: number;
  readonly token: string;
}

export function createSharedCache(options: SharedCacheOptions): SharedCache {
  const now = options.now ?? Date.now;
  const directory = join(options.stateDir, CACHE_SUBDIRECTORY);
  const { config } = options;

  const entryPath = (key: string): string => join(directory, `${digest(key)}.json`);
  const lockPath = (key: string): string => join(directory, `${digest(key)}.lock`);
  const backoffPath = (provider: string): string => join(directory, `backoff-${provider}.json`);

  /** Reads one JSON file; null when it is missing or unreadable, so a damaged cache file counts as a miss. */
  async function readJson<T>(path: string, parse: (raw: unknown) => T | null): Promise<T | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return null;
      throw error;
    }
    try {
      return parse(JSON.parse(text));
    } catch {
      return null;
    }
  }

  /** Temporary file in the same directory, then rename: readers never see a partly written file. */
  async function writeAtomic(path: string, body: unknown): Promise<void> {
    const temporary = `${path}.${process.pid.toString()}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", FILE_MODE);
    try {
      await handle.writeFile(JSON.stringify(body));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async function readEntry(key: string): Promise<EntryFile | null> {
    return readJson(entryPath(key), parseEntry);
  }

  async function readBackoffUntil(provider: string): Promise<number | null> {
    const backoff = await readJson(backoffPath(provider), parseBackoff);
    return backoff !== null && backoff.untilMs > now() ? backoff.untilMs : null;
  }

  /** Writes the outcome of a fetch that started at `startedAtMs` into the entry and, on a rate limit, into the back-off. */
  async function record<T>(request: CacheRequest<T>, startedAtMs: number, result: SourceResult<T>): Promise<void> {
    // A result that started before the stored one was read, possibly by a process that lost its lock; the stored one is newer.
    const latest = await readEntry(request.key);
    const latestSuccessAt = latest?.success?.fetchedAtMs ?? null;
    if (latestSuccessAt !== null && startedAtMs <= latestSuccessAt) return;
    if (result.ok) {
      const success: SuccessRecord = { fetchedAtMs: startedAtMs, value: request.encode(result.data) };
      await writeAtomic(entryPath(request.key), { version: ENTRY_VERSION, success, failure: null });
      return;
    }
    const failure: FailureRecord = {
      startedAtMs,
      code: result.code,
      message: result.message,
      retryAtMs: result.retryAtMs ?? null,
    };
    await writeAtomic(entryPath(request.key), { version: ENTRY_VERSION, success: latest?.success ?? null, failure });
    if (result.code === "rate_limited") {
      const untilMs = result.retryAtMs ?? now() + config.fallbackBackoffMs;
      await writeAtomic(backoffPath(request.provider), { version: ENTRY_VERSION, untilMs });
    }
  }

  /**
   * Acquires the lock of a result and returns its token, or null when another process holds it. The lock
   * appears only with its content (a temporary file linked into place), so a reader never sees an empty lock.
   */
  async function tryLock(key: string): Promise<string | null> {
    const token = randomBytes(16).toString("hex");
    const temporary = `${lockPath(key)}.${token}.tmp`;
    const body: LockFile = { pid: process.pid, token };
    const handle = await open(temporary, "wx", FILE_MODE);
    try {
      await handle.writeFile(JSON.stringify(body));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, lockPath(key));
      return token;
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) return null;
      throw error;
    } finally {
      await unlinkIfPresent(temporary);
    }
  }

  /** Refreshes the lock's mtime every `lock_poll_ms` while the fetch runs, as long as the lock still carries `token`. */
  function startHeartbeat(key: string, token: string): () => void {
    const timer = setInterval(() => {
      void touchIfOwner(key, token);
    }, config.lockPollMs);
    return () => { clearInterval(timer); };
  }

  /** A refresh that fails leaves the lock to expire; the fetch it guards still completes. */
  async function touchIfOwner(key: string, token: string): Promise<void> {
    try {
      if ((await readLockToken(key)) !== token) return;
      const at = new Date(now());
      await utimes(lockPath(key), at, at);
    } catch {
      // Expiry of the lock is the recovery path; the heartbeat itself must not end the process.
    }
  }

  async function readLockToken(key: string): Promise<string | null> {
    return (await readJson(lockPath(key), parseLock))?.token ?? null;
  }

  /** Removes the lock only while it still carries `token`: a lock taken over after this one expired is not ours. */
  async function releaseLock(key: string, token: string): Promise<void> {
    if ((await readLockToken(key)) === token) await unlinkIfPresent(lockPath(key));
  }

  /**
   * The token of a lock whose holder is gone or has not refreshed it for `lock_timeout_ms`; null for a live
   * holder. A lock that cannot be read is judged by its age alone.
   */
  async function abandonedToken(key: string): Promise<{ readonly token: string | null } | null> {
    let info;
    try {
      info = await stat(lockPath(key));
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return null;
      throw error;
    }
    const holder = await readJson(lockPath(key), parseLock);
    const stale = now() - info.mtimeMs > config.lockTimeoutMs;
    if (holder === null) return stale ? { token: null } : null;
    if (stale || !isProcessAlive(holder.pid)) return { token: holder.token };
    return null;
  }

  /**
   * Replaces an abandoned lock. The lock is renamed away first, so the takeover never deletes a lock that a
   * third process created after the check: a moved lock that is not the observed one is linked back.
   */
  async function takeOver(key: string, observedToken: string | null): Promise<void> {
    const tombstone = `${lockPath(key)}.${randomBytes(8).toString("hex")}.stale`;
    try {
      await rename(lockPath(key), tombstone);
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) return;
      throw error;
    }
    const moved = await readJson(tombstone, parseLock);
    if ((moved?.token ?? null) !== observedToken) {
      try {
        await link(tombstone, lockPath(key));
      } catch (error) {
        if (!isErrnoCode(error, "EEXIST")) throw error;
      }
    }
    await unlinkIfPresent(tombstone);
  }

  /** Serves the stored data, the outcome of a fetch that started after the request, or nothing when neither applies. */
  function acceptable<T>(
    request: CacheRequest<T>,
    entry: EntryFile | null,
    requestedAtMs: number,
  ): SourceResult<T> | null {
    const success = entry?.success ?? null;
    const data = success === null ? null : request.decode(success.value);
    if (success !== null && data !== null) {
      const fresh = options.refresh
        ? success.fetchedAtMs >= requestedAtMs
        : now() - success.fetchedAtMs < config.maxAgeMs;
      if (fresh) {
        return { ok: true, source: request.source, data, durationMs: 0, fetchedAtMs: success.fetchedAtMs };
      }
    }
    const failure = entry?.failure ?? null;
    if (failure !== null && failure.startedAtMs >= requestedAtMs) {
      return failed(request.source, failure, lastGoodOf(request, entry));
    }
    return null;
  }

  return {
    async read<T>(request: CacheRequest<T>): Promise<SourceResult<T>> {
      const requestedAtMs = now();
      await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
      for (;;) {
        const entry = await readEntry(request.key);
        const served = acceptable(request, entry, requestedAtMs);
        if (served !== null) return served;
        const backoffUntil = await readBackoffUntil(request.provider);
        if (backoffUntil !== null) {
          return backedOff(request, entry, backoffUntil);
        }
        const token = await tryLock(request.key);
        if (token !== null) {
          const stopHeartbeat = startHeartbeat(request.key, token);
          try {
            // Another process may have finished a fetch, or written a back-off, between the reads above and the lock.
            const current = await readEntry(request.key);
            const again = acceptable(request, current, requestedAtMs);
            if (again !== null) return again;
            const blockedUntil = await readBackoffUntil(request.provider);
            if (blockedUntil !== null) return backedOff(request, current, blockedUntil);
            const startedAtMs = now();
            const result = await request.fetch();
            await record(request, startedAtMs, result);
            return result.ok ? { ...result, fetchedAtMs: startedAtMs } : withLastGood(request, current, result, startedAtMs);
          } finally {
            stopHeartbeat();
            await releaseLock(request.key, token);
          }
        }
        const abandoned = await abandonedToken(request.key);
        if (abandoned !== null) {
          await takeOver(request.key, abandoned.token);
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, config.lockPollMs));
      }
    },
  };
}

function digest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
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

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  }
}

/** The failure of a fetch, with the last good data (and its fetch instant) when there is one, marked stale. */
function failed<T>(
  source: SourceName,
  failure: FailureRecord,
  lastGood: { readonly data: T; readonly fetchedAtMs: number } | null,
): SourceResult<T> {
  const retry = failure.retryAtMs === null ? {} : { retryAtMs: failure.retryAtMs };
  if (lastGood !== null) {
    return {
      ok: false,
      stale: true,
      source,
      code: failure.code,
      message: failure.message,
      data: lastGood.data,
      fetchedAtMs: lastGood.fetchedAtMs,
      durationMs: 0,
      ...retry,
    };
  }
  return { ok: false, source, code: failure.code, message: failure.message, durationMs: 0, ...retry };
}

/** The last good data, marked stale, after a fetch that failed; the failure itself when there is none. */
function withLastGood<T>(
  request: CacheRequest<T>,
  entry: EntryFile | null,
  result: SourceResult<T>,
  startedAtMs: number,
): SourceResult<T> {
  if (result.ok) return result;
  const failure: FailureRecord = {
    startedAtMs,
    code: result.code,
    message: result.message,
    retryAtMs: result.retryAtMs ?? null,
  };
  return failed(request.source, failure, lastGoodOf(request, entry));
}

/** While the provider is backed off, the stored data (marked stale) or a rate-limit failure that names the reset. */
function backedOff<T>(request: CacheRequest<T>, entry: EntryFile | null, untilMs: number): SourceResult<T> {
  const failure: FailureRecord = {
    startedAtMs: untilMs,
    code: "rate_limited",
    message: "GitHub rate limit reached; the provider is not asked again before the reset",
    retryAtMs: untilMs,
  };
  return failed(request.source, failure, lastGoodOf(request, entry));
}

function lastGoodOf<T>(request: CacheRequest<T>, entry: EntryFile | null): { readonly data: T; readonly fetchedAtMs: number } | null {
  const success = entry?.success ?? null;
  if (success === null) return null;
  const data = request.decode(success.value);
  return data === null ? null : { data, fetchedAtMs: success.fetchedAtMs };
}

function parseEntry(raw: unknown): EntryFile | null {
  if (!isRecord(raw) || raw["version"] !== ENTRY_VERSION) return null;
  const success = raw["success"];
  const failure = raw["failure"];
  const parsedSuccess =
    success === null
      ? null
      : isRecord(success) && typeof success["fetchedAtMs"] === "number" && "value" in success
        ? { fetchedAtMs: success["fetchedAtMs"], value: success["value"] }
        : undefined;
  const parsedFailure =
    failure === null
      ? null
      : isRecord(failure) &&
          typeof failure["startedAtMs"] === "number" &&
          typeof failure["code"] === "string" &&
          typeof failure["message"] === "string" &&
          (typeof failure["retryAtMs"] === "number" || failure["retryAtMs"] === null)
        ? {
            startedAtMs: failure["startedAtMs"],
            code: failure["code"] as SourceErrorCode,
            message: failure["message"],
            retryAtMs: failure["retryAtMs"],
          }
        : undefined;
  if (parsedSuccess === undefined || parsedFailure === undefined) return null;
  return { version: ENTRY_VERSION, success: parsedSuccess, failure: parsedFailure };
}

function parseBackoff(raw: unknown): BackoffFile | null {
  if (!isRecord(raw) || raw["version"] !== ENTRY_VERSION || typeof raw["untilMs"] !== "number") return null;
  return { version: ENTRY_VERSION, untilMs: raw["untilMs"] };
}

function parseLock(raw: unknown): LockFile | null {
  if (!isRecord(raw) || typeof raw["pid"] !== "number" || typeof raw["token"] !== "string") return null;
  return { pid: raw["pid"], token: raw["token"] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
