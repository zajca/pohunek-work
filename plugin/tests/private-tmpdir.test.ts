import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/private-tmpdir.ts", import.meta.url).pathname;
const tempDirs: string[] = [];

async function parentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pw-private-tmpdir-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("the CLI names leftovers on stderr and exits non-zero", async () => {
  const parent = await parentDir();
  const child = Bun.spawn(["bun", SCRIPT, "/bin/sh", "-c", 'touch "$TMPDIR/leak"'], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMPDIR: parent },
  });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(stderr).toContain("entries left in TMPDIR (1):\n  leak\n");
  expect(await readdir(parent)).toEqual([]);
});

test("the CLI without a command is a usage error", async () => {
  const child = Bun.spawn(["bun", SCRIPT], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(2);
  expect(stderr).toContain("usage:");
});
