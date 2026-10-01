import { expect, test } from "bun:test";
import { keyringEntryPresent, readKeyringSecret } from "../../src/sources/keyring.ts";
import type { LinearConfig } from "../../src/types/config.ts";
import { SpawnError, type Exec, type ExecResult } from "../../src/util/exec.ts";

const FAKE = "fake-token-not-real";
const config: LinearConfig = {
  endpoint: "https://linear.example/graphql",
  secretToolBin: "/usr/bin/secret-tool-fake",
  keyringService: "svc-fake",
  keyringKey: "key-fake",
  timeoutMs: 1234,
  pageSize: 10,
};

function execReturning(result: Partial<ExecResult>, calls?: { argv: readonly string[]; timeoutMs: number }[]): Exec {
  return (argv, options) => {
    calls?.push({ argv, timeoutMs: options.timeoutMs });
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result });
  };
}

test("uses the exact secret-tool argv and configured timeout", async () => {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = [];
  await readKeyringSecret(config, { exec: execReturning({ stdout: FAKE }, calls) });
  expect(calls).toEqual([
    {
      argv: ["/usr/bin/secret-tool-fake", "lookup", "service", "svc-fake", "username", "key-fake"],
      timeoutMs: 1234,
    },
  ]);
});

test("trims exactly one trailing newline", async () => {
  const result = await readKeyringSecret(config, { exec: execReturning({ stdout: `${FAKE}\n\n` }) });
  expect(result).toEqual({ ok: true, secret: `${FAKE}\n` });
  const plain = await readKeyringSecret(config, { exec: execReturning({ stdout: FAKE }) });
  expect(plain).toEqual({ ok: true, secret: FAKE });
});

test("exit 1 with empty stdout is not_found", async () => {
  const result = await readKeyringSecret(config, { exec: execReturning({ exitCode: 1 }) });
  expect(result).toMatchObject({ ok: false, kind: "not_found" });
});

test("exit 0 with empty stdout is not_found", async () => {
  const result = await readKeyringSecret(config, { exec: execReturning({ stdout: "\n" }) });
  expect(result).toMatchObject({ ok: false, kind: "not_found" });
});

test("stderr mentioning lock or unlock is locked", async () => {
  for (const stderr of ["Collection is locked", "Cannot unlock keyring"]) {
    const result = await readKeyringSecret(config, { exec: execReturning({ exitCode: 1, stderr }) });
    expect(result).toMatchObject({ ok: false, kind: "locked" });
  }
});

test("other non-zero exits are unavailable", async () => {
  const result = await readKeyringSecret(config, { exec: execReturning({ exitCode: 2, stderr: "boom" }) });
  expect(result).toMatchObject({ ok: false, kind: "unavailable" });
});

test("spawn error and timeout are unavailable", async () => {
  const spawn: Exec = () => Promise.reject(new SpawnError("secret-tool", new Error("ENOENT")));
  expect(await readKeyringSecret(config, { exec: spawn })).toMatchObject({ ok: false, kind: "unavailable" });
  const timeout = await readKeyringSecret(config, {
    exec: execReturning({ exitCode: null, timedOut: true }),
  });
  expect(timeout).toMatchObject({ ok: false, kind: "unavailable" });
});

test("failure messages never contain the secret or tool output", async () => {
  const result = await readKeyringSecret(config, {
    exec: execReturning({ exitCode: 2, stdout: FAKE, stderr: `provider text ${FAKE}` }),
  });
  expect(JSON.stringify(result)).not.toContain(FAKE);
  expect(JSON.stringify(result)).not.toContain("provider text");
});

test("keyringEntryPresent discards the value", async () => {
  const present = await keyringEntryPresent(config, { exec: execReturning({ stdout: `${FAKE}\n` }) });
  expect(present).toEqual({ present: true });
  expect(JSON.stringify(present)).not.toContain(FAKE);
});

test("keyringEntryPresent reports the failure kind", async () => {
  expect(await keyringEntryPresent(config, { exec: execReturning({ exitCode: 1 }) })).toEqual({
    present: false,
    kind: "not_found",
  });
  expect(await keyringEntryPresent(config, { exec: execReturning({ stdout: "" }) })).toEqual({
    present: false,
    kind: "not_found",
  });
});
