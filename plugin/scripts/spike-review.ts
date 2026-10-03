#!/usr/bin/env bun
// Manual real-environment check of the review launch shape (spike S8). In a
// scratch project whose origin has a branch <head-branch> at <head-sha>, it
// starts two throwaway shell sessions through the real pohunek CLI:
//   1. `--branch <fresh> --base-branch <head-branch>`: must pass the plugin's
//      checks (no daemon warning, `project show` reports <head-sha>);
//   2. the same with a base branch that origin does not have: must be refused
//      as launch_unverified (the daemon falls back to the default branch).
// Both sessions are removed afterwards; the local branches stay (spike S5) and
// are printed for the owner to delete.
//
//   POHUNEK_BIN=<absolute path> bun scripts/spike-review.ts <scratch-project-label> <head-branch> <head-sha>
//
// Run it outside a pohunek session (or with POHUNEK_SESSION_ID unset); it never
// touches a project other than the one named.
import { executePlan } from "../src/actions/launch.ts";
import { ActionError, type ActionPlan } from "../src/actions/types.ts";
import { createPohunekClient } from "../src/sources/pohunek.ts";
import type { PluginConfig } from "../src/types/config.ts";
import { exec } from "../src/util/exec.ts";

const bin = process.env["POHUNEK_BIN"];
const [label, headBranch, headSha] = process.argv.slice(2);
if (bin === undefined || label === undefined || headBranch === undefined || headSha === undefined) {
  console.error("usage: POHUNEK_BIN=<absolute path> bun scripts/spike-review.ts <scratch-project-label> <head-branch> <head-sha>");
  process.exit(2);
}

const TIMEOUT_MS = 60_000;
const config = {
  global: { actions: { launchTimeoutMs: TIMEOUT_MS, launchKillMarginMs: 5_000 }, pohunek: { bin, timeoutMs: TIMEOUT_MS, notificationsPageSize: 10 } },
} as unknown as PluginConfig;
const client = createPohunekClient(config.global.pohunek);
const suffix = Date.now().toString(36);

function reviewPlan(branch: string, baseBranch: string): ActionPlan {
  const metadata = {
    "work.link.provider": "github",
    "work.link.kind": "pull_request",
    "work.link.id": "spike/repo#1",
    "work.link.url": "https://example.invalid/spike/repo/pull/1",
    "work.link.branch": baseBranch,
    "work.role": "review",
    "work.rev": headSha ?? "",
  };
  return {
    action: "review",
    key: "github:spike/repo#1",
    project: label ?? "",
    profile: "shell",
    branch,
    baseBranch,
    expectedHead: headSha ?? "",
    cwd: null,
    name: "spike review",
    metadata,
    args: [
      "--project", label ?? "", "--branch", branch, "--base-branch", baseBranch, "--name", "spike review", "--agent", "shell",
      ...Object.entries(metadata).flatMap(([key, value]) => ["--meta", `${key}=${value}`]),
      "--input-stdin", "--request-timeout-ms", String(TIMEOUT_MS),
    ],
    prompt: "echo spike\n",
  };
}

/** Session ids to remove; a refused launch names its session in the message. */
const created: string[] = [];

let good = false;
try {
  const result = await executePlan(reviewPlan(`spike/review/${suffix}-ok`, headBranch), client, config);
  created.push(result.sessionId);
  console.log("review launch verified:", JSON.stringify({ id: result.sessionId, branch: result.branch, warnings: result.warnings }));
  good = true;
} catch (error) {
  console.log("review launch NOT verified:", error instanceof Error ? error.message : String(error));
}

let refused = false;
try {
  const result = await executePlan(reviewPlan(`spike/review/${suffix}-missing`, `missing-${suffix}`), client, config);
  created.push(result.sessionId);
  console.log("launch from a missing branch was NOT refused:", result.sessionId);
} catch (error) {
  if (error instanceof ActionError && error.code === "launch_unverified") {
    refused = true;
    console.log("launch from a missing branch refused:", error.message);
  } else {
    console.log("unexpected failure:", error instanceof Error ? error.message : String(error));
  }
}

// A refused launch still created a session; find every spike session by its name.
const listed = await client.listSessions();
if (listed.ok) {
  for (const s of listed.data) {
    if (s.name === "spike review" && !created.includes(s.id)) created.push(s.id);
  }
}
let removedOk = true;
for (const id of created) {
  const removed = await exec([bin, "session", "rm", id, "--json"], { timeoutMs: TIMEOUT_MS });
  console.log("session rm", id, "exit code:", removed.exitCode);
  removedOk &&= removed.exitCode === 0;
}
console.log(`local branches left behind: spike/review/${suffix}-ok spike/review/${suffix}-missing`);
process.exit(good && refused && removedOk ? 0 : 1);
