import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;

async function run(args: readonly string[], configDir: string): Promise<{ code: number | null; out: string; err: string }> {
  const result = await exec(["bun", MAIN, ...args], {
    timeoutMs: 20_000,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: configDir,
      POHUNEK_WORK_CONFIG_DIR: join(configDir, "missing"),
      POHUNEK_WORK_STATE_DIR: join(configDir, "state"),
    },
  });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
}

test("an unknown option prints usage and exits 2 without a stack dump", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-main-"));
  const result = await run(["list", "--bogus"], dir);
  expect(result.code).toBe(2);
  expect(result.err).toContain("usage:");
  expect(result.err).not.toContain("node:internal");
});

test("an unexpected positional argument is a usage error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-main-"));
  expect((await run(["list", "foo"], dir)).code).toBe(2);
  expect((await run(["doctor", "--whatever"], dir)).code).toBe(2);
  expect((await run([], dir)).code).toBe(2);
});

test("a missing config exits 2 with a JSON error envelope under --json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-main-"));
  const result = await run(["list", "--json"], dir);
  expect(result.code).toBe(2);
  const envelope = JSON.parse(result.out) as { err: { code: string; msg: string } };
  expect(envelope.err.code).toBe("config_invalid");
  expect(envelope.err.msg).toContain("config.toml");
});
