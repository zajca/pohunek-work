// babysit, fix-ci and rebase on a row whose linked sessions own no worktree adopt the pull request's head branch.
import { expect, test } from "bun:test";
import { runDo, type DoOptions } from "../../src/commands/do.ts";
import { runList } from "../../src/commands/list.ts";
import type { PohunekWorktree } from "../../src/sources/pohunek.ts";
import type { PullRequest } from "../../src/types/sources.ts";
import { check, issue, pr, session } from "../rules/builders.ts";
import { BIN, baseConfig, expectRefusal, fail, HOSTILE_TITLE, ok, options, setup, type Envelope, type World } from "./harness.ts";

const SHA = "a".repeat(40);
const BRANCH = "feature/x";
const CASES: readonly { action: "babysit" | "fix-ci" | "rebase"; pullRequest: PullRequest }[] = [
  { action: "babysit", pullRequest: pr({ headRefName: BRANCH, headSha: SHA, title: HOSTILE_TITLE, reviewRequests: [{ kind: "user", login: "someone" }] }) },
  { action: "fix-ci", pullRequest: pr({ headRefName: BRANCH, headSha: SHA, title: HOSTILE_TITLE, checks: [check("build", "failure")] }) },
  { action: "rebase", pullRequest: pr({ headRefName: BRANCH, headSha: SHA, title: HOSTILE_TITLE, mergeable: "CONFLICTING" }) },
];

function doOptions(key: string, action: DoOptions["action"], overrides: Partial<DoOptions> = {}): DoOptions {
  return options({ key, action, profile: "profile-a", ...overrides });
}

/** Worktree list before the launch (the primary checkout only) and after it (plus the new session's worktree). */
function worktreesAround(head: string): NonNullable<World["worktrees"]> {
  let reads = 0;
  return () => {
    reads += 1;
    const primary: PohunekWorktree = { path: "/repo", branch: "main", head: "f".repeat(40), sessionId: null };
    return ok("pohunek", reads === 1 ? [primary] : [primary, { path: "/wt/new", branch: BRANCH, head, sessionId: "s-new" }]);
  };
}

for (const { action, pullRequest } of CASES) {
  const key = `github:${pullRequest.id}`;

  test(`${action} adopts the head branch itself: --project, --branch and --base-branch name it and the head is expected`, async () => {
    const { deps, launches } = setup({ prs: ok("github", [pullRequest]), worktrees: worktreesAround(SHA) });
    const out = await runDo(baseConfig, doOptions(key, action), deps);
    expect(launches[0]?.args).toEqual([
      "--project", "widgets",
      "--branch", BRANCH,
      "--base-branch", BRANCH,
      "--name", `${pullRequest.id} ${action}`,
      "--agent", "profile-a",
      "--meta", "work.link.provider=github",
      "--meta", "work.link.kind=pull_request",
      "--meta", `work.link.id=${pullRequest.id}`,
      "--meta", `work.link.url=${pullRequest.url}`,
      "--meta", `work.link.branch=${BRANCH}`,
      "--meta", `work.role=${action}`,
      "--meta", `work.rev=${SHA}`,
      "--input-stdin",
      "--request-timeout-ms", "120000",
    ]);
    expect((JSON.parse(out.stdout) as Envelope).ok.result?.session_id).toBe("s-new");
  });

  test(`${action} --dry-run shows the adoption plan as JSON and as text, and launches nothing`, async () => {
    const { deps, launches, worktreeReads } = setup({ prs: ok("github", [pullRequest]), worktrees: () => ok("pohunek", [{ path: "/repo", branch: "main", head: SHA, sessionId: null }]) });
    const json = await runDo(baseConfig, doOptions(key, action, { dryRun: true, yes: false }), deps);
    const { plan } = (JSON.parse(json.stdout) as Envelope).ok;
    expect(plan).toMatchObject({ branch: BRANCH, base_branch: BRANCH, expected_head: SHA, cwd: null });
    expect(plan.argv.slice(0, 3)).toEqual([BIN, "session", "new"]);
    expect(plan.argv).not.toContain("--cwd");
    const text = await runDo(baseConfig, doOptions(key, action, { dryRun: true, yes: false, json: false }), deps);
    expect(text.stdout).toContain(`branch:  ${BRANCH}`);
    expect(text.stdout).toContain(`from:    ${BRANCH} (fetched from origin when the branch is created)`);
    expect(text.stdout).toContain(`head:    ${SHA} (checked after the launch)`);
    expect(launches).toHaveLength(0);
    expect(worktreeReads).toEqual(["widgets", "widgets"]);
  });

  test(`${action} adoption prompt makes the agent stop on a different HEAD before anything else and keeps the data block`, async () => {
    const { deps, launches } = setup({ prs: ok("github", [pullRequest]), worktrees: worktreesAround(SHA) });
    await runDo(baseConfig, doOptions(key, action), deps);
    const prompt = launches[0]?.stdin ?? "";
    const check = prompt.indexOf("## Before anything else");
    expect(check).toBeGreaterThan(prompt.indexOf("END UNTRUSTED DATA"));
    expect(check).toBeLessThan(prompt.indexOf("## Working agreement"));
    expect(prompt).toContain(`It must print \`${SHA}\``);
    expect(prompt).toContain("stop and report the mismatch");
    expect(prompt).toContain(`git branch --set-upstream-to=origin/${BRANCH} ${BRANCH}`);
    expect(prompt).not.toContain("${");
  });

  test(`${action} on a reused worktree reads no worktrees and carries no head check`, async () => {
    const owner = session({ id: "s-owner", state: "stopped", activity: null, branch: BRANCH, worktreePath: "/wt/owner", metadata: { "work.link.id": pullRequest.id, "work.link.provider": "github", "work.role": "implement" } });
    const { deps, launches, worktreeReads } = setup({ prs: ok("github", [pullRequest]), sessions: [owner] });
    await runDo(baseConfig, doOptions(key, action), deps);
    expect(launches[0]?.args.slice(0, 2)).toEqual(["--cwd", "/wt/owner"]);
    expect(launches[0]?.stdin).not.toContain("Before anything else");
    expect(worktreeReads).toEqual([]);
  });

  test(`${action} is refused with precondition_failed while another worktree holds the head branch, and nothing launches`, async () => {
    const holder = (): ReturnType<NonNullable<World["worktrees"]>> => ok("pohunek", [{ path: "/repo", branch: BRANCH, head: SHA, sessionId: null }]);
    const { deps, launches } = setup({ prs: ok("github", [pullRequest]), worktrees: holder });
    await expectRefusal(runDo(baseConfig, doOptions(key, action), deps), "precondition_failed", "/repo");
    expect(launches).toHaveLength(0);
  });

  test(`${action} is refused with source_unavailable when the worktrees cannot be read`, async () => {
    const { deps, launches } = setup({ prs: ok("github", [pullRequest]), worktrees: () => fail("pohunek", "unavailable", "daemon down") });
    await expectRefusal(runDo(baseConfig, doOptions(key, action), deps), "source_unavailable", "daemon down");
    expect(launches).toHaveLength(0);
  });

  test(`${action} adoption whose worktree head differs after the launch succeeds with a head_mismatch warning naming both commits`, async () => {
    const advanced = "b".repeat(40);
    const { deps, launches } = setup({ prs: ok("github", [pullRequest]), worktrees: worktreesAround(advanced) });
    const out = await runDo(baseConfig, doOptions(key, action), deps);
    expect(launches).toHaveLength(1);
    const { result } = (JSON.parse(out.stdout) as Envelope).ok;
    expect(result).toMatchObject({ session_id: "s-new", head_mismatch: { expected: SHA, actual: advanced } });
    const warning = out.warnings.join("\n");
    expect(warning).toContain(SHA);
    expect(warning).toContain(advanced);
    expect(warning).toContain("Check the session before acting");
    expect(warning).not.toContain("session rm");
    expect(warning).not.toContain("delete");
  });

  test(`${action} adoption with the expected head has no head_mismatch`, async () => {
    const { deps } = setup({ prs: ok("github", [pullRequest]), worktrees: worktreesAround(SHA) });
    const out = await runDo(baseConfig, doOptions(key, action), deps);
    expect((JSON.parse(out.stdout) as Envelope).ok.result).not.toHaveProperty("head_mismatch");
    expect(out.warnings).toEqual([]);
  });

  test(`${action} adoption is launch_unverified when no worktree of the session is listed`, async () => {
    const primaryOnly = (): ReturnType<NonNullable<World["worktrees"]>> => ok("pohunek", [{ path: "/repo", branch: "main", head: SHA, sessionId: null }]);
    const { deps } = setup({ prs: ok("github", [pullRequest]), worktrees: primaryOnly });
    const error = await expectRefusalMessage(runDo(baseConfig, doOptions(key, action), deps));
    expect(error).toContain("no worktree of the session was listed");
    expect(error).toContain(`the local branch ${BRANCH} stays`);
    expect(error).not.toContain("delete");
  });

  test(`${action} adoption is launch_unverified when the daemon reports a warning`, async () => {
    const { deps } = setup({ prs: ok("github", [pullRequest]), worktrees: worktreesAround(SHA), launchWarnings: ["fetch"] });
    await expectRefusal(runDo(baseConfig, doOptions(key, action), deps), "launch_unverified", "fetch");
  });
}

async function expectRefusalMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "launch_unverified") return error.message;
    throw error;
  }
  throw new Error("expected launch_unverified");
}

test("a Linear row without a worktree adopts the head branch and links the session to the issue", async () => {
  const mine = pr({ headRefName: "alice/ABC-1/x", headSha: SHA, reviewRequests: [{ kind: "user", login: "someone" }] });
  const stopped = session({ id: "s-second", state: "stopped", activity: null, worktreePath: null, metadata: { "work.link.id": "ABC-1", "work.link.provider": "linear", "work.role": "babysit" } });
  const { deps, launches } = setup({ issues: ok("linear", [issue()]), prs: ok("github", [mine]), sessions: [stopped], worktrees: worktreesAround(SHA) });
  await runDo(baseConfig, options({ action: "babysit", profile: "profile-a" }), deps);
  const args = launches[0]?.args ?? [];
  expect(args.slice(0, 6)).toEqual(["--project", "widgets", "--branch", "alice/ABC-1/x", "--base-branch", "alice/ABC-1/x"]);
  expect(args).toContain("work.link.provider=linear");
  expect(args).toContain("work.link.id=ABC-1");
  expect(args).toContain("work.link.kind=issue");
});

test("the session an adoption started owns the worktree: the next action reuses it with --cwd instead of adopting again", async () => {
  const pullRequest = pr({ headRefName: BRANCH, headSha: SHA, checks: [check("build", "failure")] });
  const key = `github:${pullRequest.id}`;
  const first = setup({ prs: ok("github", [pullRequest]), worktrees: worktreesAround(SHA) });
  const out = await runDo(baseConfig, doOptions(key, "fix-ci"), first.deps);
  const { result } = (JSON.parse(out.stdout) as Envelope).ok;
  if (result === undefined) throw new Error("no result");

  const adopted = session({ id: "s-new", state: "stopped", activity: null, branch: BRANCH, worktreePath: "/wt/new", metadata: result.metadata });
  const world: World = { prs: ok("github", [pullRequest]), sessions: [adopted] };
  const listed = await runList(baseConfig, { mine: false, staleDays: null, finishedHours: null, json: true, project: "widgets", includeIgnored: false }, setup(world).deps);
  const row = listed.items.find((item) => item.key === key);
  expect(row?.sessions.map((s) => s.id)).toEqual(["s-new"]);
  expect(row?.actions.map((a) => a.name)).toEqual(["fix-ci"]);

  const second = setup(world);
  const next = await runDo(baseConfig, doOptions(key, "fix-ci", { dryRun: true, yes: false }), second.deps);
  const { plan } = (JSON.parse(next.stdout) as Envelope).ok;
  expect(plan.cwd).toBe("/wt/new");
  expect(plan.argv).toContain("--cwd");
  expect(plan.argv).not.toContain("--base-branch");
  expect(second.worktreeReads).toEqual([]);
});
