import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, type LogValue } from "../src/log.ts";

const FAKE_TOKEN = "fake-token-not-real";
const MAX = 50;

let root: string;
let logDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pohunek-log-"));
  logDir = join(root, "logs");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function clock(): () => Date {
  return () => new Date("2026-10-01T12:00:00.000Z");
}

function make(overrides: { logDir?: string; command?: string } = {}): ReturnType<typeof createLogger> {
  return createLogger({
    logDir: overrides.logDir ?? logDir,
    command: overrides.command ?? "list",
    maxStringLength: MAX,
    now: clock(),
  });
}

async function readLines(command = "list"): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(logDir, `${command}.log`), "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("writes one JSON line per call with ts from the injected clock", async () => {
  const log = make();
  log.info("start", { count: 2 });
  log.error("boom", { reason: "x" });
  await log.close();
  const raw = await readFile(join(logDir, "list.log"), "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  const lines = await readLines();
  expect(lines).toEqual([
    { ts: "2026-10-01T12:00:00.000Z", level: "info", command: "list", event: "start", count: 2 },
    { ts: "2026-10-01T12:00:00.000Z", level: "error", command: "list", event: "boom", reason: "x" },
  ]);
  expect(log.failure()).toBeNull();
});

test("fields cannot override reserved entry keys", async () => {
  const log = make();
  log.info("real", { ts: "bogus", level: "error", command: "other", event: "fake" });
  await log.close();
  const [line] = await readLines();
  expect(line).toMatchObject({ ts: "2026-10-01T12:00:00.000Z", level: "info", command: "list", event: "real" });
});

test("creates the directory with mode 0700 and the file with mode 0600", async () => {
  const log = make();
  log.info("start");
  await log.close();
  expect((await stat(logDir)).mode & 0o777).toBe(0o700);
  expect((await stat(join(logDir, "list.log"))).mode & 0o777).toBe(0o600);
});

test("redacts secret-looking keys at any depth, case-insensitively", async () => {
  const log = make();
  log.info("e", {
    Token: "a",
    nested: { Authorization: "b", deeper: [{ client_secret: "c", ok: "visible" }] },
    API_KEY: "d",
    "api-key": "e",
    PassWord: "f",
    myCredentials: "g",
  });
  await log.close();
  const [line] = await readLines();
  expect(line).toMatchObject({
    Token: "[redacted]",
    nested: { Authorization: "[redacted]", deeper: [{ client_secret: "[redacted]", ok: "visible" }] },
    API_KEY: "[redacted]",
    "api-key": "[redacted]",
    PassWord: "[redacted]",
    myCredentials: "[redacted]",
  });
});

test("a fake token under Authorization and apiKey never reaches the file", async () => {
  const log = make();
  log.info("request", { Authorization: `Bearer ${FAKE_TOKEN}`, headers: { apiKey: FAKE_TOKEN } });
  await log.close();
  const raw = await readFile(join(logDir, "list.log"), "utf8");
  expect(raw).not.toContain(FAKE_TOKEN);
  expect(raw).toContain("[redacted]");
});

test("logs Errors as name and message only", async () => {
  const log = make();
  const error = new TypeError("bad input", { cause: new Error(`cause ${FAKE_TOKEN}`) });
  log.error("failed", { error, wrapped: { inner: error } });
  await log.close();
  const raw = await readFile(join(logDir, "list.log"), "utf8");
  expect(raw).not.toContain(FAKE_TOKEN);
  expect(raw).not.toContain("stack");
  expect(raw).not.toContain("cause");
  const [line] = await readLines();
  expect(line?.["error"]).toEqual({ name: "TypeError", message: "bad input" });
  expect(line?.["wrapped"]).toEqual({ inner: { name: "TypeError", message: "bad input" } });
});

test("sourceResult logs a success", async () => {
  const log = make();
  log.sourceResult({ ok: true, source: "github", data: { secretPayload: FAKE_TOKEN }, durationMs: 12 });
  await log.close();
  const [line] = await readLines();
  expect(line).toEqual({
    ts: "2026-10-01T12:00:00.000Z",
    level: "info",
    command: "list",
    event: "source_result",
    source: "github",
    ok: true,
    durationMs: 12,
  });
});

test("sourceResult logs a failure with code and message", async () => {
  const log = make();
  log.sourceResult({ ok: false, source: "linear", code: "timeout", message: "timed out", durationMs: 30 });
  await log.close();
  const [line] = await readLines();
  expect(line).toMatchObject({
    level: "error",
    event: "source_result",
    source: "linear",
    ok: false,
    durationMs: 30,
    code: "timeout",
    message: "timed out",
  });
});

test("truncates long strings with a marker, at any depth", async () => {
  const log = make();
  log.info("long", { text: "x".repeat(MAX + 20), list: ["y".repeat(MAX + 1)], short: "z".repeat(MAX) });
  await log.close();
  const [line] = await readLines();
  expect(line?.["text"]).toBe("x".repeat(MAX) + "...[truncated]");
  expect(line?.["list"]).toEqual(["y".repeat(MAX) + "...[truncated]"]);
  expect(line?.["short"]).toBe("z".repeat(MAX));
});

test("replaces unserializable values with a marker instead of throwing", async () => {
  const log = make();
  const cyclic: { [key: string]: LogValue } = { name: "loop" };
  cyclic["self"] = cyclic;
  const shared = { v: 1 };
  expect(() => {
    log.info("odd", {
      cyclic,
      big: 10n as unknown as LogValue,
      fn: (() => 1) as unknown as LogValue,
      nan: Number.NaN,
      a: shared,
      b: shared,
    });
  }).not.toThrow();
  await log.close();
  const [line] = await readLines();
  expect(line?.["cyclic"]).toEqual({ name: "loop", self: "[circular]" });
  expect(line?.["big"]).toBe("[unserializable]");
  expect(line?.["fn"]).toBe("[unserializable]");
  expect(line?.["nan"]).toBe("[unserializable]");
  expect(line?.["a"]).toEqual({ v: 1 });
  expect(line?.["b"]).toEqual({ v: 1 });
  expect(log.failure()).toBeNull();
});

test("a throwing getter is replaced by a marker", async () => {
  const log = make();
  const hostile = {
    get boom(): string {
      throw new Error("getter failed");
    },
  };
  log.info("hostile", { hostile });
  await log.close();
  const [line] = await readLines();
  expect(line?.["event"]).toBe("hostile");
  expect(line?.["hostile"]).toBe("[unserializable]");
});

test("an unwritable directory sets failure() and does not throw", async () => {
  const blocker = join(root, "blocker");
  await writeFile(blocker, "not a directory");
  const log = make({ logDir: join(blocker, "logs") });
  expect(() => {
    log.info("a");
    log.error("b");
  }).not.toThrow();
  await log.close();
  expect(log.failure()).toBeInstanceOf(Error);
});

test("failure() keeps the first error", async () => {
  const blocker = join(root, "blocker");
  await writeFile(blocker, "not a directory");
  const log = make({ logDir: join(blocker, "logs") });
  log.info("a");
  await log.close();
  const first = log.failure();
  log.info("b");
  await log.close();
  expect(log.failure()).toBe(first);
});

test("appends across logger instances", async () => {
  const first = make();
  first.info("one");
  await first.close();
  const second = make();
  second.info("two");
  await second.close();
  const lines = await readLines();
  expect(lines.map((line) => line["event"])).toEqual(["one", "two"]);
});

test("rejects command names that could escape the log directory", () => {
  expect(() => make({ command: "../evil" })).toThrow();
  expect(() => make({ command: "" })).toThrow();
});

test("requires a positive integer maxStringLength", () => {
  expect(() => createLogger({ logDir, command: "list", maxStringLength: 0 })).toThrow();
});
