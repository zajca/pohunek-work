// Rows of a project whose issues come from GitHub: `list` and `do` agree on what is offered, and a launch
// writes the issue link so the next action finds the session again.
import { expect, test } from "bun:test";
import { runDo } from "../../src/commands/do.ts";
import { runList } from "../../src/commands/list.ts";
import type { PluginConfig } from "../../src/types/config.ts";
import type { Issue, PohunekSession, PullRequest } from "../../src/types/sources.ts";
import type { ListItem } from "../../src/types/item.ts";
import { check, githubIssueSource, issue, pr, session } from "../rules/builders.ts";
import { baseConfig, expectRefusal, fail, ok, options, setup, type Envelope, type World } from "./harness.ts";

const SHA = "a".repeat(40);
const BRANCH = "feature/x";
const ISSUE_KEY = "acme/widgets#7";
const ROW = `github-issue:${ISSUE_KEY}`;

const config: PluginConfig = {
  ...baseConfig,
  projects: baseConfig.projects.map((project) =>
    project.pohunekLabel === "widgets"
      ? { ...project, issueSource: githubIssueSource, branchPattern: /^alice\/issue-(?<key>[0-9]+)\//, branchPatternSource: "^alice/issue-(?P<key>[0-9]+)/" }
      : project,
  ),
};

const githubIssue = (overrides: Partial<Issue> = {}): Issue => issue({ id: ISSUE_KEY, state: "in-progress", url: "https://example.invalid/acme/widgets/issues/7", ...overrides });
const closing = (overrides: Partial<PullRequest> = {}): PullRequest => pr({ headRefName: BRANCH, headSha: SHA, closingIssueNumbers: [7], ...overrides });

function ownerSession(overrides: Partial<PohunekSession> = {}): PohunekSession {
  return session({
    id: "s-owner",
    state: "stopped",
    activity: null,
    branch: BRANCH,
    worktreePath: "/wt/owner",
    metadata: { "work.link.provider": "github", "work.link.kind": "issue", "work.link.id": ISSUE_KEY, "work.link.branch": BRANCH, "work.role": "implement" },
    ...overrides,
  });
}

async function listed(world: World): Promise<ListItem[]> {
  const out = await runList(config, { mine: false, staleDays: null, json: true, project: "widgets" }, setup(world).deps);
  return [...out.items];
}

function rowOf(items: readonly ListItem[]): ListItem {
  const row = items.find((item) => item.key === ROW);
  if (row === undefined) throw new Error(`no ${ROW} row in ${items.map((i) => i.key).join(", ")}`);
  return row;
}

test("an issue-only row is on rule 8, and list offers implement exactly because do plans it", async () => {
  const world: World = {
    githubIssues: ok("github_issues", [githubIssue()]),
    issueDetail: (number) => ok("github_issues", { id: ISSUE_KEY, title: "Widget cache", url: "https://example.invalid/acme/widgets/issues/7", open: number === 7, body: "Cache it." }),
  };
  const row = rowOf(await listed(world));
  expect(row.on_turn).toEqual({ actor: "me", reason: "nothing runs", rule: 8 });
  expect(row.issue).toEqual({ id: ISSUE_KEY, title: "Widget cache", state: "in-progress", url: "https://example.invalid/acme/widgets/issues/7" });
  expect(row.issue_key).toBe(ISSUE_KEY);
  expect(row.actions).toEqual([{ name: "implement", delegable: false, profile: "profile-a" }]);
  expect(row.sources).toMatchObject({ linear: "unused", github_issues: "ok" });
  const out = await runDo(config, options({ key: ROW, action: "implement", profile: "profile-a", dryRun: true, yes: false }), setup(world).deps);
  expect((JSON.parse(out.stdout) as Envelope).ok.plan.branch).toBe("alice/issue-7/widget-cache");
});

const WORKTREE_CASES = [
  { name: "rebase", pullRequest: closing({ mergeable: "CONFLICTING" }), rule: 5, reason: "rebase" },
  { name: "fix-ci", pullRequest: closing({ checks: [check("build", "failure")] }), rule: 5, reason: "fix CI" },
] as const;

for (const testCase of WORKTREE_CASES) {
  test(`${testCase.name} on a github-issue row is listed with a worktree and do links the session to the issue`, async () => {
    const world: World = { githubIssues: ok("github_issues", [githubIssue()]), prs: ok("github", [testCase.pullRequest]), sessions: [ownerSession()] };
    const row = rowOf(await listed(world));
    expect(row.on_turn).toEqual({ actor: "me", reason: testCase.reason, rule: testCase.rule });
    expect(row.actions.map((action) => action.name)).toEqual([testCase.name]);
    const out = await runDo(config, options({ key: ROW, action: testCase.name, profile: "profile-a", dryRun: true, yes: false }), setup(world).deps);
    const { plan } = (JSON.parse(out.stdout) as Envelope).ok;
    expect(plan.cwd).toBe("/wt/owner");
    expect(plan.metadata).toMatchObject({
      "work.link.provider": "github",
      "work.link.kind": "issue",
      "work.link.id": ISSUE_KEY,
      "work.link.branch": BRANCH,
      "work.role": testCase.name,
    });
  });

  test(`${testCase.name} on a github-issue row without a worktree is listed and do adopts the head branch with the issue link`, async () => {
    const world: World = { githubIssues: ok("github_issues", [githubIssue()]), prs: ok("github", [testCase.pullRequest]), sessions: [ownerSession({ worktreePath: null })] };
    const row = rowOf(await listed(world));
    expect(row.actions.map((action) => action.name)).toEqual([testCase.name]);
    const out = await runDo(config, options({ key: ROW, action: testCase.name, profile: "profile-a", dryRun: true, yes: false }), setup(world).deps);
    const { plan } = (JSON.parse(out.stdout) as Envelope).ok;
    expect(plan).toMatchObject({ cwd: null, branch: BRANCH, base_branch: BRANCH, expected_head: SHA });
    expect(plan.metadata).toMatchObject({ "work.link.provider": "github", "work.link.kind": "issue", "work.link.id": ISSUE_KEY, "work.link.branch": BRANCH, "work.role": testCase.name });
  });
}

test("a launched session is found again: the link it carries joins the next listing to the same row", async () => {
  const world: World = { githubIssues: ok("github_issues", [githubIssue()]), prs: ok("github", [closing({ mergeable: "CONFLICTING" })]), sessions: [ownerSession()] };
  const harness = setup(world);
  const out = await runDo(config, options({ key: ROW, action: "rebase", profile: "profile-a", yes: true }), harness.deps);
  const metadata = (JSON.parse(out.stdout) as Envelope).ok.result?.metadata ?? {};
  const launched = session({ id: "s-new", activity: "idle", state: "running", branch: BRANCH, worktreePath: "/wt/owner", metadata });
  const next = await listed({ ...world, sessions: [ownerSession(), launched] });
  expect(rowOf(next).sessions.map((s) => s.id).sort()).toEqual(["s-new", "s-owner"]);
});

test("ready and attach on a github-issue row are listed exactly when do plans them", async () => {
  const draft = closing({ isDraft: true });
  const live = ownerSession({ state: "running", activity: "idle", runtimeState: "connected" });
  const world: World = { githubIssues: ok("github_issues", [githubIssue()]), prs: ok("github", [draft]), sessions: [live], terminal: true };
  const row = rowOf(await listed(world));
  expect(row.actions.map((action) => action.name)).toEqual(["ready", "attach"]);
  for (const action of ["ready", "attach"] as const) {
    const out = await runDo(config, options({ key: ROW, action, profile: "profile-a", dryRun: true, yes: false }), setup(world).deps);
    expect((JSON.parse(out.stdout) as Envelope).ok.dry_run).toBe(true);
  }
});

test("a paused issue lists no action and do refuses every action", async () => {
  const world: World = {
    githubIssues: ok("github_issues", [githubIssue({ started: false, paused: true, state: "on-hold" })]),
    prs: ok("github", [closing({ isDraft: true, mergeable: "CONFLICTING", checks: [check("build", "failure")] })]),
    sessions: [ownerSession()],
  };
  const row = rowOf(await listed(world));
  expect(row.on_turn).toEqual({ actor: "paused", reason: "paused", rule: 12 });
  expect(row.actions).toEqual([]);
  for (const action of ["implement", "babysit", "fix-ci", "rebase", "ready", "attach"] as const) {
    await expectRefusal(runDo(config, options({ key: ROW, action, profile: "profile-a", dryRun: true, yes: false }), setup(world).deps), "precondition_failed", `${action} refused`);
  }
});

test("an outage of the issue source makes a joined pull request unknown and do refuses on it", async () => {
  const world: World = {
    githubIssues: fail("github_issues", "timeout"),
    prs: ok("github", [closing({ mergeable: "CONFLICTING" })]),
    sessions: [ownerSession()],
  };
  const items = await listed(world);
  const row = items.find((item) => item.pull_request !== null);
  expect(row?.key).toBe(ROW);
  expect(row?.on_turn).toEqual({ actor: "unknown", reason: "github_issues:timeout", rule: null });
  expect(row?.actions).toEqual([]);
  await expectRefusal(runDo(config, options({ key: ROW, action: "rebase", profile: "profile-a", dryRun: true, yes: false }), setup(world).deps), "source_unavailable");
});

test("a bare owner/name#number never resolves to a github-issue row", async () => {
  const world: World = { githubIssues: ok("github_issues", [githubIssue()]) };
  await expectRefusal(runDo(config, options({ key: ISSUE_KEY, action: "implement", dryRun: true, yes: false }), setup(world).deps), "unknown_item");
});

const SECOND_BRANCH = "feature/y";

test("a secondary pull request of a paused GitHub issue is paused, lists no action and do refuses every action", async () => {
  const winner = closing({ number: 12, id: "acme/widgets#12", isDraft: true });
  const secondary = closing({ number: 13, id: "acme/widgets#13", headRefName: SECOND_BRANCH, isDraft: true, mergeable: "CONFLICTING", checks: [check("build", "failure")] });
  const second = ownerSession({ id: "s-second", branch: SECOND_BRANCH, worktreePath: "/wt/second", metadata: { "work.link.provider": "github", "work.link.kind": "pull_request", "work.link.id": secondary.id, "work.link.branch": SECOND_BRANCH } });
  const world: World = {
    githubIssues: ok("github_issues", [githubIssue({ started: false, paused: true, state: "on-hold" })]),
    prs: ok("github", [winner, secondary]),
    sessions: [second],
  };
  const row = (await listed(world)).find((item) => item.key === "github:acme/widgets#13");
  expect(row).toMatchObject({ issue: null, issue_key: ISSUE_KEY, on_turn: { actor: "paused", reason: "paused", rule: 12 }, actions: [] });
  for (const action of ["babysit", "fix-ci", "rebase", "ready", "attach"] as const) {
    await expectRefusal(runDo(config, options({ key: "github:acme/widgets#13", action, profile: "profile-a", dryRun: true, yes: false }), setup(world).deps), "precondition_failed", `${action} refused`);
  }
  const unpaused = { ...world, githubIssues: ok("github_issues", [githubIssue()]) };
  expect((await listed(unpaused)).find((item) => item.key === "github:acme/widgets#13")?.actions.map((a) => a.name)).toEqual(["rebase"]);
});

test("a secondary pull request is unknown and offers nothing while the issue source is down", async () => {
  const winner = closing({ number: 12, id: "acme/widgets#12" });
  const secondary = closing({ number: 13, id: "acme/widgets#13", headRefName: SECOND_BRANCH, mergeable: "CONFLICTING" });
  const world: World = { githubIssues: fail("github_issues", "timeout"), prs: ok("github", [winner, secondary]) };
  const row = (await listed(world)).find((item) => item.key === "github:acme/widgets#13");
  expect(row?.on_turn).toEqual({ actor: "unknown", reason: "github_issues:timeout", rule: null });
  expect(row?.actions).toEqual([]);
  await expectRefusal(runDo(config, options({ key: "github:acme/widgets#13", action: "rebase", profile: "profile-a", dryRun: true, yes: false }), setup(world).deps), "source_unavailable");
});

test("a session link spelled with another repository case plans a worktree action on the issue row", async () => {
  const mixed = ownerSession({ metadata: { "work.link.provider": "github", "work.link.kind": "issue", "work.link.id": "Acme/Widgets#7", "work.link.branch": BRANCH } });
  const world: World = { githubIssues: ok("github_issues", [githubIssue()]), prs: ok("github", [pr({ headRefName: BRANCH, headSha: SHA, mergeable: "CONFLICTING" })]), sessions: [mixed] };
  const row = rowOf(await listed(world));
  expect(row).toMatchObject({ issue: { id: ISSUE_KEY }, actions: [{ name: "rebase" }] });
  const out = await runDo(config, options({ key: ROW, action: "rebase", profile: "profile-a", dryRun: true, yes: false }), setup(world).deps);
  expect((JSON.parse(out.stdout) as Envelope).ok.plan.metadata["work.link.id"]).toBe(ISSUE_KEY);
});

