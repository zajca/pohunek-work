// The GitHub issue source and the closing issue references of the pull request source.
import { describe, expect, test } from "bun:test";
import { createGithubSource, type FetchLike } from "../../src/sources/github.ts";
import type { GithubConfig, GithubProject, IdentityConfig, ProjectConfig } from "../../src/types/config.ts";
import type { Issue, PullRequest, SourceResult } from "../../src/types/sources.ts";
import type { Exec } from "../../src/util/exec.ts";
import { githubIssueSource } from "../rules/builders.ts";

type Json = Record<string, unknown>;

const FAKE_TOKEN = "fake-token-not-real";

const githubConfig: GithubConfig = {
  endpoint: "https://github.example/graphql",
  ghBin: "/fake/bin/gh",
  timeoutMs: 5000,
  pullRequestPageSize: 7,
  issuePageSize: 4,
  nestedPageSize: 5,
  threadCommentPageSize: 3,
  mergedLookbackDays: 30,
};
const identity: IdentityConfig = { githubLogin: "owner-user", agentIdentities: [], reviewTeams: [] };

const base: ProjectConfig = {
  name: "widgets",
  pohunekLabel: "widgets",
  repo: "acme/widgets",
  issueSource: githubIssueSource,
  branchPattern: /(?<key>\d+)/,
  branchPatternSource: "(?P<key>\\d+)",
  ignoredChecks: [],
  policyChecks: [],
  aiReviewers: [],
  ignoreLabel: null,
  reviews: "session",
  policy: null,
  profiles: null,
};
const githubProject = base as GithubProject;
const linearProject: ProjectConfig = { ...base, issueSource: { kind: "linear", team: "ABC", pausedStates: [] } };

async function fixture(name: string): Promise<Json> {
  return (await Bun.file(new URL(`../fixtures/github/${name}.json`, import.meta.url)).json()) as Json;
}

function dig(root: unknown, ...path: (string | number)[]): Json {
  let current: unknown = root;
  for (const segment of path) current = (current as Record<string | number, unknown>)[segment];
  return current as Json;
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Recorded {
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

type Responder = (request: Recorded, index: number) => Response;

const exec: Exec = () => Promise.resolve({ exitCode: 0, stdout: `${FAKE_TOKEN}\n`, stderr: "", timedOut: false });

function sourceWith(responder: Responder): { source: ReturnType<typeof createGithubSource>; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const fetchFn: FetchLike = (_input, init) => {
    const body = JSON.parse(init.body as string) as Recorded;
    requests.push(body);
    return Promise.resolve(responder(body, requests.length - 1));
  };
  return { source: createGithubSource({ github: githubConfig, identity }, { exec, fetch: fetchFn }), requests };
}

function expectIssues(result: SourceResult<readonly Issue[]>): readonly Issue[] {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  expect(result.source).toBe("github_issues");
  return result.data;
}

describe("issues", () => {
  test("started, paused and unlabelled issues are classified from the configured labels, matched case-insensitively", async () => {
    const page = await fixture("issues-page");
    const { source, requests } = sourceWith(() => reply(page));
    const issues = expectIssues(await source.fetchIssues(githubProject));
    expect(issues).toEqual([
      {
        id: "acme/widgets#7",
        title: "Cache widgets",
        url: "https://github.example/acme/widgets/issues/7",
        state: "In-Progress",
        started: true,
        paused: false,
        assigneeIsMe: true,
        attachmentUrls: [],
        ignored: false,
      },
      {
        id: "acme/widgets#8",
        title: "Paused widget work",
        url: "https://github.example/acme/widgets/issues/8",
        state: "ON-HOLD",
        started: false,
        paused: true,
        assigneeIsMe: true,
        attachmentUrls: [],
        ignored: false,
      },
      {
        id: "acme/widgets#10",
        title: "Only on hold",
        url: "https://github.example/acme/widgets/issues/10",
        state: "on-hold",
        started: false,
        paused: true,
        assigneeIsMe: true,
        attachmentUrls: [],
        ignored: false,
      },
    ]);
    expect(requests).toHaveLength(1);
  });

  test("the search is bounded by repository, open issues and assignee, and travels as variables", async () => {
    const { source, requests } = sourceWith(() => reply({ data: { rateLimit: { remaining: 1 }, issues: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }));
    expectIssues(await source.fetchIssues(githubProject));
    expect(requests[0]?.variables).toEqual({
      q: "repo:acme/widgets is:issue is:open assignee:owner-user",
      top: 4,
      nested: 5,
      after: null,
    });
    expect(requests[0]?.query).not.toContain("owner-user");
    expect(requests[0]?.query).not.toContain("mutation");
  });

  test("further search pages are followed with the cursor", async () => {
    const first = await fixture("issues-page");
    dig(first, "data", "issues")["pageInfo"] = { hasNextPage: true, endCursor: "I1" };
    const second = await fixture("issues-page");
    dig(second, "data", "issues", "nodes", 0)["number"] = 17;
    const { source, requests } = sourceWith((_request, index) => reply(index === 0 ? first : second));
    const issues = expectIssues(await source.fetchIssues(githubProject));
    expect(requests[1]?.variables["after"]).toBe("I1");
    expect(issues.map((issue) => issue.id)).toContain("acme/widgets#17");
  });

  test("a label page cut short is followed so a paused label further down is not missed", async () => {
    const page = await fixture("issues-page");
    const node = dig(page, "data", "issues", "nodes", 0);
    dig(node, "labels")["pageInfo"] = { hasNextPage: true, endCursor: "L7" };
    const labels = await fixture("issue-labels-page");
    const { source, requests } = sourceWith((_request, index) => reply(index === 0 ? page : labels));
    const issues = expectIssues(await source.fetchIssues(githubProject));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.variables).toMatchObject({ id_c0: "I_node_7", after_c0: "L7", nested: 5 });
    expect(requests[1]?.query).toContain("... on Issue");
    expect(issues.find((issue) => issue.id === "acme/widgets#7")).toMatchObject({ paused: true, started: false, state: "on-hold" });
  });

  test("a repeating label cursor is truncated", async () => {
    const page = await fixture("issues-page");
    dig(page, "data", "issues", "nodes", 0, "labels")["pageInfo"] = { hasNextPage: true, endCursor: "L7" };
    const labels = await fixture("issue-labels-page");
    dig(labels, "data", "c0", "labels")["pageInfo"] = { hasNextPage: true, endCursor: "L7" };
    const { source } = sourceWith((_request, index) => reply(index === 0 ? page : labels));
    const result = await source.fetchIssues(githubProject);
    expect(result).toMatchObject({ ok: false, code: "truncated", source: "github_issues" });
  });

  test("a search that reports more issues than it returned is truncated", async () => {
    const page = await fixture("issues-page");
    dig(page, "data", "issues")["issueCount"] = 40;
    const { source } = sourceWith(() => reply(page));
    expect(await source.fetchIssues(githubProject)).toMatchObject({ ok: false, code: "truncated" });
  });

  test("a repeating search cursor is truncated", async () => {
    const page = await fixture("issues-page");
    dig(page, "data", "issues")["pageInfo"] = { hasNextPage: true, endCursor: "I1" };
    const { source, requests } = sourceWith(() => reply(page));
    expect(await source.fetchIssues(githubProject)).toMatchObject({ ok: false, code: "truncated" });
    expect(requests).toHaveLength(2);
  });

  test.each([
    [401, "unauthenticated"],
    [429, "rate_limited"],
    [502, "unavailable"],
  ] as const)("HTTP %i is reported as %s with the github_issues source", async (status, code) => {
    const { source } = sourceWith(() => reply({}, status));
    const result = await source.fetchIssues(githubProject);
    expect(result).toMatchObject({ ok: false, code, source: "github_issues" });
    if (!result.ok) expect(result.message).not.toContain(FAKE_TOKEN);
  });

  test("a response without the search is invalid_response", async () => {
    const { source } = sourceWith(() => reply({ data: {} }));
    expect(await source.fetchIssues(githubProject)).toMatchObject({ ok: false, code: "invalid_response" });
  });

  test("an invalid repo is not_configured before any request", async () => {
    const { source, requests } = sourceWith(() => reply({}));
    const result = await source.fetchIssues({ ...githubProject, repo: "not a repo" });
    expect(result).toMatchObject({ ok: false, code: "not_configured" });
    expect(requests).toHaveLength(0);
  });
});

describe("closing issue references", () => {
  async function prPage(references: Record<string, unknown>[], mutate: (page: Json) => void = () => undefined): Promise<Json> {
    const page = await fixture("one-page");
    for (const alias of ["authored", "requested"]) {
      const search = (page["data"] as Json)[alias] as Json | undefined;
      for (const node of (search?.["nodes"] as Json[] | undefined) ?? []) {
        node["closingIssuesReferences"] = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
      }
    }
    dig(page, "data", "authored", "nodes", 0)["closingIssuesReferences"] = {
      nodes: references,
      pageInfo: { hasNextPage: false, endCursor: "K1" },
    };
    mutate(page);
    return page;
  }

  const ref = (repository: string, number: number): Record<string, unknown> => ({ number, repository: { nameWithOwner: repository } });

  function pullRequests(result: SourceResult<readonly PullRequest[]>): readonly PullRequest[] {
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);
    return result.data;
  }

  test("only references into the project's repository count, case-insensitively, sorted and deduplicated", async () => {
    const page = await prPage([ref("acme/widgets", 9), ref("Acme/Widgets", 3), ref("acme/other", 4), ref("acme/widgets", 9)]);
    const { source, requests } = sourceWith(() => reply(page));
    const prs = pullRequests(await source.fetchPullRequests(githubProject));
    expect(prs.find((pr) => pr.number === 12)?.closingIssueNumbers).toEqual([3, 9]);
    expect(requests[0]?.query).toContain("closingIssuesReferences(first: $nested)");
  });

  test("a further page of references is followed by node id", async () => {
    const page = await prPage([ref("acme/widgets", 9)], (p) => {
      dig(p, "data", "authored", "nodes", 0, "closingIssuesReferences")["pageInfo"] = { hasNextPage: true, endCursor: "K1" };
    });
    const next = { data: { rateLimit: { remaining: 1 }, c0: { closingIssuesReferences: { nodes: [ref("acme/widgets", 2)], pageInfo: { hasNextPage: false, endCursor: "K2" } } } } };
    const { source, requests } = sourceWith((_request, index) => reply(index === 0 ? page : next));
    const prs = pullRequests(await source.fetchPullRequests(githubProject));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.query).toContain("closingIssuesReferences");
    expect(prs.find((pr) => pr.number === 12)?.closingIssueNumbers).toEqual([2, 9]);
  });

  test("a project whose issues come from Linear never requests the references", async () => {
    const page = await fixture("one-page");
    const { source, requests } = sourceWith(() => reply(page));
    const prs = pullRequests(await source.fetchPullRequests(linearProject));
    expect(requests[0]?.query).not.toContain("closingIssuesReferences");
    expect(prs.every((pr) => pr.closingIssueNumbers.length === 0)).toBe(true);
  });

  test("page sizes that fit without the references but not with them are not_configured before any call", async () => {
    // Two searches of 50 pull requests: 490,200 possible nodes without the references, 500,200 with them.
    const tight: GithubConfig = { ...githubConfig, pullRequestPageSize: 50, nestedPageSize: 100, threadCommentPageSize: 44 };
    const requests: Recorded[] = [];
    const source = createGithubSource(
      { github: tight, identity },
      { exec, fetch: (_input, init) => { requests.push(JSON.parse(init.body as string) as Recorded); return Promise.resolve(reply({})); } },
    );
    expect(await source.fetchPullRequests(githubProject)).toMatchObject({ ok: false, code: "not_configured" });
    expect(requests).toHaveLength(0);
    const page = await fixture("one-page");
    const fitting = createGithubSource({ github: tight, identity }, { exec, fetch: () => Promise.resolve(reply(page)) });
    expect((await fitting.fetchPullRequests(linearProject)).ok).toBe(true);
  });
});

describe("issue detail", () => {
  const node = { number: 7, url: "https://github.example/acme/widgets/issues/7", title: "Cache widgets", state: "OPEN", body: "Line one\nLine two" };
  const answer = (issue: unknown): Response => reply({ data: { rateLimit: { remaining: 100 }, repository: { issue } } });

  test("one lookup by owner, name and number returns title, url, state and body", async () => {
    const { source, requests } = sourceWith(() => answer(node));
    const result = await source.fetchIssueDetail(githubProject, 7);
    expect(result).toMatchObject({ ok: true, source: "github_issues", data: { id: "acme/widgets#7", title: "Cache widgets", url: node.url, open: true, body: "Line one\nLine two" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.variables).toEqual({ owner: "acme", name: "widgets", number: 7 });
    expect(requests[0]?.query).not.toContain("acme");
  });

  test("a closed issue reports open false", async () => {
    const { source } = sourceWith(() => answer({ ...node, state: "CLOSED" }));
    expect(await source.fetchIssueDetail(githubProject, 7)).toMatchObject({ ok: true, data: { open: false } });
  });

  test("a missing issue, a wrong number and a malformed node fail typed without provider text", async () => {
    for (const body of [null, { ...node, number: 8 }, { ...node, state: "MERGED" }, { ...node, body: null }]) {
      const { source } = sourceWith(() => answer(body));
      const result = await source.fetchIssueDetail(githubProject, 7);
      expect(result).toMatchObject({ ok: false, source: "github_issues", code: "invalid_response" });
    }
  });

  test("a non-positive number never reaches GitHub, and a transport failure is typed", async () => {
    const { source, requests } = sourceWith(() => reply({}, 503));
    expect(await source.fetchIssueDetail(githubProject, 0)).toMatchObject({ ok: false, code: "not_configured" });
    expect(requests).toHaveLength(0);
    expect(await source.fetchIssueDetail(githubProject, 7)).toMatchObject({ ok: false, code: "unavailable" });
  });
});

describe("ignore label", () => {
  const withIgnore = (label: string | null): GithubProject => ({ ...githubProject, ignoreLabel: label });
  const linearWith = (label: string | null): ProjectConfig => ({ ...linearProject, ignoreLabel: label });
  const labelConnection = (names: string[], next: string | null = null): Json => ({
    nodes: names.map((name) => ({ name })),
    pageInfo: { hasNextPage: next !== null, endCursor: next ?? "E" },
  });

  async function issuesWithLabels(names: string[], next: string | null = null): Promise<Json> {
    const page = await fixture("issues-page");
    dig(page, "data", "issues", "nodes", 0)["labels"] = labelConnection(names, next);
    return page;
  }

  function pullRequests(result: SourceResult<readonly PullRequest[]>): readonly PullRequest[] {
    if (!result.ok) throw new Error(`expected success, got ${result.code}`);
    return result.data;
  }

  async function prPage(labels: Json | null): Promise<Json> {
    const page = await fixture("one-page");
    for (const alias of ["authored", "requested"]) {
      const search = (page["data"] as Json)[alias] as Json | undefined;
      for (const node of (search?.["nodes"] as Json[] | undefined) ?? []) {
        node["labels"] = labels ?? labelConnection([]);
      }
    }
    return page;
  }

  const numberOf = (issues: readonly Issue[], id: string): Issue | undefined => issues.find((issue) => issue.id === id);

  test("an issue carrying the ignore label is ignored, matched case-insensitively", async () => {
    const page = await issuesWithLabels(["in-progress", "Pohunek:IGNORE"]);
    const { source } = sourceWith(() => reply(page));
    const issues = expectIssues(await source.fetchIssues(withIgnore("pohunek:ignore")));
    expect(numberOf(issues, "acme/widgets#7")).toMatchObject({ started: true, ignored: true });
    expect(numberOf(issues, "acme/widgets#8")).toMatchObject({ ignored: false });
  });

  test("an issue without the ignore label is not ignored", async () => {
    const page = await issuesWithLabels(["in-progress", "other"]);
    const { source } = sourceWith(() => reply(page));
    const issues = expectIssues(await source.fetchIssues(withIgnore("pohunek:ignore")));
    expect(numberOf(issues, "acme/widgets#7")?.ignored).toBe(false);
  });

  test("a project without an ignore label never marks an issue ignored", async () => {
    const page = await issuesWithLabels(["in-progress", "pohunek:ignore"]);
    const { source } = sourceWith(() => reply(page));
    const issues = expectIssues(await source.fetchIssues(withIgnore(null)));
    expect(issues.every((issue) => !issue.ignored)).toBe(true);
  });

  test("an issue with neither a started nor a paused label stays off the table even when ignored", async () => {
    const page = await issuesWithLabels(["pohunek:ignore"]);
    const { source } = sourceWith(() => reply(page));
    const issues = expectIssues(await source.fetchIssues(withIgnore("pohunek:ignore")));
    expect(numberOf(issues, "acme/widgets#7")).toBeUndefined();
  });

  test("a label page cut short is followed so an ignore label further down is found", async () => {
    const page = await issuesWithLabels(["in-progress"], "L7");
    const next = { data: { rateLimit: { remaining: 1 }, c0: { labels: labelConnection(["pohunek:ignore"]) } } };
    const { source, requests } = sourceWith((_request, index) => reply(index === 0 ? page : next));
    const issues = expectIssues(await source.fetchIssues(withIgnore("pohunek:ignore")));
    expect(requests).toHaveLength(2);
    expect(numberOf(issues, "acme/widgets#7")?.ignored).toBe(true);
  });

  test("a label page that cannot be followed is truncated, never not ignored", async () => {
    const page = await issuesWithLabels(["in-progress"], "L7");
    const loop = { data: { rateLimit: { remaining: 1 }, c0: { labels: labelConnection(["x"], "L7") } } };
    const { source } = sourceWith((_request, index) => reply(index === 0 ? page : loop));
    expect(await source.fetchIssues(withIgnore("pohunek:ignore"))).toMatchObject({ ok: false, code: "truncated" });
  });

  test("a pull request carrying the ignore label is ignored, case-insensitively, and the query selects the labels", async () => {
    const page = await prPage(labelConnection(["bug", "POHUNEK:Ignore"]));
    const { source, requests } = sourceWith(() => reply(page));
    const prs = pullRequests(await source.fetchPullRequests(linearWith("pohunek:ignore")));
    expect(requests[0]?.query).toContain("labels(first: $nested)");
    expect(prs.length).toBeGreaterThan(0);
    expect(prs.every((pr) => pr.ignored)).toBe(true);
  });

  test("a pull request without the ignore label is not ignored", async () => {
    const page = await prPage(labelConnection(["bug"]));
    const { source } = sourceWith(() => reply(page));
    const prs = pullRequests(await source.fetchPullRequests(linearWith("pohunek:ignore")));
    expect(prs.every((pr) => !pr.ignored)).toBe(true);
  });

  test("a project without an ignore label requests no pull request labels and ignores nothing", async () => {
    const page = await fixture("one-page");
    const { source, requests } = sourceWith(() => reply(page));
    const prs = pullRequests(await source.fetchPullRequests(linearWith(null)));
    expect(requests[0]?.query).not.toContain("labels");
    expect(prs.every((pr) => !pr.ignored)).toBe(true);
  });

  test("a pull request label page cut short is followed by node id", async () => {
    const page = await prPage(labelConnection(["bug"]));
    dig(page, "data", "authored", "nodes", 0)["labels"] = labelConnection(["bug"], "L1");
    const next = { data: { rateLimit: { remaining: 1 }, c0: { labels: labelConnection(["pohunek:ignore"]) } } };
    const { source, requests } = sourceWith((_request, index) => reply(index === 0 ? page : next));
    const prs = pullRequests(await source.fetchPullRequests(linearWith("pohunek:ignore")));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.query).toContain("... on PullRequest");
    expect(requests[1]?.query).toContain("labels(first: $nested");
    expect(prs.find((pr) => pr.number === 12)?.ignored).toBe(true);
  });

  test("a pull request label page that cannot be followed is truncated", async () => {
    const page = await prPage(labelConnection(["bug"]));
    dig(page, "data", "authored", "nodes", 0)["labels"] = labelConnection(["bug"], "L1");
    const loop = { data: { rateLimit: { remaining: 1 }, c0: { labels: labelConnection(["x"], "L1") } } };
    const { source } = sourceWith((_request, index) => reply(index === 0 ? page : loop));
    expect(await source.fetchPullRequests(linearWith("pohunek:ignore"))).toMatchObject({ ok: false, code: "truncated" });
  });
});
