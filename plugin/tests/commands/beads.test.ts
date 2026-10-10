import { expect, test } from "bun:test";
import { BeadsError, BeadsUsageError, parseBeadsArgs, runBeads } from "../../src/commands/beads.ts";
import type { Exec, ExecResult } from "../../src/util/exec.ts";

const BASE = [
  "--workspace", "/tmp/beads-workspace",
  "--bd-bin", "/usr/local/bin/bd",
  "--repo-url", "https://github.com/zajca/pohunek",
  "--project", "pohunek",
  "--actor", "manager",
  "--timeout-ms", "5000",
] as const;

const READY = [
  { id: "pilot-a", title: "Start task", priority: 1, status: "open", external_ref: "https://github.com/zajca/pohunek/issues/754" },
  { id: "pilot-b", title: "Unlinked task", priority: 2, status: "open" },
  { id: "pilot-c", title: "Other repo", priority: 2, status: "open", external_ref: "https://github.com/other/repo/issues/4" },
  { id: "pilot-d", title: "PR is not an issue", priority: 2, status: "open", external_ref: "https://github.com/zajca/pohunek/pull/4" },
];

function result(stdout: unknown, exitCode = 0): ExecResult {
  return { stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "failure", exitCode, timedOut: false };
}

function fakeExec(outputs: readonly ExecResult[]): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (argv, options) => {
    calls.push([...argv]);
    expect(options.cwd).toBe("/tmp/beads-workspace");
    expect(options.timeoutMs).toBe(5000);
    const output = outputs[calls.length - 1];
    if (output === undefined) throw new Error("unexpected bd call");
    return Promise.resolve(output);
  };
  return { exec, calls };
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BeadsError) return error.code;
    throw error;
  }
  throw new Error("expected a Beads failure");
}

test("ready maps canonical GitHub issues and reports every unlinked bead", async () => {
  const { exec, calls } = fakeExec([result(READY)]);
  const output = await runBeads(parseBeadsArgs(["ready", ...BASE]), exec);
  expect(calls).toEqual([["/usr/local/bin/bd", "--actor", "manager", "ready", "--limit", "0", "--json"]]);
  expect(output).toEqual({ action: "ready", items: [
    { id: "pilot-a", title: "Start task", priority: 1, issue_key: "github-issue:zajca/pohunek#754", reason: null },
    { id: "pilot-b", title: "Unlinked task", priority: 2, issue_key: null, reason: "missing_external_ref" },
    { id: "pilot-c", title: "Other repo", priority: 2, issue_key: null, reason: "different_repo" },
    { id: "pilot-d", title: "PR is not an issue", priority: 2, issue_key: null, reason: "invalid_external_ref" },
  ] });
});

test("claim dry run proposes the existing do action without writing", async () => {
  const { exec, calls } = fakeExec([result(READY)]);
  const output = await runBeads(parseBeadsArgs(["claim", "pilot-a", ...BASE, "--dry-run"]), exec);
  expect(calls).toHaveLength(1);
  expect(output).toEqual({
    action: "claim", id: "pilot-a", issue_key: "github-issue:zajca/pohunek#754", assignee: null,
    claimed: false,
    next_argv: ["pohunek-work", "do", "github-issue:zajca/pohunek#754", "implement", "--project", "pohunek", "--dry-run", "--json"],
  });
});

test("claim checks readiness and link, then verifies the atomic update response", async () => {
  const updated = [{ ...READY[0], status: "in_progress", assignee: "manager" }];
  const { exec, calls } = fakeExec([result(READY), result(updated)]);
  const output = await runBeads(parseBeadsArgs(["claim", "pilot-a", ...BASE, "--yes"]), exec);
  expect(calls[1]).toEqual(["/usr/local/bin/bd", "--actor", "manager", "update", "pilot-a", "--claim", "--json"]);
  expect(output.action).toBe("claim");
  if (output.action === "claim") {
    expect(output.claimed).toBe(true);
    expect(output.assignee).toBe("manager");
  }
});

test("claim refuses stale readiness, an unlinked task, and a failed competing claim", async () => {
  const missing = fakeExec([result(READY)]);
  expect(await failureCode(runBeads(parseBeadsArgs(["claim", "pilot-missing", ...BASE, "--yes"]), missing.exec))).toBe("not_ready");
  expect(missing.calls).toHaveLength(1);
  const unlinked = fakeExec([result(READY)]);
  expect(await failureCode(runBeads(parseBeadsArgs(["claim", "pilot-b", ...BASE, "--yes"]), unlinked.exec))).toBe("unlinked");
  expect(unlinked.calls).toHaveLength(1);
  const raced = fakeExec([result(READY), result("", 13)]);
  expect(await failureCode(runBeads(parseBeadsArgs(["claim", "pilot-a", ...BASE, "--yes"]), raced.exec))).toBe("command_failed");
});

test("a successful but unverifiable claim tells the manager to inspect before retrying", async () => {
  const { exec } = fakeExec([result(READY), result("not json")]);
  expect(await failureCode(runBeads(parseBeadsArgs(["claim", "pilot-a", ...BASE, "--yes"]), exec))).toBe("claim_unverified");
  const wrongActor = fakeExec([result(READY), result([{ ...READY[0], status: "in_progress", assignee: "someone-else" }])]);
  expect(await failureCode(runBeads(parseBeadsArgs(["claim", "pilot-a", ...BASE, "--yes"]), wrongActor.exec))).toBe("claim_unverified");
});

test("invalid Beads output and unsafe arguments fail before a write", async () => {
  const invalid = fakeExec([result([{ id: "pilot-a", title: "X", priority: 1, status: "in_progress" }])]);
  expect(await failureCode(runBeads(parseBeadsArgs(["ready", ...BASE]), invalid.exec))).toBe("invalid_output");
  expect(() => parseBeadsArgs(["claim", "-oops", ...BASE, "--yes"])).toThrow(BeadsUsageError);
  expect(() => parseBeadsArgs(["ready", ...BASE, "--yes"])).toThrow(BeadsUsageError);
  expect(() => parseBeadsArgs(["claim", "pilot-a", ...BASE])).toThrow(BeadsUsageError);
  expect(() => parseBeadsArgs(["ready", ...BASE, "--repo-url", "http://github.com/zajca/pohunek"])).toThrow(BeadsUsageError);
});
