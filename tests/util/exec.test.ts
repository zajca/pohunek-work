import { expect, test } from "bun:test";
import { exec, SpawnError } from "../../src/util/exec.ts";

test("captures stdout and exit code", async () => {
  const result = await exec(["/bin/sh", "-c", "printf out; printf err >&2; exit 3"], { timeoutMs: 5000 });
  expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "err", timedOut: false });
});

test("passes stdin to the child", async () => {
  const result = await exec(["/bin/cat"], { timeoutMs: 5000, stdin: "hello" });
  expect(result.stdout).toBe("hello");
});

test("kills the child on timeout", async () => {
  const result = await exec(["/bin/sleep", "5"], { timeoutMs: 100 });
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).toBeNull();
});

test("does not interpret argv through a shell", async () => {
  const result = await exec(["/bin/echo", "$(echo injected); id"], { timeoutMs: 5000 });
  expect(result.stdout).toBe("$(echo injected); id\n");
});

test("reports a missing binary as SpawnError", async () => {
  const failure = await exec(["/nonexistent/binary"], { timeoutMs: 1000 }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(SpawnError);
});

test("the timeout is a hard bound even when a grandchild keeps the pipes open", async () => {
  const started = Date.now();
  const result = await exec(["/bin/sh", "-c", "sleep 5 & sleep 10"], { timeoutMs: 200 });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
});
