import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportError } from "../src/cli-errors.ts";
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

test("a usage error under --json is a JSON error envelope on stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-main-"));
  const result = await run(["list", "--json", "--bogus"], dir);
  expect(result.code).toBe(2);
  const envelope = JSON.parse(result.out) as { err: { class: string; code: string; msg: string } };
  expect(envelope.err.class).toBe("usage");
  expect(envelope.err.msg).toContain("usage:");
});

test("an unexpected positional argument is a usage error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-main-"));
  expect((await run(["list", "foo"], dir)).code).toBe(2);
  expect((await run(["doctor", "--whatever"], dir)).code).toBe(2);
  expect((await run([], dir)).code).toBe(2);
});

test("do rejects unknown actions and options that do not apply, before reading the config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-main-"));
  const cases: readonly (readonly string[])[] = [
    ["do", "ABC-1", "deploy"],
    ["do", "ABC-1", "ready", "--profile", "x"],
    ["do", "ABC-1", "attach", "--profile", "x"],
  ];
  for (const args of cases) {
    const result = await run(args, dir);
    expect(result.code).toBe(2);
    expect(result.err).toContain("usage:");
    expect(result.err).not.toContain("config.toml");
  }
  const attachJson = await run(["do", "ABC-1", "attach", "--json"], dir);
  expect(attachJson.code).toBe(2);
  const envelope = JSON.parse(attachJson.out) as { err: { class: string; msg: string } };
  expect(envelope.err.class).toBe("usage");
  expect(envelope.err.msg).toContain("attach takes --json only with --dry-run");
});

test("do accepts every action name and reaches the config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-main-"));
  for (const action of ["fix-ci", "rebase", "review", "ready", "merge"]) {
    const result = await run(["do", "ABC-1", action, "--json"], dir);
    const envelope = JSON.parse(result.out) as { err: { code: string } };
    expect(envelope.err.code).toBe("config_invalid");
  }
  const attach = await run(["do", "ABC-1", "attach", "--dry-run", "--json"], dir);
  expect((JSON.parse(attach.out) as { err: { code: string } }).err.code).toBe("config_invalid");
});

test("a missing config exits 2 with a JSON error envelope under --json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-main-"));
  const result = await run(["list", "--json"], dir);
  expect(result.code).toBe(2);
  const envelope = JSON.parse(result.out) as { err: { code: string; msg: string } };
  expect(envelope.err.code).toBe("config_invalid");
  expect(envelope.err.msg).toContain("config.toml");
});

test("reportError prints the given class in the JSON envelope and returns exit 2", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string): void => {
    lines.push(line);
  };
  try {
    expect(reportError(true, "internal", "internal_error", "boom")).toBe(2);
  } finally {
    console.log = original;
  }
  const envelope = JSON.parse(lines.join("\n")) as { err: { class: string; code: string; msg: string } };
  expect(envelope.err).toEqual({ class: "internal", code: "internal_error", msg: "boom" });
});
