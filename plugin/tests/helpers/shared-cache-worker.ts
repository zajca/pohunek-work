// One process of a shared-cache scenario (tests/shared-cache-lock.integration.test.ts): reads one result
// through the real cache of the state directory and prints the data it got. A write worker's fetch
// writes a marker file when it starts, appends to a counter file and answers `value` after `fetchMs`;
// a read worker's fetch must never run, so it answers a value no scenario expects.
import { appendFileSync, writeFileSync } from "node:fs";
import { createSharedCache } from "../../src/cache/shared-cache.ts";

interface WorkerSpec {
  readonly mode: "write" | "read";
  readonly stateDir: string;
  readonly key: string;
  readonly value: string;
  readonly fetchMs: number;
  readonly markerFile: string;
  readonly countFile: string;
  readonly maxAgeMs: number;
  readonly lockTimeoutMs: number;
  readonly lockPollMs: number;
}

const spec = JSON.parse(process.env["SHARED_CACHE_WORKER_SPEC"] ?? "null") as WorkerSpec;

const cache = createSharedCache({
  stateDir: spec.stateDir,
  config: {
    maxAgeMs: spec.maxAgeMs,
    lockTimeoutMs: spec.lockTimeoutMs,
    lockPollMs: spec.lockPollMs,
    fallbackBackoffMs: 900_000,
  },
  refresh: false,
});

const result = await cache.read<readonly string[]>({
  provider: "github",
  source: "github",
  key: spec.key,
  fetch: async () => {
    appendFileSync(spec.countFile, `${spec.mode}\n`);
    if (spec.mode === "read") return { ok: true, source: "github", data: ["unexpected fetch"], durationMs: 0 };
    writeFileSync(spec.markerFile, "started");
    await Bun.sleep(spec.fetchMs);
    return { ok: true, source: "github", data: [spec.value], durationMs: spec.fetchMs };
  },
  encode: (data) => data,
  decode: (raw) => (Array.isArray(raw) ? (raw as string[]) : null),
});

console.log(JSON.stringify(result.ok ? { data: result.data } : { failure: result.code }));
