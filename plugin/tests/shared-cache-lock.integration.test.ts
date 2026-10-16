// Process-boundary scenarios of the shared cache's lock: each process is a real `bun` run of
// helpers/shared-cache-worker.ts against one state directory. The timings are short so that a lock
// timeout passes inside a test, and the scenarios use signals to stall a holder deterministically.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKER = join(import.meta.dir, "helpers", "shared-cache-worker.ts");
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_AGE_MS = 60_000;
/** Shorter than a stalled holder's pause, so a holder that stops refreshing its lock is taken over. */
const LOCK_TIMEOUT_MS = 400;
const LOCK_POLL_MS = 50;
const HOLDER_FETCH_MS = 1_500;
const MARKER_POLL_MS = 20;
const MARKER_WAIT_MS = 20_000;
const KEY = "pull_requests-scenario";

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

type Outcome = { readonly data: readonly string[] } | { readonly failure: string };

let directory = "";

afterEach(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
  directory = "";
});

function spawnWorker(spec: WorkerSpec): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([process.execPath, WORKER], {
    env: { ...process.env, SHARED_CACHE_WORKER_SPEC: JSON.stringify(spec) },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function outcomeOf(process_: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<Outcome> {
  const [stdout, stderr] = await Promise.all([new Response(process_.stdout).text(), new Response(process_.stderr).text()]);
  const code = await process_.exited;
  if (code !== 0) throw new Error(`worker exited ${String(code)}: ${stderr}`);
  return JSON.parse(stdout) as Outcome;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + MARKER_WAIT_MS;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(MARKER_POLL_MS);
  }
  throw new Error(`${path} did not appear`);
}

async function fetchCount(countFile: string): Promise<number> {
  const text = await readFile(countFile, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").length;
}

function specFor(
  dir: string,
  name: string,
  mode: "write" | "read",
  value: string,
  fetchMs: number,
): WorkerSpec {
  return {
    mode,
    stateDir: join(dir, "state"),
    key: KEY,
    value,
    fetchMs,
    markerFile: join(dir, `${name}.started`),
    countFile: join(dir, "fetches.txt"),
    maxAgeMs: MAX_AGE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    lockPollMs: LOCK_POLL_MS,
  };
}

test("a slow fetch of a live holder is not taken over when it outlasts lock_timeout_ms", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const holderSpec = specFor(directory, "holder", "write", "holder", HOLDER_FETCH_MS);
  const holder = spawnWorker(holderSpec);
  await waitForFile(holderSpec.markerFile);

  // The waiter arrives while the holder's fetch runs for longer than lock_timeout_ms.
  const waiter = await outcomeOf(spawnWorker(specFor(directory, "waiter", "write", "waiter", 0)));
  const holderOutcome = await outcomeOf(holder);

  expect(waiter).toEqual({ data: ["holder"] });
  expect(holderOutcome).toEqual({ data: ["holder"] });
  expect(await fetchCount(holderSpec.countFile)).toBe(1);
}, SCENARIO_TIMEOUT_MS);

test("a holder that stalls past lock_timeout_ms and resumes cannot overwrite the newer result", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const stalledSpec = specFor(directory, "stalled", "write", "old", 2 * HOLDER_FETCH_MS);
  const stalled = spawnWorker(stalledSpec);
  await waitForFile(stalledSpec.markerFile);

  // The holder stops refreshing its lock; the waiter takes it over and stores a newer result.
  stalled.kill("SIGSTOP");
  const takeover = await outcomeOf(spawnWorker(specFor(directory, "takeover", "write", "new", 0)));
  expect(takeover).toEqual({ data: ["new"] });

  stalled.kill("SIGCONT");
  await outcomeOf(stalled);

  // The resumed holder's older result was not stored: a later read is served the newer one without a fetch.
  const reader = await outcomeOf(spawnWorker(specFor(directory, "reader", "read", "unexpected", 0)));
  expect(reader).toEqual({ data: ["new"] });
  expect(await fetchCount(stalledSpec.countFile)).toBe(2);
}, SCENARIO_TIMEOUT_MS);
