// One process of a shared-cache scenario (tests/shared-cache-lock.integration.test.ts): reads one result through
// the real shared cache of the state directory and prints what it got. A write worker's fetch appends to a counter
// file, writes a marker when it starts and answers after `fetchMs` with the configured outcome; a read worker's
// fetch must never run, so a scenario that sees its value has a bug. The Linear worker goes through the real
// cachedLinearSource; the Linear source behind it is a stand-in for the account behind the keyring token,
// because the scenario has no Linear account to switch.
import { Database } from "bun:sqlite";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSharedCache, type CacheRequest } from "../../src/cache/shared-cache.ts";
import { cachedLinearSource } from "../../src/sources/cached.ts";
import type { LinearProject } from "../../src/types/config.ts";
import type { Issue, SourceResult } from "../../src/types/sources.ts";
import type { LinearSource } from "../../src/sources/linear.ts";

interface WorkerSpec {
  /**
   * `read`: the fetch must not run. `write`: the fetch runs and answers with `outcome`. `hold`: takes an exclusive
   * lock on the cache database for `fetchMs` and touches `markerFile` once held. `twice`: two reads with the
   * given fetch behaviour, the second one after `gateFile` exists.
   */
  readonly mode: "write" | "read" | "hold" | "twice";
  readonly gateFile: string | null;
  readonly outcome: "ok" | "unavailable" | "rate_limited";
  /** Absolute instant the rate-limit response names as its reset. */
  readonly resetAtMs: number;
  readonly refresh: boolean;
  readonly stateDir: string;
  readonly key: string;
  readonly value: string;
  readonly fetchMs: number;
  readonly markerFile: string;
  readonly countFile: string;
  readonly maxAgeMs: number;
  readonly lockTimeoutMs: number;
  readonly lockPollMs: number;
  readonly busyTimeoutMs: number;
  /** Set for the Linear worker: the account the keyring token belongs to. */
  readonly linearViewer: string | null;
}

const spec = JSON.parse(process.env["SHARED_CACHE_WORKER_SPEC"] ?? "null") as WorkerSpec;
const cacheConfig = {
  maxAgeMs: spec.maxAgeMs,
  lockTimeoutMs: spec.lockTimeoutMs,
  lockPollMs: spec.lockPollMs,
  fallbackBackoffMs: 900_000,
  busyTimeoutMs: spec.busyTimeoutMs,
};
if (spec.mode === "hold") {
  const directory = join(spec.stateDir, "cache");
  Bun.spawnSync(["mkdir", "-p", directory]);
  // Rollback-journal database, so the cache's switch to WAL needs the lock this process holds.
  const database = new Database(join(directory, "cache.sqlite"), { create: true });
  database.run("CREATE TABLE IF NOT EXISTS holder_probe (x INTEGER)");
  database.run("BEGIN EXCLUSIVE");
  writeFileSync(spec.markerFile, "held");
  await Bun.sleep(spec.fetchMs);
  database.run("COMMIT");
  database.close();
  process.exit(0);
}

const cache = createSharedCache({ stateDir: spec.stateDir, config: cacheConfig, refresh: spec.refresh });

/** The provider answer of this worker's fetch; the same for every source the worker reads. */
async function answer<T>(source: "github" | "linear", data: T): Promise<SourceResult<T>> {
  appendFileSync(spec.countFile, `${spec.mode}\n`);
  if (spec.mode === "read") throw new Error("a read worker made a provider call");
  writeFileSync(spec.markerFile, "started");
  await Bun.sleep(spec.fetchMs);
  if (spec.outcome === "ok") return { ok: true, source, data, durationMs: spec.fetchMs };
  if (spec.outcome === "rate_limited") {
    return { ok: false, source, code: "rate_limited", message: "GitHub rate limit reached", retryAtMs: spec.resetAtMs, durationMs: spec.fetchMs };
  }
  return { ok: false, source, code: "unavailable", message: "GitHub unavailable", durationMs: spec.fetchMs };
}

function listCodec<T>(): Pick<CacheRequest<readonly T[]>, "encode" | "decode"> {
  return { encode: (data) => data, decode: (raw) => (Array.isArray(raw) ? (raw as T[]) : null) };
}

/** One read of the worker's source, as the reported answer. */
async function readOnce(): Promise<SourceResult<readonly unknown[]>> {
  if (spec.linearViewer === null) {
    return cache.read<readonly string[]>({
      provider: "github",
      source: "github",
      key: spec.key,
      fetch: () => answer("github", [spec.value]),
      ...listCodec<string>(),
    });
  }
  return readLinear();
}

if (spec.mode === "twice") {
  const first = await readOnce();
  while (spec.gateFile !== null && !(await Bun.file(spec.gateFile).exists())) await Bun.sleep(spec.lockPollMs);
  const second = await readOnce();
  console.log(JSON.stringify({ reads: [answerOf(first), answerOf(second)] }));
} else {
  console.log(JSON.stringify(answerOf(await readOnce())));
}

function answerOf(result: SourceResult<readonly unknown[]>): unknown {
  if (result.ok) return { data: result.data.map(itemText) };
  return { failure: result.code, staleData: "stale" in result ? result.data.map(itemText) : null };
}

function itemText(item: unknown): string {
  return typeof item === "string" ? item : (item as { id: string }).id;
}

/** The stand-in Linear source of this worker: the account of the token is its credential, and one issue per fetch. */
async function readLinear(): Promise<SourceResult<readonly unknown[]>> {
  const account: LinearSource = {
    credential: () => Promise.resolve({ ok: true, source: "linear", data: spec.linearViewer ?? "", durationMs: 0 }),
    fetchIssues: async () =>
      answer("linear", [{ id: `${spec.linearViewer ?? ""}-${spec.value}` } as unknown as Issue]),
    fetchIgnoredKeys: () => Promise.resolve({ ok: true, source: "linear", data: new Set<string>(), durationMs: 0 }),
  };
  const linearConfig = {
    endpoint: "https://linear.example/graphql",
    secretToolBin: "/usr/bin/secret-tool",
    keyringService: "test-service",
    keyringKey: "test-key",
    timeoutMs: 15_000,
    pageSize: 40,
  };
  return cachedLinearSource(account, linearConfig, { cache }).fetchIssues({} as LinearProject);
}
