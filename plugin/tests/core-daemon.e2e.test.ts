// End-to-end scenario of the real-daemon fixture itself: a live shell session started through the
// pinned CLI binds its worker socket at the path whose length the fixture checks before the daemon
// starts, and stopping the fixture leaves no session worker running and removes its directories.
import { afterEach, expect, test } from "bun:test";
import { access, stat } from "node:fs/promises";
import { startCoreDaemon, workersBelow, type CoreDaemon } from "./helpers/core-daemon.ts";

const SCENARIO_TIMEOUT_MS = 60_000;
const SOCKET_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

let daemon: CoreDaemon | null = null;

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForSocket(path: string): Promise<void> {
  const deadline = Date.now() + SOCKET_TIMEOUT_MS;
  for (;;) {
    try {
      if ((await stat(path)).isSocket()) return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() > deadline) throw new Error(`no socket at ${path} within ${String(SOCKET_TIMEOUT_MS)} ms`);
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

test("a live shell session binds its worker socket at the checked length and its worker does not survive stop()", async () => {
  const fixture = await startCoreDaemon();
  daemon = fixture;
  const created = await fixture.pohunek(["session", "new", "--agent", "shell", "--cwd", fixture.root, "--name", "fixture", "--json"]);
  const id = (JSON.parse(created.stdout) as { ok?: { id?: unknown } }).ok?.id;
  if (typeof id !== "string") throw new Error(`session new failed: ${created.stdout}${created.stderr}`);

  const socket = fixture.workerSocketPath(id);
  await waitForSocket(socket);
  expect(Buffer.byteLength(socket)).toBe(Buffer.byteLength(fixture.longestSocketPath));
  expect(await workersBelow(fixture.runtimeDir)).toHaveLength(1);

  await fixture.stop();
  expect(await workersBelow(fixture.runtimeDir)).toEqual([]);
  expect(await exists(fixture.root)).toBe(false);
  expect(await exists(fixture.runtimeDir)).toBe(false);
}, SCENARIO_TIMEOUT_MS);
