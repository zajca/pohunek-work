import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, execInteractive, SpawnError } from "../../src/util/exec.ts";

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

test("execInteractive resolves with the child's exit code", async () => {
  expect(await execInteractive(["/bin/sh", "-c", "exit 3"])).toBe(3);
  expect(await execInteractive(["/bin/sh", "-c", "exit 0"])).toBe(0);
});

test("execInteractive hands all three stdio streams to the child (do attach, docs/tui-plan.md 4.4)", async () => {
  const script = new URL("../fixtures/interactive-child.ts", import.meta.url).pathname;
  const result = await exec(["bun", script], { timeoutMs: 20_000, stdin: "typed\n" });
  expect(result.stdout).toBe("out:typed\n");
  expect(result.stderr).toBe("err:typed\n");
  expect(result.exitCode).toBe(4);
});

test("execInteractive reports a missing binary as SpawnError", async () => {
  const failure = await execInteractive(["/nonexistent/binary"]).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(SpawnError);
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

test("a timeout ends grandchildren in the process group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-exec-"));
  const pidFile = join(dir, "pid");
  const script = `sleep 30 & echo $! > ${pidFile}; wait`;
  const result = await exec(["/bin/sh", "-c", script], { timeoutMs: 400 });
  expect(result.timedOut).toBe(true);
  const grandchild = Number((await readFile(pidFile, "utf8")).trim());
  expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
  await Bun.sleep(200);
  const alive = ((): boolean => {
    try {
      process.kill(grandchild, 0);
      return true;
    } catch {
      return false;
    }
  })();
  expect(alive).toBe(false);
});
