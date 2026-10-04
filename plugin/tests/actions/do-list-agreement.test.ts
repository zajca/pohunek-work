// `list` advertises a worktree action (babysit, fix-ci, rebase) exactly when `do --dry-run` accepts it.
import { expect, test } from "bun:test";
import { runDo, type DoOutput } from "../../src/commands/do.ts";
import { runList } from "../../src/commands/list.ts";
import type { PohunekSession, PullRequest } from "../../src/types/sources.ts";
import type { ListItem, RuleNumber } from "../../src/types/item.ts";
import { check, deliveredPr, issue, pr, session } from "../rules/builders.ts";
import { baseConfig, expectRefusal, fail, ok, options, setup, type Envelope } from "./harness.ts";

const SHA = "a".repeat(40);
const BRANCH = "feature/x";

interface RuleCase {
  readonly pullRequest: PullRequest;
  readonly rule: RuleNumber;
  readonly reason: string;
  readonly action: "babysit" | "fix-ci" | "rebase";
}

const CASES: readonly RuleCase[] = [
  { pullRequest: deliveredPr({ headRefName: BRANCH, headSha: SHA, timeline: [] }), rule: 4, reason: "respond", action: "babysit" },
  { pullRequest: pr({ headRefName: BRANCH, headSha: SHA, checks: [check("build", "failure")] }), rule: 5, reason: "fix CI", action: "fix-ci" },
  { pullRequest: pr({ headRefName: BRANCH, headSha: SHA, mergeable: "CONFLICTING" }), rule: 5, reason: "rebase", action: "rebase" },
  {
    pullRequest: pr({ headRefName: BRANCH, headSha: SHA, mergeable: "CONFLICTING", checks: [check("build", "failure")] }),
    rule: 5,
    reason: "rebase",
    action: "rebase",
  },
  {
    pullRequest: pr({ headRefName: BRANCH, headSha: SHA, checks: [check("Policy / Label", "failure"), check("build", "failure")] }),
    rule: 5,
    reason: "fix CI",
    action: "fix-ci",
  },
];

function linked(pullRequest: PullRequest, worktreePath: string | null): PohunekSession {
  return session({
    id: worktreePath === null ? "s-plain" : "s-owner",
    state: "stopped",
    activity: null,
    branch: BRANCH,
    worktreePath,
    metadata: { "work.link.id": pullRequest.id, "work.link.provider": "github", "work.role": "implement" },
  });
}

async function listedRow(pullRequest: PullRequest, sessions: readonly PohunekSession[]): Promise<ListItem> {
  const { deps } = setup({ prs: ok("github", [pullRequest]), sessions });
  const out = await runList(baseConfig, { mine: false, staleDays: null, json: true, project: "widgets" }, deps);
  const row = out.items.find((item) => item.key === `github:${pullRequest.id}`);
  if (row === undefined) throw new Error(`no row for ${pullRequest.id}`);
  return row;
}

function dryRun(rule: RuleCase, sessions: readonly PohunekSession[]): Promise<DoOutput> {
  const { deps } = setup({ prs: ok("github", [rule.pullRequest]), sessions });
  const doOptions = options({ key: `github:${rule.pullRequest.id}`, action: rule.action, profile: "profile-a", dryRun: true, yes: false });
  return runDo(baseConfig, doOptions, deps);
}

const WITHOUT_WORKTREE: readonly [string, (pullRequest: PullRequest) => readonly PohunekSession[]][] = [
  ["no linked session", () => []],
  ["a linked session without a worktree", (pullRequest) => [linked(pullRequest, null)]],
];

for (const rule of CASES) {
  const name = `rule ${String(rule.rule)} (${rule.reason})`;

  test(`${name} lists ${rule.action} and do --dry-run accepts it with a worktree-owning linked session`, async () => {
    const sessions = [linked(rule.pullRequest, "/wt/owner")];
    const row = await listedRow(rule.pullRequest, sessions);
    expect(row.on_turn).toEqual({ actor: "me", reason: rule.reason, rule: rule.rule });
    expect(row.actions.map((action) => action.name)).toEqual([rule.action]);
    const envelope = JSON.parse((await dryRun(rule, sessions)).stdout) as Envelope;
    expect(envelope.ok.dry_run).toBe(true);
    expect(envelope.ok.plan.cwd).toBe("/wt/owner");
  });

  for (const [label, sessionsOf] of WITHOUT_WORKTREE) {
    test(`${name} with ${label} keeps on_turn, lists no ${rule.action}, and do refuses with no_worktree`, async () => {
      const sessions = sessionsOf(rule.pullRequest);
      const row = await listedRow(rule.pullRequest, sessions);
      expect(row.on_turn).toEqual({ actor: "me", reason: rule.reason, rule: rule.rule });
      expect(row.actions).toEqual([]);
      await expectRefusal(dryRun(rule, sessions), "no_worktree", `${rule.action} refused`);
    });
  }
}

/** Rule 5 rows that `list` gives no worktree action, with the worktree actions `do` must refuse. */
const REFUSED: readonly [string, PullRequest, string][] = [
  ["a conflict with a failing check", pr({ headRefName: BRANCH, headSha: SHA, mergeable: "CONFLICTING", checks: [check("build", "failure")] }), "rebase"],
  ["a policy-only failure", pr({ headRefName: BRANCH, headSha: SHA, checks: [check("Policy / Label", "failure")] }), "policy check: Policy / Label"],
];

for (const [label, pullRequest, reason] of REFUSED) {
  test(`rule 5 with ${label} lists no fix-ci and do --dry-run refuses it`, async () => {
    const sessions = [linked(pullRequest, "/wt/owner")];
    const row = await listedRow(pullRequest, sessions);
    expect(row.on_turn).toEqual({ actor: "me", reason, rule: 5 });
    expect(row.actions.map((action) => action.name)).not.toContain("fix-ci");
    await expectRefusal(dryRun({ pullRequest, rule: 5, reason, action: "fix-ci" }, sessions), "precondition_failed", "fix-ci refused");
  });
}

test("rule 5 with a policy-only failure lists no action and do --dry-run refuses rebase", async () => {
  const pullRequest = pr({ headRefName: BRANCH, headSha: SHA, checks: [check("Policy / Label", "failure")] });
  const sessions = [linked(pullRequest, "/wt/owner")];
  expect((await listedRow(pullRequest, sessions)).actions).toEqual([]);
  const rule: RuleCase = { pullRequest, rule: 5, reason: "policy check: Policy / Label", action: "rebase" };
  await expectRefusal(dryRun(rule, sessions), "precondition_failed", "rebase refused");
});

test("a pull request joined to a paused issue lists no action and do --dry-run refuses every action", async () => {
  const pullRequest = pr({ headRefName: "alice/ABC-1/work", headSha: SHA, isDraft: true, mergeable: "CONFLICTING", checks: [check("build", "failure")] });
  const world = { prs: ok("github", [pullRequest]), issues: ok("linear", [issue({ state: "On hold", paused: true })]), sessions: [linked(pullRequest, "/wt/owner")] };
  const out = await runList(baseConfig, { mine: false, staleDays: null, json: true, project: "widgets" }, setup(world).deps);
  expect(out.items.map((item) => [item.key, item.on_turn, item.actions])).toEqual([
    ["linear:ABC-1", { actor: "paused", reason: "paused", rule: 12 }, []],
  ]);
  for (const action of ["implement", "babysit", "fix-ci", "rebase", "review", "ready", "attach"] as const) {
    const doOptions = options({ key: "linear:ABC-1", action, profile: "profile-a", dryRun: true, yes: false });
    await expectRefusal(runDo(baseConfig, doOptions, setup(world).deps), "precondition_failed", `${action} refused`);
  }
});

test("a secondary pull request of a paused Linear issue is paused, lists no action and do refuses every action", async () => {
  const winner = pr({ id: "acme/widgets#12", number: 12, headRefName: "alice/ABC-1/a", headSha: SHA, isDraft: true });
  const secondary = pr({ id: "acme/widgets#13", number: 13, headRefName: "alice/ABC-1/b", headSha: SHA, isDraft: true, mergeable: "CONFLICTING", checks: [check("build", "failure")] });
  const owner = session({ id: "s-sec", state: "stopped", activity: null, branch: secondary.headRefName, worktreePath: "/wt/sec", metadata: { "work.link.id": secondary.id, "work.link.provider": "github", "work.role": "implement" } });
  const world = { prs: ok("github", [winner, secondary]), issues: ok("linear", [issue({ state: "On hold", paused: true })]), sessions: [owner] };
  const out = await runList(baseConfig, { mine: false, staleDays: null, json: true, project: "widgets" }, setup(world).deps);
  const row = out.items.find((item) => item.key === "github:acme/widgets#13");
  expect(row).toMatchObject({ issue: null, issue_key: "ABC-1", on_turn: { actor: "paused", reason: "paused", rule: 12 }, actions: [] });
  for (const action of ["babysit", "fix-ci", "rebase", "ready", "attach"] as const) {
    const doOptions = options({ key: "github:acme/widgets#13", action, profile: "profile-a", dryRun: true, yes: false });
    await expectRefusal(runDo(baseConfig, doOptions, setup(world).deps), "precondition_failed", `${action} refused`);
  }
});

test("a secondary pull request of a Linear issue is unknown while Linear is down", async () => {
  const winner = pr({ id: "acme/widgets#12", number: 12, headRefName: "alice/ABC-1/a", headSha: SHA });
  const secondary = pr({ id: "acme/widgets#13", number: 13, headRefName: "alice/ABC-1/b", headSha: SHA, mergeable: "CONFLICTING" });
  const world = { prs: ok("github", [winner, secondary]), issues: fail("linear", "timeout") };
  const out = await runList(baseConfig, { mine: false, staleDays: null, json: true, project: "widgets" }, setup(world).deps);
  const row = out.items.find((item) => item.key === "github:acme/widgets#13");
  expect(row).toMatchObject({ on_turn: { actor: "unknown", reason: "linear:timeout", rule: null }, actions: [] });
});

