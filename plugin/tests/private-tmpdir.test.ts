import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithPrivateTmpdir } from "../scripts/private-tmpdir.ts";

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

test("a command that leaves TMPDIR empty passes and the private directory is removed", async () => {
  const parent = await parentDir();
  const run = await runWithPrivateTmpdir(["/bin/sh", "-c", 'touch "$TMPDIR/x" && rm "$TMPDIR/x"'], parent);
  expect(run).toEqual({ status: 0, leftovers: [] });
  expect(await readdir(parent)).toEqual([]);
});

test("TMPDIR is a fresh directory under the parent and the rest of the environment is kept", async () => {
  const parent = await parentDir();
  const check = `case "$TMPDIR" in "${parent}"/pohunek-test-tmpdir-*) ;; *) exit 5;; esac; [ "$PW_PRIVATE_TMPDIR_PROBE" = kept ]`;
  process.env["PW_PRIVATE_TMPDIR_PROBE"] = "kept";
  try {
    expect((await runWithPrivateTmpdir(["/bin/sh", "-c", check], parent)).status).toBe(0);
  } finally {
    delete process.env["PW_PRIVATE_TMPDIR_PROBE"];
  }
});

test("leftover entries fail a successful command, are named, and are removed", async () => {
  const parent = await parentDir();
  const run = await runWithPrivateTmpdir(["/bin/sh", "-c", 'touch "$TMPDIR/b" && mkdir "$TMPDIR/a"'], parent);
  expect(run).toEqual({ status: 1, leftovers: ["a", "b"] });
  expect(await readdir(parent)).toEqual([]);
});

test("a failing command keeps its own status and still reports leftovers", async () => {
  const parent = await parentDir();
  const run = await runWithPrivateTmpdir(["/bin/sh", "-c", 'touch "$TMPDIR/x"; exit 3'], parent);
  expect(run).toEqual({ status: 3, leftovers: ["x"] });
  expect(await readdir(parent)).toEqual([]);
});

test("a command ended by a signal reports 128 plus the signal number", async () => {
  const parent = await parentDir();
  const run = await runWithPrivateTmpdir(["/bin/sh", "-c", "kill -TERM $$"], parent);
  expect(run).toEqual({ status: 143, leftovers: [] });
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
