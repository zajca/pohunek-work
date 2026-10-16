// The pty driver runs a command in its own process group. Terminating the driver must end that whole group, so a
// child that ignores SIGHUP and outlives the driver's own exit is not left running by a test that was abandoned.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DRIVER = new URL("./support/pty-driver.py", import.meta.url).pathname;
const POLL_MS = 50;
const WAIT_MS = 10_000;
let directory: string | null = null;
let grandchild: number | null = null;

afterEach(async () => {
  if (grandchild !== null) {
    try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ }
    grandchild = null;
  }
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

/** Whether a process still runs: a zombie or a missing entry counts as ended. */
async function alive(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(() => null);
  if (stat === null) return false;
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
}

async function untilPidWritten(file: string): Promise<number> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim() !== "") return Number(text.trim());
    if (Date.now() > deadline) throw new Error("the command never wrote its child's pid");
    await Bun.sleep(POLL_MS);
  }
}

test("terminating the driver ends its command's process group, including a child that ignores SIGHUP", async () => {
  directory = await mkdtemp(join(tmpdir(), "pw-driver-"));
  const pidFile = join(directory, "child.pid");
  const spec = join(directory, "spec.json");
  // The shell ignores SIGHUP and starts a sleep that inherits the ignore; the driver leads the group the shell is in.
  await writeFile(spec, JSON.stringify({
    cmd: ["/bin/sh", "-c", `trap '' HUP; sleep 60 & echo $! > ${pidFile}; wait`],
    env: { PATH: process.env["PATH"] ?? "" },
    cols: 80,
    rows: 24,
    timeoutS: 60,
    steps: [{ pause: 60_000 }],
  }));
  const driver = Bun.spawn(["python3", DRIVER, spec], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  grandchild = await untilPidWritten(pidFile);
  expect(await alive(grandchild), "the child was not running before the driver was terminated").toBe(true);

  driver.kill("SIGTERM");
  await driver.exited;

  const deadline = Date.now() + WAIT_MS;
  while (await alive(grandchild)) {
    if (Date.now() > deadline) break;
    await Bun.sleep(POLL_MS);
  }
  expect(await alive(grandchild), "the child outlived the terminated driver").toBe(false);
  grandchild = null;
}, WAIT_MS * 2);
