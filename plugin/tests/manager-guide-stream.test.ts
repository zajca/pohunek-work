// The stream command of the manager guide's "Following delegated work" section, run as the guide writes it.
// The `pohunek` on PATH is a stand-in that prints the event lines of the core's `notifications watch --json`
// (`notification_created`, `notification_updated`, `notification_deleted`); the documented pipeline and its
// jq program run unchanged, so the test shows which lines the manager acts on.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";

const MANAGER_GUIDE = new URL("../prompts/manager-guide.md", import.meta.url).pathname;
const SESSION_ID = "s-0001";
const PROCESS_TIMEOUT_MS = 30_000;
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

test("the guide's stream command passes only new unread events of a launched session's turn, blocked or approval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pw-guide-stream-"));
  tempDirs.push(dir);
  const lines = [
    event("turn_completed", "unread", SESSION_ID),
    event("agent_blocked", "unread", SESSION_ID),
    event("approval_required", "unread", SESSION_ID),
    event("turn_completed", "read", SESSION_ID),
    event("session_finished", "unread", SESSION_ID),
    event("turn_completed", "unread", "s-9999"),
    JSON.stringify({ event: "notification_updated", record: { id: "n-old", kind: "turn_completed", status: "acknowledged", session_id: SESSION_ID } }),
    JSON.stringify({ event: "notification_deleted", notification_id: "n-gone" }),
  ];
  const shim = join(dir, "pohunek");
  await writeFile(shim, `#!/bin/sh\ncat <<'EVENTS'\n${lines.join("\n")}\nEVENTS\n`);
  await chmod(shim, 0o755);

  const result = await exec(["/bin/sh", "-c", await streamBlock()], {
    timeoutMs: PROCESS_TIMEOUT_MS,
    env: { PATH: `${dir}:${process.env["PATH"] ?? ""}` },
  });
  if (result.exitCode !== 0) throw new Error(`the stream command failed (${String(result.exitCode)}): ${result.stderr}`);

  const kept = result.stdout.trim().split("\n").map((line) => (JSON.parse(line) as { record: { kind: string } }).record.kind);
  expect(kept).toEqual(["turn_completed", "agent_blocked", "approval_required"]);
});
