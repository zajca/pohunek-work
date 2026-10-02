#!/usr/bin/env bun
// Manual real-environment check of the launch path (run before enabling an action).
// Starts two throwaway shell sessions through the real pohunek CLI in a scratch
// project: an implement-shaped one (new branch and worktree) and a babysit-shaped
// one (`--cwd` into that worktree, name with a space). Verifies the daemon echoes
// the planned link metadata and that `session list` shows it, then removes both.
//
//   POHUNEK_BIN=<absolute path> bun scripts/spike-launch.ts <scratch-project-label>
//
// Run it outside a pohunek session (or with POHUNEK_SESSION_ID unset); it never
// touches a project other than the one named.
import { executePlan } from "../src/actions/launch.ts";
import type { ActionPlan } from "../src/actions/types.ts";
import { createPohunekClient } from "../src/sources/pohunek.ts";
import type { PohunekSession } from "../src/types/sources.ts";
import type { PluginConfig } from "../src/types/config.ts";
import { exec } from "../src/util/exec.ts";

const bin = process.env["POHUNEK_BIN"];
const label = process.argv[2];
if (bin === undefined || label === undefined) {
  console.error("usage: POHUNEK_BIN=<absolute path> bun scripts/spike-launch.ts <scratch-project-label>");
  process.exit(2);
}

const TIMEOUT_MS = 60_000;
const config = {
  global: { actions: { launchTimeoutMs: TIMEOUT_MS, launchKillMarginMs: 5_000 }, pohunek: { bin, timeoutMs: TIMEOUT_MS, notificationsPageSize: 10 } },
} as unknown as PluginConfig;

const client = createPohunekClient(config.global.pohunek);

function metaArgs(metadata: Readonly<Record<string, string>>): string[] {
  return Object.entries(metadata).flatMap(([key, value]) => ["--meta", `${key}=${value}`]);
}

const branch = `spike/SP-1/launch-${Date.now().toString(36)}`;
const implementMeta = {
  "work.link.provider": "linear",
  "work.link.kind": "issue",
  "work.link.id": "SP-1",
  "work.link.url": "https://example.invalid/SP-1",
  "work.link.branch": branch,
  "work.role": "implement",
  "work.rev": "started",
};
const implement: ActionPlan = {
  action: "implement",
  key: "linear:SP-1",
  project: label,
  profile: "shell",
  branch,
  baseBranch: null,
  expectedHead: null,
  cwd: null,
  name: "SP-1",
  metadata: implementMeta,
  args: [
    "--project", label, "--branch", branch, "--name", "SP-1", "--agent", "shell",
    ...metaArgs(implementMeta),
    "--input-stdin", "--request-timeout-ms", String(TIMEOUT_MS),
  ],
  prompt: "echo spike\n",
};

const created = await executePlan(implement, client, config);
console.log("implement created:", JSON.stringify(created));
const worktree = created.worktreePath;
if (worktree === null) throw new Error("implement session has no worktree");

const babysitMeta = { ...implementMeta, "work.role": "babysit", "work.rev": "a".repeat(40) };
const babysit: ActionPlan = {
  ...implement,
  action: "babysit",
  branch: null,
  cwd: worktree,
  name: "SP-1 babysit",
  metadata: babysitMeta,
  args: [
    "--cwd", worktree, "--name", "SP-1 babysit", "--agent", "shell",
    ...metaArgs(babysitMeta),
    "--input-stdin", "--request-timeout-ms", String(TIMEOUT_MS),
  ],
};
const second = await executePlan(babysit, client, config);
console.log("babysit created:", JSON.stringify(second));

const listed = await client.listSessions();
const find = (id: string): PohunekSession | undefined => (listed.ok ? listed.data.find((s) => s.id === id) : undefined);
const carries = (id: string, metadata: Readonly<Record<string, string>>): boolean => {
  const found = find(id);
  return found !== undefined && Object.entries(metadata).every(([key, value]) => found.metadata[key] === value);
};
const visible = carries(created.sessionId, implementMeta) && carries(second.sessionId, babysitMeta);
console.log("session list shows both links:", visible);

// The second session is removed first: removing the owner would delete the shared worktree.
let removedOk = true;
for (const id of [second.sessionId, created.sessionId]) {
  const removed = await exec([bin, "session", "rm", id, "--json"], { timeoutMs: TIMEOUT_MS });
  console.log("session rm", id, "exit code:", removed.exitCode);
  removedOk &&= removed.exitCode === 0;
}
process.exit(visible && removedOk ? 0 : 1);
