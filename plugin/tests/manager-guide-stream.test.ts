// The stream command of the manager guide's "Following delegated work" section, run as the guide writes it.
// The `pohunek` on PATH is a stand-in that prints the event lines of the core's `notifications watch --json`
// (`notification_created`, `notification_updated`, `notification_deleted`) and then stays open, as the real
// stream does. The documented pipeline and its jq program run unchanged. Two scenarios: the lines the manager
// acts on are selected, and a matching line reaches the reader while the producer is still running.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";

const MANAGER_GUIDE = new URL("../prompts/manager-guide.md", import.meta.url).pathname;
const SESSION_ID = "s-0001";
const PROCESS_TIMEOUT_MS = 30_000;
/** Time within which a matching line must reach the reader; the producer stays open for `HOLD_OPEN_SECS` after it. */
const DELIVERY_DEADLINE_MS = 3000;
const HOLD_OPEN_SECS = 8;
const FENCE = "```";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The shell block of the guide that pipes `notifications watch --json` into jq. */
async function streamBlock(): Promise<string> {
  const guide = await readFile(MANAGER_GUIDE, "utf8");
  const blocks = guide.split(FENCE).filter((_, index) => index % 2 === 1);
  const block = blocks.find((text) => text.includes("pohunek notifications watch --json | jq"));
  if (block === undefined) throw new Error("the guide has no stream command");
  return block.replace(/^bash\n/, "").replace("<session id>", SESSION_ID);
}

function event(kind: string, status: string, sessionId: string): string {
  return JSON.stringify({ event: "notification_created", record: { id: `n-${kind}-${status}`, kind, status, session_id: sessionId } });
}

/** A `pohunek` stand-in that prints `lines`, then stays open for `holdSecs` like the real stream. */
async function shimDir(lines: readonly string[], holdSecs: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pw-guide-stream-"));
  tempDirs.push(dir);
  const shim = join(dir, "pohunek");
  await writeFile(shim, `#!/bin/sh\ncat <<'EVENTS'\n${lines.join("\n")}\nEVENTS\nsleep ${String(holdSecs)}\n`);
  await chmod(shim, 0o755);
  return dir;
}

test("the guide's stream command passes only new unread events of a launched session's turn, blocked or approval", async () => {
  const dir = await shimDir(
    [
      event("turn_completed", "unread", SESSION_ID),
      event("agent_blocked", "unread", SESSION_ID),
      event("approval_required", "unread", SESSION_ID),
      event("turn_completed", "read", SESSION_ID),
      event("session_finished", "unread", SESSION_ID),
      event("turn_completed", "unread", "s-9999"),
      JSON.stringify({ event: "notification_updated", record: { id: "n-old", kind: "turn_completed", status: "acknowledged", session_id: SESSION_ID } }),
      JSON.stringify({ event: "notification_deleted", notification_id: "n-gone" }),
    ],
    0,
  );

  const result = await exec(["/bin/sh", "-c", await streamBlock()], {
    timeoutMs: PROCESS_TIMEOUT_MS,
    env: { PATH: `${dir}:${process.env["PATH"] ?? ""}` },
  });
  if (result.exitCode !== 0) throw new Error(`the stream command failed (${String(result.exitCode)}): ${result.stderr}`);

  const kept = result.stdout.trim().split("\n").map((line) => (JSON.parse(line) as { record: { kind: string } }).record.kind);
  expect(kept).toEqual(["turn_completed", "agent_blocked", "approval_required"]);
});

test("the guide's stream command delivers a matching line while the producer is still open", async () => {
  const dir = await shimDir([event("turn_completed", "unread", SESSION_ID)], HOLD_OPEN_SECS);
  const started = Date.now();
  // setsid makes the shell a process-group leader, so cleanup can end the shim, sleep and jq as well.
  const child = Bun.spawn(["setsid", "/bin/sh", "-c", await streamBlock()], {
    env: { PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("\n")) {
      const next = await Promise.race([reader.read(), Bun.sleep(DELIVERY_DEADLINE_MS).then(() => null)]);
      if (next === null) break;
      if (next.done) break;
      received += decoder.decode(next.value);
    }
    reader.releaseLock();
    expect(received).toContain(`"kind":"turn_completed"`);
    // The line arrived before the producer's hold ended, so the pipeline did not wait for the producer to exit.
    expect(Date.now() - started).toBeLessThan(HOLD_OPEN_SECS * 1000);
  } finally {
    process.kill(-child.pid, "SIGKILL");
    await child.exited;
  }
}, PROCESS_TIMEOUT_MS);
