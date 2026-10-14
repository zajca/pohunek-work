// The stream command of the manager guide's "Following delegated work" section, run as the guide writes it.
// The `pohunek` on PATH is a stand-in that prints the event lines of the core's `notifications watch --json`
// (`notification_created`, `notification_updated`, `notification_deleted`) and then stays open, as the real
// stream does. The documented pipeline and its jq program run unchanged. Two scenarios: the lines the manager
// acts on are selected, and a matching line reaches the reader while the producer is still running.
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
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

/** The bash block of the guide that pipes `notifications watch --json` into jq. */
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

/** The first chunk that completes a line from `stream`, or whatever arrived when `deadlineMs` passed. */
function firstLine(stream: Readable | null, deadlineMs: number): Promise<string> {
  if (stream === null) throw new Error("the stream command has no stdout");
  return new Promise((resolve) => {
    let received = "";
    const finish = (): void => {
      clearTimeout(timer);
      stream.off("data", onData);
      resolve(received);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.toString("utf8");
      if (received.includes("\n")) finish();
    };
    const timer = setTimeout(finish, deadlineMs);
    stream.on("data", onData);
  });
}

/** Ends every process of the group `pid` leads; a group that already exited is the state cleanup wants. */
function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
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

  const result = await exec(["bash", "-c", await streamBlock()], {
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
  // detached makes the shell a process-group leader on POSIX (Linux and macOS), so cleanup can end the shim, sleep and jq as well.
  const child = spawn("bash", ["-c", await streamBlock()], {
    env: { PATH: `${dir}:${process.env["PATH"] ?? ""}` },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("the stream command did not start");
  const exited = once(child, "exit");
  try {
    const received = await firstLine(child.stdout, DELIVERY_DEADLINE_MS);
    expect(received).toContain(`"kind":"turn_completed"`);
    // The line arrived before the producer's hold ended, so the pipeline did not wait for the producer to exit.
    expect(Date.now() - started).toBeLessThan(HOLD_OPEN_SECS * 1000);
  } finally {
    killProcessGroup(pid);
    await exited;
  }
}, PROCESS_TIMEOUT_MS);
