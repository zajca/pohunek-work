// `do` launch actions on pull requests: fix-ci, rebase (owner's PR, rule 5) and review (rule 3).
import { expect, test } from "bun:test";
import { runDo, type DoOptions } from "../../src/commands/do.ts";
import type { PluginConfig } from "../../src/types/config.ts";
import { check, issue, pr, session } from "../rules/builders.ts";
import { BIN, baseConfig, expectRefusal, externalReviewsConfig, fail, HOSTILE_TITLE, ok, options, setup, type Envelope } from "./harness.ts";

const SHA = "a".repeat(40);
const FAILING = pr({ headRefName: "feature/x", headSha: SHA, title: HOSTILE_TITLE, checks: [check("build", "failure"), check("lint", "success")] });
const CONFLICTING = pr({ headRefName: "feature/x", headSha: SHA, mergeable: "CONFLICTING", baseRefName: "release" });
const PR_KEY = `github:${FAILING.id}`;
const OWNER = session({
  id: "s-owner",
  state: "stopped",
  activity: null,
  branch: "feature/x",
  worktreePath: "/wt/owner",
  metadata: { "work.link.id": FAILING.id, "work.link.provider": "github", "work.role": "implement" },
});

function prOptions(action: DoOptions["action"], overrides: Partial<DoOptions> = {}): DoOptions {
  return options({ key: PR_KEY, action, profile: "profile-a", ...overrides });
}

// ------------------------------------------------------------------- fix-ci

test("fix-ci starts in the owner's worktree with the failing checks in the data block", async () => {
  const { deps, launches } = setup({ prs: ok("github", [FAILING]), sessions: [OWNER] });
  const out = await runDo(baseConfig, prOptions("fix-ci"), deps);
  expect(launches[0]?.args).toEqual([
    "--cwd", "/wt/owner",
    "--name", `${FAILING.id} fix-ci`,
    "--agent", "profile-a",
    "--meta", "work.link.provider=github",
    "--meta", "work.link.kind=pull_request",
    "--meta", `work.link.id=${FAILING.id}`,
    "--meta", `work.link.url=${FAILING.url}`,
    "--meta", "work.link.branch=feature/x",
    "--meta", "work.role=fix-ci",
    "--meta", `work.rev=${SHA}`,
    "--input-stdin",
    "--request-timeout-ms", "120000",
  ]);
  const prompt = launches[0]?.stdin ?? "";
  expect(prompt).toContain("failing_checks: build");
  expect(prompt).not.toContain("lint");
  expect(prompt).toContain("Do not merge, do not approve");
  expect(prompt).toContain("threads written by humans");
  expect((JSON.parse(out.stdout) as Envelope).ok.result?.metadata["work.role"]).toBe("fix-ci");
});

test("fix-ci keeps provider text out of argv and metadata", async () => {
  const { deps } = setup({ prs: ok("github", [FAILING]), sessions: [OWNER] });
  const out = await runDo(baseConfig, prOptions("fix-ci", { dryRun: true, yes: false }), deps);
  const { plan } = (JSON.parse(out.stdout) as Envelope).ok;
  for (const element of [...plan.argv, ...Object.values(plan.metadata)]) {
    expect(element).not.toContain(HOSTILE_TITLE);
  }
  expect(plan.argv.slice(0, 3)).toEqual([BIN, "session", "new"]);
  expect(plan).not.toHaveProperty("base_branch");
});

test("fix-ci is refused unless the owner's pull request has a failing check at rule 5", async () => {
  const green = pr({ headRefName: "feature/x", checks: [check("build", "success")] });
  const a = setup({ prs: ok("github", [green]), sessions: [OWNER] });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci"), a.deps), "precondition_failed", "rule 5");
  // Rule 5 for a conflict, but no failing check.
  const b = setup({ prs: ok("github", [CONFLICTING]), sessions: [OWNER] });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci"), b.deps), "precondition_failed", "rebase it first");
  // Only an ignored check fails: rule 5 does not hold.
  const ignored = pr({ headRefName: "feature/x", checks: [check("CI / Flaky", "failure")] });
  const c = setup({ prs: ok("github", [ignored]), sessions: [OWNER] });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci"), c.deps), "precondition_failed");
  expect([a, b, c].map((h) => h.launches.length)).toEqual([0, 0, 0]);
});

test("fix-ci is refused on a conflict with a failing check and when only a policy check fails", async () => {
  const conflicting = pr({ ...CONFLICTING, checks: [check("build", "failure")] });
  const a = setup({ prs: ok("github", [conflicting]), sessions: [OWNER] });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci"), a.deps), "precondition_failed", "rebase it first");
  const policyOnly = pr({ headRefName: "feature/x", headSha: SHA, checks: [check("Policy / Label", "failure")] });
  const b = setup({ prs: ok("github", [policyOnly]), sessions: [OWNER] });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci"), b.deps), "precondition_failed", "only policy checks of acme/widgets#12 fail (Policy / Label)");
  expect([a, b].map((h) => h.launches.length)).toEqual([0, 0]);
});

test("fix-ci on a policy and a CI failure lists only the CI check in the data block", async () => {
  const mixed = pr({ ...FAILING, checks: [check("Policy / Label", "failure"), check("build", "failure"), check("build", "failure")] });
  const { deps, launches } = setup({ prs: ok("github", [mixed]), sessions: [OWNER] });
  await runDo(baseConfig, prOptions("fix-ci"), deps);
  const prompt = launches[0]?.stdin ?? "";
  expect(prompt).toContain("failing_checks: build\n");
  expect(prompt).not.toContain("Policy / Label");
});

test("fix-ci is refused for a pull request of someone else, without a worktree and with a live session", async () => {
  const theirs = pr({ relation: "review_requested", checks: [check("build", "failure")] });
  const a = setup({ prs: ok("github", [theirs]) });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci", { key: `github:${theirs.id}` }), a.deps), "precondition_failed", "no pull request of yours");
  const b = setup({ prs: ok("github", [FAILING]) });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci"), b.deps), "no_worktree", "fix-ci refused");
  const live = session({ ...OWNER, state: "running", activity: "idle" });
  const c = setup({ prs: ok("github", [FAILING]), sessions: [live] });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci"), c.deps), "already_running", "s-owner");
  const stranger = session({ id: "s-stranger", activity: "idle", cwd: "/wt/owner" });
  const d = setup({ prs: ok("github", [FAILING]), sessions: [OWNER, stranger] });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci"), d.deps), "already_running", "fix-ci refused: live session s-stranger");
});

test("fix-ci without a configured profile is refused naming the action", async () => {
  const { deps } = setup({ prs: ok("github", [FAILING]), sessions: [OWNER] });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci", { profile: null }), deps), "no_profile", "[profiles] fix-ci");
});

test("fix-ci on an issue row is refused with source_unavailable when GitHub did not answer", async () => {
  const issueOwner = session({ ...OWNER, metadata: { "work.link.id": "ABC-1", "work.link.provider": "linear" } });
  const { deps, launches } = setup({ issues: ok("linear", [issue()]), prs: fail("github", "timeout"), sessions: [issueOwner] });
  await expectRefusal(runDo(baseConfig, prOptions("fix-ci", { key: "linear:ABC-1" }), deps), "source_unavailable", "github did not answer (timeout)");
  expect(launches).toHaveLength(0);
});

test("fix-ci on the issue row of the pull request links by the issue key", async () => {
  const linked = pr({ headRefName: "alice/ABC-1/x", headSha: SHA, checks: [check("build", "failure")] });
  const issueOwner = session({ ...OWNER, metadata: { "work.link.id": "ABC-1", "work.link.provider": "linear", "work.role": "implement" } });
  const { deps, launches } = setup({ issues: ok("linear", [issue()]), prs: ok("github", [linked]), sessions: [issueOwner] });
  await runDo(baseConfig, prOptions("fix-ci", { key: "ABC-1" }), deps);
  const args = launches[0]?.args ?? [];
  expect(args).toContain("work.link.id=ABC-1");
  expect(args).toContain("work.link.kind=issue");
  expect(args.slice(2, 4)).toEqual(["--name", "ABC-1 fix-ci"]);
});

// ------------------------------------------------------------------- rebase

test("rebase starts in the owner's worktree with the base branch in the data block", async () => {
  const { deps, launches } = setup({ prs: ok("github", [CONFLICTING]), sessions: [OWNER] });
  await runDo(baseConfig, prOptions("rebase"), deps);
  const args = launches[0]?.args ?? [];
  expect(args.slice(0, 4)).toEqual(["--cwd", "/wt/owner", "--name", `${CONFLICTING.id} rebase`]);
  expect(args).toContain("work.role=rebase");
  const prompt = launches[0]?.stdin ?? "";
  expect(prompt).toContain("base_branch: release");
  expect(prompt).toContain("--force-with-lease");
  expect(prompt).toContain("Do not merge, do not approve");
});

test("rebase is allowed on a conflict even when a failing check decides the reason", async () => {
  const both = pr({ headRefName: "feature/x", mergeable: "CONFLICTING", checks: [check("build", "failure")] });
  const { deps, launches } = setup({ prs: ok("github", [both]), sessions: [OWNER] });
  await runDo(baseConfig, prOptions("rebase"), deps);
  expect(launches).toHaveLength(1);
});

test("rebase without a configured profile is refused naming the action", async () => {
  const { deps, launches } = setup({ prs: ok("github", [CONFLICTING]), sessions: [OWNER] });
  await expectRefusal(runDo(baseConfig, prOptions("rebase", { profile: null }), deps), "no_profile", "[profiles] rebase");
  expect(launches).toHaveLength(0);
});

test("rebase is refused without a merge conflict", async () => {
  const { deps, launches } = setup({ prs: ok("github", [FAILING]), sessions: [OWNER] });
  await expectRefusal(runDo(baseConfig, prOptions("rebase"), deps), "precondition_failed", "no merge conflict");
  const draft = pr({ headRefName: "feature/x", isDraft: true });
  const other = setup({ prs: ok("github", [draft]), sessions: [OWNER] });
  await expectRefusal(runDo(baseConfig, prOptions("rebase"), other.deps), "precondition_failed", "rule 6");
  expect(launches).toHaveLength(0);
});

// ------------------------------------------------------------------- review

const HEAD = "c".repeat(40);
const THEIRS = pr({
  id: "acme/widgets#7",
  number: 7,
  url: "https://example.invalid/acme/widgets/pull/7",
  relation: "review_requested",
  headRefName: "feature/their-change",
  headSha: HEAD,
  title: HOSTILE_TITLE,
});
const REVIEW_KEY = `github:${THEIRS.id}`;
const REVIEW_BRANCH = `alice/review/7-${HEAD}`;

function reviewOptions(overrides: Partial<DoOptions> = {}): DoOptions {
  return options({ key: REVIEW_KEY, action: "review", ...overrides });
}

test("review --dry-run fetches the head branch into a fresh branch named after the head", async () => {
  const { deps, launches } = setup({ prs: ok("github", [THEIRS]) });
  const out = await runDo(baseConfig, reviewOptions({ dryRun: true, yes: false }), deps);
  const { plan } = (JSON.parse(out.stdout) as Envelope).ok;
  expect(launches).toHaveLength(0);
  expect(plan.argv).toEqual([
    BIN, "session", "new",
    "--project", "widgets",
    "--branch", REVIEW_BRANCH,
    "--base-branch", "feature/their-change",
    "--name", "acme/widgets#7 review",
    "--agent", "profile-b",
    "--meta", "work.link.provider=github",
    "--meta", "work.link.kind=pull_request",
    "--meta", "work.link.id=acme/widgets#7",
    "--meta", `work.link.url=${THEIRS.url}`,
    "--meta", "work.link.branch=feature/their-change",
    "--meta", "work.role=review",
    "--meta", `work.rev=${HEAD}`,
    "--input-stdin",
    "--request-timeout-ms", "120000",
    "--json",
  ]);
  expect(plan.base_branch).toBe("feature/their-change");
  expect(plan.expected_head).toBe(HEAD);
  for (const element of [...plan.argv, ...Object.values(plan.metadata)]) {
    expect(element).not.toContain(HOSTILE_TITLE);
  }
  expect(plan.prompt).toContain(`It must print \`${HEAD}\``);
  expect(plan.prompt).toContain("Never push");
  expect(plan.prompt).toContain("never approve");
});

test("review runs, then re-reads the worktree head and reports it", async () => {
  const { deps, launches, worktreeReads } = setup({ prs: ok("github", [THEIRS]), worktreeHead: HEAD });
  const out = await runDo(baseConfig, reviewOptions(), deps);
  expect(launches).toHaveLength(1);
  expect(worktreeReads).toEqual(["widgets"]);
  expect((JSON.parse(out.stdout) as Envelope).ok.result?.session_id).toBe("s-new");
});

test("review is launch_unverified when the daemon warns or the worktree holds another commit", async () => {
  const warned = setup({ prs: ok("github", [THEIRS]), worktreeHead: HEAD, launchWarnings: ["fetch", "base_branch_fallback"] });
  await expectRefusal(runDo(baseConfig, reviewOptions(), warned.deps), "launch_unverified", "fetch, base_branch_fallback");
  const wrong = setup({ prs: ok("github", [THEIRS]), worktreeHead: "d".repeat(40) });
  await expectRefusal(runDo(baseConfig, reviewOptions(), wrong.deps), "launch_unverified", `pohunek session rm s-new`);
  const missing = setup({ prs: ok("github", [THEIRS]), worktrees: () => ok("pohunek", []) });
  await expectRefusal(runDo(baseConfig, reviewOptions(), missing.deps), "launch_unverified", "no worktree of the session");
  const unreadable = setup({ prs: ok("github", [THEIRS]), worktrees: () => fail("pohunek", "timeout") });
  await expectRefusal(runDo(baseConfig, reviewOptions(), unreadable.deps), "launch_unverified", "could not be re-read");
});

test("review is refused unless a review is requested from the owner at rule 3", async () => {
  const mine = pr({ headRefName: "feature/x", headSha: HEAD });
  const a = setup({ prs: ok("github", [mine]) });
  await expectRefusal(runDo(baseConfig, reviewOptions({ key: `github:${mine.id}` }), a.deps), "precondition_failed", "waiting for your review");
  const working = session({ id: "s-w", activity: "working", metadata: { "work.link.id": THEIRS.id, "work.link.provider": "github" } });
  const b = setup({ prs: ok("github", [THEIRS]), sessions: [working] });
  await expectRefusal(runDo(baseConfig, reviewOptions(), b.deps), "precondition_failed", "rule 3");
  expect([a.launches.length, b.launches.length]).toEqual([0, 0]);
});

test("review is refused as not_supported when the project hands reviews to an external pipeline", async () => {
  const { deps, launches } = setup({ prs: ok("github", [THEIRS]) });
  await expectRefusal(runDo(externalReviewsConfig, reviewOptions(), deps), "not_supported", '[project] reviews = "external"');
  const dry = setup({ prs: ok("github", [THEIRS]) });
  await expectRefusal(runDo(externalReviewsConfig, reviewOptions({ dryRun: true, yes: false }), dry.deps), "not_supported", "widgets");
  expect([launches.length, dry.launches.length]).toEqual([0, 0]);
});

test("external reviews are refused as not_supported even without a review profile", async () => {
  const noProfile: PluginConfig = { ...externalReviewsConfig, global: { ...externalReviewsConfig.global, profiles: {} } };
  for (const dryRun of [true, false]) {
    const { deps, launches } = setup({ prs: ok("github", [THEIRS]) });
    await expectRefusal(runDo(noProfile, reviewOptions({ profile: null, dryRun, yes: !dryRun }), deps), "not_supported", '[project] reviews = "external"');
    expect(launches).toHaveLength(0);
  }
});

test("review is refused while a linked review session is live", async () => {
  const idle = session({ id: "s-idle", activity: "idle", metadata: { "work.link.id": THEIRS.id, "work.link.provider": "github" } });
  const { deps, launches } = setup({ prs: ok("github", [THEIRS]), sessions: [idle] });
  await expectRefusal(runDo(baseConfig, reviewOptions(), deps), "already_running", "s-idle");
  expect(launches).toHaveLength(0);
});

test("review is refused for a fork, an unsafe head branch or a malformed head SHA", async () => {
  const fork = { ...THEIRS, isCrossRepository: true };
  await expectRefusal(runDo(baseConfig, reviewOptions(), setup({ prs: ok("github", [fork]) }).deps), "precondition_failed", "fork");
  const option = { ...THEIRS, headRefName: "-upload-pack=x" };
  await expectRefusal(runDo(baseConfig, reviewOptions(), setup({ prs: ok("github", [option]) }).deps), "invalid_value", "head branch");
  const dots = { ...THEIRS, headRefName: "a/../b" };
  await expectRefusal(runDo(baseConfig, reviewOptions(), setup({ prs: ok("github", [dots]) }).deps), "invalid_value", "head branch");
  const shortSha = { ...THEIRS, headSha: "abc" };
  await expectRefusal(runDo(baseConfig, reviewOptions(), setup({ prs: ok("github", [shortSha]) }).deps), "invalid_value", "full SHA");
});

test("review is refused while a stopped session still holds the worktree of the same head", async () => {
  const leftover = session({ id: "s-old", state: "stopped", activity: null, branch: REVIEW_BRANCH, worktreePath: "/wt/old" });
  const { deps, launches } = setup({ prs: ok("github", [THEIRS]), sessions: [leftover] });
  await expectRefusal(runDo(baseConfig, reviewOptions(), deps), "precondition_failed", "s-old");
  expect(launches).toHaveLength(0);
});

test("a review branch that the project branch pattern matches is refused", async () => {
  const { deps } = setup({ prs: ok("github", [THEIRS]) });
  // A pattern that takes any segment after `alice/` as the key would join the review session to an issue.
  const clash: PluginConfig = {
    ...baseConfig,
    projects: baseConfig.projects.map((p) => (p.pohunekLabel === "widgets" ? { ...p, branchPattern: /^alice\/(?<key>[a-z]+)\// } : p)),
  };
  await expectRefusal(runDo(clash, reviewOptions(), deps), "invalid_value", "review_branch_segment");
});
