// Process-boundary scenarios of the shared cache: each process is a real `bun` run of
// helpers/shared-cache-worker.ts against one state directory. Timings are short so that a lock timeout passes
// inside a test; signals stall a holder deterministically (SIGSTOP stops its heartbeat, SIGCONT lets its late
// result arrive), and the race scenarios start processes together to make the interleaving real.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKER = join(import.meta.dir, "helpers", "shared-cache-worker.ts");
const SCENARIO_TIMEOUT_MS = 120_000;
const MAX_AGE_MS = 60_000;
/** A stalled holder stops refreshing its lock for longer than this, so it is taken over. */
const LOCK_TIMEOUT_MS = 400;
const LOCK_POLL_MS = 50;
const BUSY_TIMEOUT_MS = 5_000;
const HOLDER_FETCH_MS = 1_500;
const OFFSET_MS = 50;
const WAITERS = 4;
const RATE_LIMIT_WINDOW_MS = 600_000;
const MARKER_POLL_MS = 20;
const MARKER_WAIT_MS = 20_000;
const KEY = "pull_requests-scenario";
const STALL_MARGIN_MS = 2 * LOCK_TIMEOUT_MS;

type Mode = "write" | "read" | "hold" | "twice";
type Outcome = "ok" | "unavailable" | "rate_limited";

interface Spec {
  readonly mode: Mode;
  readonly gateFile: string | null;
  readonly outcome: Outcome;
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
  readonly linearViewer: string | null;
}

type Answer = { readonly data: readonly string[] } | { readonly failure: string; readonly staleData: readonly string[] | null };
type TwiceAnswer = { readonly reads: readonly [Answer, Answer] };

let directory = "";

afterEach(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
  directory = "";
});

function specFor(name: string, overrides: Partial<Spec> = {}): Spec {
  return {
    mode: "write",
    gateFile: null,
    outcome: "ok",
    resetAtMs: Date.now() + RATE_LIMIT_WINDOW_MS,
    refresh: false,
    stateDir: join(directory, "state"),
    key: KEY,
    value: name,
    fetchMs: 0,
    markerFile: join(directory, `${name}.started`),
    countFile: join(directory, "fetches.txt"),
    maxAgeMs: MAX_AGE_MS,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
    lockPollMs: LOCK_POLL_MS,
    busyTimeoutMs: BUSY_TIMEOUT_MS,
    linearViewer: null,
    ...overrides,
  };
}

function start(spec: Spec): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([process.execPath, WORKER], {
    env: { ...process.env, SHARED_CACHE_WORKER_SPEC: JSON.stringify(spec) },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function finish(worker: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<Answer> {
  const [stdout, stderr] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
  const code = await worker.exited;
  if (code !== 0) throw new Error(`worker exited ${String(code)}: ${stderr}`);
  return JSON.parse(stdout) as Answer;
}

async function finishTwice(worker: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<TwiceAnswer> {
  const [stdout, stderr] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
  const code = await worker.exited;
  if (code !== 0) throw new Error(`worker exited ${String(code)}: ${stderr}`);
  return JSON.parse(stdout) as TwiceAnswer;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + MARKER_WAIT_MS;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(MARKER_POLL_MS);
  }
  throw new Error(`${path} did not appear`);
}

async function providerCalls(): Promise<number> {
  const text = await readFile(join(directory, "fetches.txt"), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").length;
}

function dataOf(answer: Answer): readonly string[] {
  if (!("data" in answer)) throw new Error(`expected data, got failure ${answer.failure}`);
  return answer.data;
}

test("a slow fetch of a live holder is not taken over when it outlasts lock_timeout_ms", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const holderSpec = specFor("holder", { fetchMs: HOLDER_FETCH_MS });
  const holder = start(holderSpec);
  await waitForFile(holderSpec.markerFile);

  const waiter = await finish(start(specFor("waiter", { mode: "read" })));
  expect(dataOf(await finish(holder))).toEqual(["holder"]);
  expect(dataOf(waiter)).toEqual(["holder"]);
  expect(await providerCalls()).toBe(1);
}, SCENARIO_TIMEOUT_MS);

test("a holder that stalls past lock_timeout_ms and resumes cannot overwrite the newer result", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const stalledSpec = specFor("stalled", { value: "old", fetchMs: 2 * HOLDER_FETCH_MS });
  const stalled = start(stalledSpec);
  await waitForFile(stalledSpec.markerFile);

  stalled.kill("SIGSTOP");
  expect(dataOf(await finish(start(specFor("takeover", { value: "new" }))))).toEqual(["new"]);
  stalled.kill("SIGCONT");
  await finish(stalled);

  const reader = await finish(start(specFor("reader", { mode: "read" })));
  expect(dataOf(reader)).toEqual(["new"]);
  expect(await providerCalls()).toBe(2);
}, SCENARIO_TIMEOUT_MS);

test("a refresh 50 ms into a fetch in flight joins it: one provider call and the same answer", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const first = specFor("first", { fetchMs: HOLDER_FETCH_MS });
  const firstWorker = start(first);
  await waitForFile(first.markerFile);
  await Bun.sleep(OFFSET_MS);

  const refresh = await finish(start(specFor("refresh", { refresh: true })));
  expect(dataOf(await finish(firstWorker))).toEqual(["first"]);
  expect(dataOf(refresh)).toEqual(["first"]);
  expect(await providerCalls()).toBe(1);
}, SCENARIO_TIMEOUT_MS);

test("a refresh 50 ms into a failing fetch joins it: one provider call and the same failure", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const first = specFor("first", { outcome: "unavailable", fetchMs: HOLDER_FETCH_MS });
  const firstWorker = start(first);
  await waitForFile(first.markerFile);
  await Bun.sleep(OFFSET_MS);

  const refresh = await finish(start(specFor("refresh", { refresh: true })));
  expect(await finish(firstWorker)).toEqual({ failure: "unavailable", staleData: null });
  expect(refresh).toEqual({ failure: "unavailable", staleData: null });
  expect(await providerCalls()).toBe(1);
}, SCENARIO_TIMEOUT_MS);

test("a late rate limit from a stalled holder still records the back-off after a newer result was stored", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const stalledSpec = specFor("stalled", { outcome: "rate_limited", fetchMs: 2 * HOLDER_FETCH_MS });
  const stalled = start(stalledSpec);
  await waitForFile(stalledSpec.markerFile);

  stalled.kill("SIGSTOP");
  expect(dataOf(await finish(start(specFor("takeover", { value: "new" }))))).toEqual(["new"]);
  stalled.kill("SIGCONT");
  await finish(stalled);

  // A forced refresh must not reach the provider: the late rate limit names a reset in the future.
  const refresh = await finish(start(specFor("refresh", { mode: "read", refresh: true })));
  expect(refresh).toEqual({ failure: "rate_limited", staleData: ["new"] });
  expect(await providerCalls()).toBe(2);
}, SCENARIO_TIMEOUT_MS);

test("two Linear accounts behind one keyring entry do not share a cache entry", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const alice = await finish(start(specFor("alice", { linearViewer: "alice-account", value: "x" })));
  expect(dataOf(alice)).toEqual(["alice-account-x"]);

  const bob = await finish(start(specFor("bob", { linearViewer: "bob-account", value: "x" })));
  expect(dataOf(bob)).toEqual(["bob-account-x"]);
  expect(await providerCalls()).toBe(2);
}, SCENARIO_TIMEOUT_MS);

test("concurrent waiters after a stalled holder take one takeover between them", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const stalledSpec = specFor("stalled", { value: "old", fetchMs: 2 * HOLDER_FETCH_MS });
  const stalled = start(stalledSpec);
  await waitForFile(stalledSpec.markerFile);

  stalled.kill("SIGSTOP");
  // Let the stalled holder's heartbeat age past lock_timeout_ms before the waiters arrive together.
  await Bun.sleep(STALL_MARGIN_MS);
  const answers = await Promise.all(
    Array.from({ length: WAITERS }, (_, index) => finish(start(specFor(`waiter${index.toString()}`, { mode: "write" })))),
  );
  stalled.kill("SIGCONT");
  await finish(stalled);

  const taken = new Set(answers.map((answer) => JSON.stringify(dataOf(answer))));
  expect(taken.size).toBe(1);
  expect(await providerCalls()).toBe(2);
}, SCENARIO_TIMEOUT_MS);

test("with the provider down, a read within max_age is served from the cache without a provider call", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const fresh = await finish(start(specFor("fresh", { linearViewer: "alice-account", value: "x" })));
  expect(dataOf(fresh)).toEqual(["alice-account-x"]);

  // The read itself would fail the test if it reached the provider.
  const served = await finish(start(specFor("served", { mode: "read", linearViewer: "alice-account", value: "x" })));
  expect(dataOf(served)).toEqual(["alice-account-x"]);
  expect(await providerCalls()).toBe(1);
}, SCENARIO_TIMEOUT_MS);

test("with the provider down after max_age, the last good result is served stale", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  await finish(start(specFor("first", { linearViewer: "alice-account", value: "x" })));

  const down = await finish(
    start(specFor("down", { linearViewer: "alice-account", value: "x", maxAgeMs: 0, outcome: "unavailable" })),
  );
  expect(down).toEqual({ failure: "unavailable", staleData: ["alice-account-x"] });
  expect(await providerCalls()).toBe(2);
}, SCENARIO_TIMEOUT_MS);

test("a changed credential behind the same keyring entry is a cache miss", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  expect(dataOf(await finish(start(specFor("alice", { linearViewer: "alice-account", value: "x" }))))).toEqual(["alice-account-x"]);

  const bob = await finish(start(specFor("bob", { linearViewer: "bob-account", value: "x" })));
  expect(dataOf(bob)).toEqual(["bob-account-x"]);
  expect(await providerCalls()).toBe(2);
}, SCENARIO_TIMEOUT_MS);

test("a late success from a taken-over holder does not erase a newer failure", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const stalledSpec = specFor("holder", { value: "holder", fetchMs: 2 * HOLDER_FETCH_MS, maxAgeMs: MAX_AGE_MS });
  const stalled = start(stalledSpec);
  await waitForFile(stalledSpec.markerFile);

  stalled.kill("SIGSTOP");
  const failed = await finish(start(specFor("takeover", { outcome: "unavailable" })));
  expect(failed).toEqual({ failure: "unavailable", staleData: null });
  stalled.kill("SIGCONT");
  expect(dataOf(await finish(stalled))).toEqual(["holder"]);

  // The newest attempt failed, so the holder's older success must not be served as fresh: this read fetches.
  const reader = await finish(start(specFor("reader", { value: "reader" })));
  expect(dataOf(reader)).toEqual(["reader"]);
  expect(await providerCalls()).toBe(3);
}, SCENARIO_TIMEOUT_MS);

test("a read whose store open was busy past busy_timeout_ms succeeds on a later read of the same process", async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-cache-lock-"));
  const gate = join(directory, "holder-done");
  const holderSpec = specFor("hold", { mode: "hold", fetchMs: HOLDER_FETCH_MS, markerFile: join(directory, "hold.started") });
  const holder = start(holderSpec);
  await waitForFile(holderSpec.markerFile);

  // Busy budget is short, so the first read gives up while the holder keeps the database locked.
  const twice = start(specFor("second", { mode: "twice", gateFile: gate, busyTimeoutMs: 300 }));
  await holder.exited;
  await Bun.write(gate, "done");
  const answers = await finishTwice(twice);
  expect(answers.reads[0]).toEqual({ failure: "unavailable", staleData: null });
  expect(answers.reads[1]).toEqual({ data: ["second"] });
}, SCENARIO_TIMEOUT_MS);

