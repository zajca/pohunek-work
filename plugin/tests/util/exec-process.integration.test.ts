import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, execInteractiveCapture } from "../../src/util/exec.ts";

test("an interactive child keeps its exit code and bounded stdout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-interactive-capture-"));
  try {
    const binary = join(dir, "child");
    await writeFile(binary, '#!/usr/bin/env bun\nprocess.stdout.write("{\\"ok\\":true}\\n"); process.exit(7);\n');
    await chmod(binary, 0o700);
    expect(await execInteractiveCapture([binary], 100)).toEqual({ exitCode: 7, stdout: '{"ok":true}\n' });
    expect(await execInteractiveCapture([binary], 1)).toEqual({ exitCode: 7, stdout: null });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a timeout stays bounded when a grandchild keeps the pipes open", async () => {
  const started = Date.now();
  const result = await exec(["/bin/sh", "-c", "sleep 5 & sleep 10"], { timeoutMs: 200 });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
});

test("a timeout ends descendants in the process group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-exec-process-"));
  try {
    const pidFile = join(dir, "pid");
    const script = 'sleep 30 & echo $! > "$1"; wait';
    const result = await exec(["/bin/sh", "-c", script, "_", pidFile], { timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());
    expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
    const deadline = Date.now() + 2000;
    let state: string;
    do {
      const probe = Bun.spawn(["ps", "-o", "stat=", "-p", String(grandchild)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      state = (await new Response(probe.stdout).text()).trim();
      await probe.exited;
      if (state === "" || state.startsWith("Z")) break;
      await Bun.sleep(50);
    } while (Date.now() < deadline);
    expect(state === "" || state.startsWith("Z")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
