import { describe, expect, test } from "bun:test";
import { joinItems, type JoinInput } from "../src/join.ts";
import type { ProjectConfig } from "../src/types/config.ts";
import type { SourceStatuses } from "../src/types/item.ts";
import type {
  Issue,
  MergedPullRequest,
  PohunekNotification,
  PohunekSession,
  PullRequest,
} from "../src/types/sources.ts";

const project = {
  name: "widgets",
  pohunekLabel: "widgets",
  repo: "acme/widgets",
  issueSource: { kind: "linear", team: "ABC", pausedStates: ["On hold"] },
  branchPattern: /^me\/(?<key>[A-Z]+-\d+)\//,
  branchPatternSource: "^me/(?P<key>[A-Z]+-\\d+)/",
  ignoredChecks: [],
  policyChecks: [],
  aiReviewers: [],
  policy: null,
  profiles: null,
} satisfies ProjectConfig;

const okSources: SourceStatuses = { github: "ok", github_merged: "ok", linear: "ok", pohunek: "ok" };

function issue(id: string, attachmentUrls: string[] = []): Issue {
  return {
    id,
    title: "Add widget cache",
    url: `https://linear.example/${id}`,
    state: "In Progress",
    started: true,
    paused: false,
    assigneeIsMe: true,
    attachmentUrls,
  };
}

function pr(
  number: number,
  headRefName: string,
  relation: PullRequest["relation"] = "authored",
): PullRequest {
  return {
    id: `acme/widgets#${number}`,
    repo: "acme/widgets",
    number,
    url: `https://github.example/acme/widgets/pull/${number}`,
    title: "Add widget cache",
    author: null,
    relation,
    isDraft: false,
    isCrossRepository: false,
    headRefName,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    baseRefName: "main",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    reviews: [],
    threads: [],
    timeline: [],
    reviewRequests: [],
    checks: [],
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function session(
  id: string,
  metadata: Record<string, string> = {},
  projectLabel: string | null = "widgets",
): PohunekSession {
  return {
    id,
    name: `name-${id}`,
    projectLabel,
    branch: null,
    worktreePath: null,
    cwd: null,
    state: "running",
    activity: "idle",
    runtimeState: null,
    metadata,
  };
}

function notification(id: string, sessionId: string | null): PohunekNotification {
  return {
    id,
    kind: "agent_blocked",
    status: "unread",
    sessionId,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const githubProject: ProjectConfig = { ...project, issueSource: { kind: "github" } };

function runGithub(partial: Partial<JoinInput>): ReturnType<typeof joinItems> {
  return run({ project: githubProject, sources: { ...okSources, linear: "unused" }, ...partial });
}

function run(partial: Partial<JoinInput>): ReturnType<typeof joinItems> {
  return joinItems({
    project,
    issues: [],
    pullRequests: [],
    mergedPullRequests: [],
    sessions: [],
    notifications: [],
    sources: okSources,
    ...partial,
  });
}

describe("join precedence", () => {
  test("session link with provider linear joins by session_link", () => {
    const { items } = run({
      issues: [issue("ABC-1")],
      pullRequests: [pr(1, "feature/x")],
      sessions: [
        session("s1", {
          "work.link.provider": "linear",
          "work.link.id": "ABC-1",
          "work.link.branch": "feature/x",
        }),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("linear:ABC-1");
    expect(items[0]?.joinedBy).toBe("session_link");
    expect(items[0]?.issue?.id).toBe("ABC-1");
    expect(items[0]?.pullRequest?.id).toBe("acme/widgets#1");
    expect(items[0]?.noIssue).toBe(false);
  });

  test("github-provider session link yields no key and falls through", () => {
    const { items } = run({
      issues: [issue("ABC-2", ["https://github.example/acme/widgets/pull/1"])],
      pullRequests: [pr(1, "feature/x")],
      sessions: [
        session("s1", {
          "work.link.provider": "github",
          "work.link.id": "acme/widgets#1",
          "work.link.branch": "feature/x",
        }),
      ],
    });
    expect(items[0]?.key).toBe("linear:ABC-2");
    expect(items[0]?.joinedBy).toBe("linear_attachment");
    expect(items[0]?.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  test("linear attachment with exact url joins by linear_attachment", () => {
    const { items } = run({
      issues: [issue("ABC-3", ["https://github.example/acme/widgets/pull/2"])],
      pullRequests: [pr(2, "feature/y")],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("linear:ABC-3");
    expect(items[0]?.joinedBy).toBe("linear_attachment");
  });

  test("attachment url must match exactly", () => {
    const { items } = run({
      issues: [issue("ABC-3", ["https://github.example/acme/widgets/pull/2/files"])],
      pullRequests: [pr(2, "feature/y")],
    });
    expect(items.map((i) => i.key)).toEqual(["github:acme/widgets#2", "linear:ABC-3"]);
  });

  test("branch pattern joins by branch_pattern", () => {
    const { items } = run({
      issues: [issue("ABC-4")],
      pullRequests: [pr(3, "me/ABC-4/add-cache")],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("linear:ABC-4");
    expect(items[0]?.joinedBy).toBe("branch_pattern");
  });

  test("branch pattern with a global flag matches on every call", () => {
    const globalProject: ProjectConfig = {
      ...project,
      branchPattern: /^me\/(?<key>[A-Z]+-\d+)\//g,
    };
    const input = {
      project: globalProject,
      issues: [issue("ABC-4"), issue("ABC-5")],
      pullRequests: [pr(3, "me/ABC-4/a"), pr(4, "me/ABC-5/b")],
      mergedPullRequests: [],
      sessions: [],
      notifications: [],
      sources: okSources,
    };
    const keys = joinItems(input).items.map((i) => i.key);
    expect(keys).toEqual(["linear:ABC-4", "linear:ABC-5"]);
  });

  test("session link wins over attachment and branch pattern", () => {
    const { items } = run({
      issues: [issue("ABC-5", ["https://github.example/acme/widgets/pull/4"]), issue("ABC-6")],
      pullRequests: [pr(4, "me/ABC-6/slug")],
      sessions: [
        session("s1", {
          "work.link.provider": "linear",
          "work.link.id": "ABC-7",
          "work.link.branch": "me/ABC-6/slug",
        }),
      ],
    });
    const row = items.find((i) => i.pullRequest !== null);
    expect(row?.key).toBe("linear:ABC-7");
    expect(row?.joinedBy).toBe("session_link");
    expect(row?.issue).toBeNull();
  });

  test("attachment wins over branch pattern", () => {
    const { items } = run({
      issues: [issue("ABC-5", ["https://github.example/acme/widgets/pull/4"]), issue("ABC-6")],
      pullRequests: [pr(4, "me/ABC-6/slug")],
    });
    const row = items.find((i) => i.pullRequest !== null);
    expect(row?.key).toBe("linear:ABC-5");
    expect(row?.joinedBy).toBe("linear_attachment");
    expect(items.map((i) => i.key)).toEqual(["linear:ABC-5", "linear:ABC-6"]);
  });
});

function merged(number: number, headRefName: string, mergedAt = "2026-10-02T10:00:00Z"): MergedPullRequest {
  return {
    id: `acme/widgets#${number}`,
    number,
    url: `https://github.example/acme/widgets/pull/${number}`,
    title: "Add widget cache",
    headRefName,
    mergedAt,
  };
}

describe("merged pull requests", () => {
  test("an issue-only row carries the merged pull request matched by branch pattern", () => {
    const { items } = run({ issues: [issue("ABC-1")], mergedPullRequests: [merged(7, "me/ABC-1/slug")] });
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("linear:ABC-1");
    expect(items[0]?.mergedPullRequest?.id).toBe("acme/widgets#7");
    expect(items[0]?.pullRequest).toBeNull();
  });

  test("a Linear attachment matches a merged pull request whose branch does not", () => {
    const attached = merged(8, "unrelated");
    const { items } = run({ issues: [issue("ABC-1", [attached.url])], mergedPullRequests: [attached] });
    expect(items[0]?.mergedPullRequest?.id).toBe("acme/widgets#8");
  });

  test("an open pull request keeps its own row and the merged one is not attached", () => {
    const { items } = run({
      issues: [issue("ABC-1")],
      pullRequests: [pr(9, "me/ABC-1/next")],
      mergedPullRequests: [merged(7, "me/ABC-1/first")],
    });
    expect(items.map((i) => [i.key, i.mergedPullRequest])).toEqual([["linear:ABC-1", null]]);
  });

  test("with no merged pull request the row has none, and an unmatched one never forms a row", () => {
    const none = run({ issues: [issue("ABC-1")] });
    expect(none.items[0]?.mergedPullRequest).toBeNull();
    const stray = run({ issues: [issue("ABC-1")], mergedPullRequests: [merged(7, "other/branch")] });
    expect(stray.items.map((i) => i.key)).toEqual(["linear:ABC-1"]);
    expect(stray.items[0]?.mergedPullRequest).toBeNull();
  });

  test("the most recently merged pull request wins", () => {
    const { items } = run({
      issues: [issue("ABC-1")],
      mergedPullRequests: [merged(7, "me/ABC-1/a", "2026-09-01T00:00:00Z"), merged(5, "me/ABC-1/b", "2026-10-01T00:00:00Z")],
    });
    expect(items[0]?.mergedPullRequest?.id).toBe("acme/widgets#5");
  });
});

describe("rows", () => {
  test("PR without match is a no-issue row when Linear is ok", () => {
    const { items } = run({ pullRequests: [pr(5, "random-branch")] });
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("github:acme/widgets#5");
    expect(items[0]?.noIssue).toBe(true);
    expect(items[0]?.issue).toBeNull();
    expect(items[0]?.joinedBy).toBeNull();
  });

  test("PR without match is not flagged no-issue when Linear failed", () => {
    const { items } = run({
      pullRequests: [pr(5, "random-branch")],
      sources: { ...okSources, linear: "timeout" },
    });
    expect(items[0]?.key).toBe("github:acme/widgets#5");
    expect(items[0]?.noIssue).toBe(false);
  });

  test("issue without PR is its own row", () => {
    const { items } = run({ issues: [issue("ABC-8")] });
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("linear:ABC-8");
    expect(items[0]?.pullRequest).toBeNull();
    expect(items[0]?.joinedBy).toBeNull();
    expect(items[0]?.noIssue).toBe(false);
    expect(items[0]?.project).toBe("widgets");
  });

  test("issue-only row gets a live session attached by link id", () => {
    const { items, orphanedSessions } = run({
      issues: [issue("ABC-8")],
      sessions: [session("s1", { "work.link.provider": "linear", "work.link.id": "ABC-8" })],
      notifications: [notification("n1", "s1")],
    });
    expect(items[0]?.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(items[0]?.notifications.map((n) => n.id)).toEqual(["n1"]);
    expect(orphanedSessions).toEqual([]);
  });

  test("branch pattern with an unloaded issue keeps the linear key and a null issue", () => {
    const { items } = run({ pullRequests: [pr(6, "me/ABC-9/slug")] });
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("linear:ABC-9");
    expect(items[0]?.issue).toBeNull();
    expect(items[0]?.joinedBy).toBe("branch_pattern");
    expect(items[0]?.noIssue).toBe(false);
  });

  test("review_requested PR is its own row and never joined", () => {
    const { items } = run({
      issues: [issue("ABC-10", ["https://github.example/acme/widgets/pull/7"])],
      pullRequests: [pr(7, "me/ABC-10/slug", "review_requested")],
    });
    expect(items.map((i) => i.key)).toEqual(["github:acme/widgets#7", "linear:ABC-10"]);
    expect(items[0]?.noIssue).toBe(false);
    expect(items[0]?.issue).toBeNull();
    expect(items[0]?.joinedBy).toBeNull();
    expect(items[1]?.pullRequest).toBeNull();
  });

  test("two PRs resolving to one key: first joins, second is its own row without noIssue", () => {
    const { items } = run({
      issues: [issue("ABC-11")],
      pullRequests: [pr(8, "me/ABC-11/first"), pr(9, "me/ABC-11/second")],
    });
    expect(items.map((i) => i.key)).toEqual(["linear:ABC-11", "github:acme/widgets#9"]);
    expect(items[0]?.pullRequest?.id).toBe("acme/widgets#8");
    expect(items[0]?.issue?.id).toBe("ABC-11");
    expect(items[1]?.noIssue).toBe(false);
    expect(items[1]?.issue).toBeNull();
    expect(items[1]?.joinedBy).toBeNull();
    expect(items[0]?.issueKey).toBe("ABC-11");
    expect(items[1]?.issueKey).toBe("ABC-11");
  });

  test("a session linked by issue key attaches to the winner, not to a secondary row listed before it", () => {
    const { items } = run({
      issues: [issue("ABC-13")],
      pullRequests: [pr(9, "me/ABC-13/second"), pr(8, "me/ABC-13/first")],
      sessions: [session("s1", { "work.link.provider": "linear", "work.link.id": "ABC-13" })],
    });
    expect(items.find((i) => i.key === "linear:ABC-13")?.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(items.find((i) => i.key === "github:acme/widgets#9")?.sessions).toEqual([]);
  });

  test("issueKey is null for a pull request without a match", () => {
    const { items } = run({ pullRequests: [pr(5, "feature/x")] });
    expect(items[0]?.issueKey).toBeNull();
  });
});

describe("sessions and notifications", () => {
  test("session from another project is ignored", () => {
    const { items, orphanedSessions } = run({
      issues: [issue("ABC-12")],
      sessions: [
        session("s1", { "work.link.provider": "linear", "work.link.id": "ABC-12" }, "other"),
        session("s2", { "work.link.provider": "linear", "work.link.id": "ZZZ-1" }, null),
      ],
    });
    expect(items[0]?.sessions).toEqual([]);
    expect(orphanedSessions).toEqual([]);
  });

  test("session without a link id is ignored, not orphaned", () => {
    const { items, orphanedSessions } = run({
      issues: [issue("ABC-12")],
      sessions: [session("s1", { "work.role": "implement" }), session("s2")],
    });
    expect(items[0]?.sessions).toEqual([]);
    expect(orphanedSessions).toEqual([]);
  });

  test("linked session matching no row is orphaned", () => {
    const { orphanedSessions } = run({
      issues: [issue("ABC-12")],
      pullRequests: [pr(10, "random")],
      sessions: [
        session("s1", {
          "work.link.provider": "linear",
          "work.link.id": "ABC-99",
          "work.link.branch": "me/ABC-99/gone",
        }),
      ],
    });
    expect(orphanedSessions).toEqual([{ id: "s1", name: "name-s1", linkId: "ABC-99" }]);
  });

  test("session attaches by PR id and by head ref", () => {
    const { items, orphanedSessions } = run({
      pullRequests: [pr(11, "feature/z")],
      sessions: [
        session("s1", { "work.link.provider": "github", "work.link.id": "acme/widgets#11" }),
        session("s2", {
          "work.link.provider": "github",
          "work.link.id": "acme/widgets#99",
          "work.link.branch": "feature/z",
        }),
      ],
    });
    expect(items[0]?.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(orphanedSessions).toEqual([]);
  });

  test("notifications attach only through the row's sessions", () => {
    const { items } = run({
      issues: [issue("ABC-13"), issue("ABC-14")],
      sessions: [
        session("s1", { "work.link.provider": "linear", "work.link.id": "ABC-13" }),
        session("s2", { "work.link.provider": "linear", "work.link.id": "ABC-14" }),
      ],
      notifications: [
        notification("n1", "s1"),
        notification("n2", "s2"),
        notification("n3", null),
        notification("n4", "unknown"),
        notification("n5", "s1"),
      ],
    });
    expect(items[0]?.notifications.map((n) => n.id)).toEqual(["n1", "n5"]);
    expect(items[1]?.notifications.map((n) => n.id)).toEqual(["n2"]);
  });
});

describe("ordering", () => {
  test("PR rows in input order, then issue-only rows in issue order; repeatable", () => {
    const input = {
      issues: [issue("ABC-20"), issue("ABC-21"), issue("ABC-22")],
      pullRequests: [
        pr(30, "random"),
        pr(29, "me/ABC-21/slug"),
        pr(28, "other", "review_requested"),
      ],
    };
    const first = run(input);
    const second = run(input);
    expect(first.items.map((i) => i.key)).toEqual([
      "github:acme/widgets#30",
      "linear:ABC-21",
      "github:acme/widgets#28",
      "linear:ABC-20",
      "linear:ABC-22",
    ]);
    expect(second).toEqual(first);
  });
});

describe("claim of an issue row and session attachment", () => {
  const stackedSession = session("s1", {
    "work.link.provider": "linear",
    "work.link.id": "ABC-1",
    "work.link.branch": "me/ABC-1/main",
  });

  test("the strongest match claims the issue row regardless of input order", () => {
    for (const order of [[20, 12], [12, 20]] as const) {
      const heads: Record<number, string> = { 20: "me/ABC-1/follow-up", 12: "me/ABC-1/main" };
      const { items } = run({
        issues: [issue("ABC-1")],
        pullRequests: order.map((n) => pr(n, heads[n] ?? "")),
        sessions: [stackedSession],
      });
      const issueRow = items.find((i) => i.key === "linear:ABC-1");
      expect(issueRow?.pullRequest?.number).toBe(12);
      expect(issueRow?.joinedBy).toBe("session_link");
      expect(items.find((i) => i.key === "github:acme/widgets#20")?.noIssue).toBe(false);
    }
  });

  test("equal strength is broken by the lowest pull request number", () => {
    const { items } = run({
      issues: [issue("ABC-1")],
      pullRequests: [pr(30, "me/ABC-1/b"), pr(25, "me/ABC-1/a")],
    });
    expect(items.find((i) => i.key === "linear:ABC-1")?.pullRequest?.number).toBe(25);
  });

  test("a session attaches to exactly one row", () => {
    const { items, orphanedSessions } = run({
      issues: [issue("ABC-1")],
      pullRequests: [pr(20, "me/ABC-1/follow-up"), pr(12, "me/ABC-1/main")],
      sessions: [stackedSession],
    });
    const holders = items.filter((i) => i.sessions.some((s) => s.id === "s1"));
    expect(holders.map((i) => i.key)).toEqual(["linear:ABC-1"]);
    expect(orphanedSessions).toEqual([]);
  });
});

describe("orphans with failed sources", () => {
  const link = session("s1", { "work.link.provider": "github", "work.link.id": "acme/widgets#12" });

  test("a failed github source suppresses the orphan verdict for a github link", () => {
    const { orphanedSessions } = run({ sessions: [link], sources: { ...okSources, github: "rate_limited" } });
    expect(orphanedSessions).toEqual([]);
  });

  test("a failed linear source suppresses the orphan verdict for a linear link", () => {
    const linearLink = session("s2", { "work.link.provider": "linear", "work.link.id": "ABC-5" });
    const { orphanedSessions } = run({ sessions: [linearLink], sources: { ...okSources, linear: "timeout" } });
    expect(orphanedSessions).toEqual([]);
  });

  test("a linear failure does not hide an orphaned github link", () => {
    const { orphanedSessions } = run({ sessions: [link], sources: { ...okSources, linear: "timeout" } });
    expect(orphanedSessions.map((o) => o.id)).toEqual(["s1"]);
  });
});

describe("paused issue states", () => {
  const paused = { ...issue("ABC-7"), state: "On hold", paused: true };

  test("a paused issue without a pull request gets no row", () => {
    const { items } = run({ issues: [paused, issue("ABC-8")] });
    expect(items.map((i) => i.key)).toEqual(["linear:ABC-8"]);
  });

  test("a paused issue with a pull request keeps its row", () => {
    const { items } = run({ issues: [paused], pullRequests: [pr(30, "me/ABC-7/work")] });
    expect(items.map((i) => i.key)).toEqual(["linear:ABC-7"]);
    expect(items[0]?.pullRequest?.number).toBe(30);
  });

  test("a session linked to a paused issue is not reported as orphaned", () => {
    const linkedToPaused = session("s7", { "work.link.provider": "linear", "work.link.id": "ABC-7" });
    const { items, orphanedSessions } = run({ issues: [paused], sessions: [linkedToPaused] });
    expect(items).toEqual([]);
    expect(orphanedSessions).toEqual([]);
  });
});

describe("legacy link.* metadata and unlinked sessions", () => {
  test("a legacy GitHub link id is the bare PR number of the project repo", () => {
    const legacy = session("s1", { "link.provider": "github", "link.kind": "pull_request", "link.id": "12" });
    const { items, orphanedSessions } = run({ pullRequests: [pr(12, "feature/x")], sessions: [legacy] });
    expect(items[0]?.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(orphanedSessions).toEqual([]);
  });

  test("a legacy linear link joins by session_link through link.branch", () => {
    const legacy = session("s2", {
      "link.provider": "linear",
      "link.id": "ABC-12",
      "link.branch": "feature/y",
    });
    const { items } = run({ issues: [issue("ABC-12")], pullRequests: [pr(30, "feature/y")], sessions: [legacy] });
    expect(items[0]).toMatchObject({ key: "linear:ABC-12", joinedBy: "session_link" });
    expect(items[0]?.sessions.map((s) => s.id)).toEqual(["s2"]);
  });

  test("work.link.* wins over link.* and the namespaces are not mixed", () => {
    const both = session("s3", {
      "work.link.provider": "linear",
      "work.link.id": "ABC-12",
      "link.provider": "github",
      "link.id": "99",
      "link.branch": "legacy/branch",
    });
    const { items, orphanedSessions } = run({
      issues: [issue("ABC-12")],
      pullRequests: [pr(99, "legacy/branch")],
      sessions: [both],
    });
    expect(items.find((i) => i.key === "linear:ABC-12")?.sessions.map((s) => s.id)).toEqual(["s3"]);
    expect(items.find((i) => i.key === "github:acme/widgets#99")?.sessions).toEqual([]);
    expect(orphanedSessions).toEqual([]);
  });

  test("a legacy link matching no row is orphaned", () => {
    const legacy = session("s4", { "link.provider": "github", "link.id": "404" });
    expect(run({ sessions: [legacy] }).orphanedSessions).toEqual([{ id: "s4", name: "name-s4", linkId: "acme/widgets#404" }]);
  });

  test("live sessions without any link are listed as unlinked, not guessed onto a row", () => {
    const live = session("s5");
    const stopped = { ...session("s6"), state: "stopped" };
    const lost = { ...session("s7"), runtimeState: "lost" };
    const other = session("s8", {}, "gadgets");
    const { items, unlinkedSessions } = run({
      pullRequests: [pr(12, "feature/x")],
      sessions: [{ ...live, branch: "feature/x" }, stopped, lost, other],
    });
    expect(unlinkedSessions.map((s) => s.id)).toEqual(["s5"]);
    expect(items[0]?.sessions).toEqual([]);
  });
});

describe("github issue source", () => {
  test("a numeric branch pattern match yields a github row without an issue key", () => {
    const { items } = runGithub({ pullRequests: [pr(1, "me/ABC-1/work")] });
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("github:acme/widgets#1");
    expect(items[0]?.issueKey).toBeNull();
    expect(items[0]?.joinedBy).toBeNull();
    expect(items[0]?.noIssue).toBe(false);
  });

  test("a linear-provider session link never creates a linear row", () => {
    const { items } = runGithub({
      pullRequests: [pr(1, "feature/x")],
      sessions: [
        session("s1", { "work.link.provider": "linear", "work.link.id": "ABC-1", "work.link.branch": "feature/x" }),
      ],
    });
    expect(items.map((i) => i.key)).toEqual(["github:acme/widgets#1"]);
    expect(items[0]?.issueKey).toBeNull();
    expect(items[0]?.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  test("a merged pull request produces no row", () => {
    const { items } = runGithub({ mergedPullRequests: [merged(5, "me/ABC-1/work")] });
    expect(items).toEqual([]);
  });

  test("an unlinked session is orphaned with linear unused and github ok", () => {
    const { orphanedSessions } = runGithub({
      sessions: [session("s1", { "work.link.provider": "github", "work.link.id": "acme/widgets#9" })],
    });
    expect(orphanedSessions.map((o) => o.id)).toEqual(["s1"]);
  });
});
