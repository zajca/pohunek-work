import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("file logging keeps secrets and error causes out of owner-private files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pohunek-log-integration-"));
  roots.push(root);
  const logDir = join(root, "logs");
  const secret = "fake-token-not-real";
  const log = createLogger({
    logDir,
    command: "list",
    maxStringLength: 1024,
    now: () => new Date("2026-10-01T12:00:00.000Z"),
  });

  log.info("request", { Authorization: `Bearer ${secret}`, nested: { apiKey: secret } });
  log.error("failed", { error: new TypeError("bad input", { cause: new Error(secret) }) });
  await log.close();

  const file = join(logDir, "list.log");
  expect((await stat(logDir)).mode & 0o777).toBe(0o700);
  expect((await stat(file)).mode & 0o777).toBe(0o600);

  const raw = await readFile(file, "utf8");
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain("stack");
  expect(raw).not.toContain("cause");
  const lines = raw.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatchObject({ Authorization: "[redacted]", nested: { apiKey: "[redacted]" } });
  expect(lines[1]?.["error"]).toEqual({ name: "TypeError", message: "bad input" });
});
