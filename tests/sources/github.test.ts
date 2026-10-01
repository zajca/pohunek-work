import { describe, expect, test } from "bun:test";
import { createGithubSource, type FetchLike } from "../../src/sources/github.ts";
import type { GithubConfig, IdentityConfig, ProjectConfig } from "../../src/types/config.ts";
import type { PullRequest, SourceResult } from "../../src/types/sources.ts";
import { SpawnError, type Exec, type ExecOptions, type ExecResult } from "../../src/util/exec.ts";

type Json = Record<string, unknown>;

const FAKE_TOKEN = "fake-token-not-real";

const githubConfig: GithubConfig = {
  endpoint: "https://github.example/graphql",
  ghBin: "/fake/bin/gh",
  timeoutMs: 5000,
  pullRequestPageSize: 7,
  nestedPageSize: 5,
  threadCommentPageSize: 3,
};

const identity: IdentityConfig = { githubLogin: "owner-user", agentIdentities: [], reviewTeams: [] };

const project: ProjectConfig = {
  name: "widgets",
  pohunekLabel: "widgets",
  repo: "acme/widgets",
  linearTeam: "ABC",
  branchPattern: /(?<key>ABC-\d+)/,
  branchPatternSource: "(?P<key>ABC-\\d+)",
  ignoredChecks: [],
  aiReviewers: [],
  policy: null,
  profiles: null,
};

async function fixture(name: string): Promise<Json> {
  return (await Bun.file(new URL(`../fixtures/github/${name}.json`, import.meta.url)).json()) as Json;
}

function obj(value: unknown): Json {
  return value as Json;
}

function dig(root: unknown, ...path: (string | number)[]): Json {
  let current: unknown = root;
  for (const segment of path) {
    current = (current as Record<string | number, unknown>)[segment];
  }
  return obj(current);
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface RecordedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly query: string;
  readonly variables: Record<string, unknown>;
  readonly signal: AbortSignal | null | undefined;
}

type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

function fakeFetch(responder: Responder): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
    const request: RecordedRequest = {
      url: input,
      headers: init.headers as Record<string, string>,
      query: body.query,
      variables: body.variables,
      signal: init.signal,
    };
    requests.push(request);
    return responder(request, requests.length - 1);
  };
  return { fetch: fetchFn, requests };
}

function fakeExec(result: Partial<ExecResult> = {}): { exec: Exec; calls: { argv: readonly string[]; options: ExecOptions }[] } {
  const calls: { argv: readonly string[]; options: ExecOptions }[] = [];
  const exec: Exec = (argv, options) => {
    calls.push({ argv, options });
    return Promise.resolve({ exitCode: 0, stdout: `${FAKE_TOKEN}\n`, stderr: "", timedOut: false, ...result });
  };
  return { exec, calls };
}

async function run(
  responder: Responder,
  options: { identity?: IdentityConfig; exec?: Exec; project?: ProjectConfig; github?: GithubConfig } = {},
): Promise<{ result: SourceResult<readonly PullRequest[]>; requests: RecordedRequest[] }> {
  const { fetch: fetchFn, requests } = fakeFetch(responder);
  const source = createGithubSource(
    { github: options.github ?? githubConfig, identity: options.identity ?? identity },
    { exec: options.exec ?? fakeExec().exec, fetch: fetchFn },
  );
  const result = await source.fetchPullRequests(options.project ?? project);
  return { result, requests };
}

function expectOk(result: SourceResult<readonly PullRequest[]>): readonly PullRequest[] {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.code}: ${result.message}`);
  }
  return result.data;
}

function expectFailure(result: SourceResult<readonly PullRequest[]>, code: string): string {
  if (result.ok) {
    throw new Error("expected failure");
  }
  expect(result.code).toBe(code as typeof result.code);
  expect(result.source).toBe("github");
  expect(result.message).not.toContain(FAKE_TOKEN);
  return result.message;
}

function byId(prs: readonly PullRequest[], id: string): PullRequest {
  const found = prs.find((pr) => pr.id === id);
  if (found === undefined) {
    throw new Error(`missing ${id}`);
  }
  return found;
}

describe("normalization", () => {
  test("authored pull request is fully normalized", async () => {
    const data = await fixture("one-page");
    const { result } = await run(() => reply(data));
    const pr = byId(expectOk(result), "acme/widgets#12");

    expect(pr).toEqual({
      id: "acme/widgets#12",
      repo: "acme/widgets",
      number: 12,
      url: "https://github.example/acme/widgets/pull/12",
      title: "Add widget cache",
      author: { login: "owner-user", isBot: false },
      relation: "authored",
      isDraft: false,
      headRefName: "owner/ABC-1/widget-cache",
      baseRefName: "main",
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "CONFLICTING",
      reviews: [
        { id: "RV_1", author: { login: "reviewer-a", isBot: false }, state: "CHANGES_REQUESTED", submittedAt: "2026-09-29T09:00:00Z" },
        { id: "RV_2", author: { login: "ai-reviewer", isBot: true }, state: "COMMENTED", submittedAt: "2026-09-29T09:30:00Z" },
        { id: "RV_3", author: { login: "owner-user", isBot: false }, state: "PENDING", submittedAt: null },
        { id: "RV_4", author: null, state: "DISMISSED", submittedAt: "2026-09-28T09:00:00Z" },
      ],
      threads: [
        {
          id: "TH_1",
          isResolved: false,
          isOutdated: true,
          comments: [
            { author: { login: "reviewer-a", isBot: false }, createdAt: "2026-09-29T09:00:01Z" },
            { author: { login: "owner-user", isBot: false }, createdAt: "2026-09-29T12:00:00Z" },
          ],
        },
        { id: "TH_2", isResolved: true, isOutdated: false, comments: [{ author: null, createdAt: "2026-09-29T09:00:02Z" }] },
      ],
      timeline: [
        { kind: "commit", at: "2026-09-29T11:00:00Z" },
        { kind: "force_push", at: "2026-09-29T13:00:00Z" },
      ],
      reviewRequests: [
        { kind: "user", login: "reviewer-a" },
        { kind: "team", slug: "platform" },
      ],
      checks: [
        { name: "CI / Build", outcome: "success" },
        { name: "legacy/ci", outcome: "failure" },
      ],
      updatedAt: "2026-09-30T10:00:00Z",
    });
  });

  test("review-requested draft pull request by a bot with UNKNOWN mergeable and no rollup", async () => {
    const data = await fixture("one-page");
    const { result } = await run(() => reply(data));
    const pr = byId(expectOk(result), "acme/widgets#34");

    expect(pr.relation).toBe("review_requested");
    expect(pr.isDraft).toBe(true);
    expect(pr.author).toEqual({ login: "dep-bot", isBot: true });
    expect(pr.mergeable).toBe("UNKNOWN");
    expect(pr.reviewDecision).toBeNull();
    expect(pr.checks).toEqual([]);
    expect(pr.reviewRequests).toEqual([{ kind: "user", login: "owner-user" }]);
  });

  test("a commit without any check rollup context yields no checks", async () => {
    const data = await fixture("one-page");
    const commit = dig(data, "data", "authored", "nodes", 0, "commits", "nodes", 0, "commit");
    commit["statusCheckRollup"] = { contexts: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    const { result } = await run(() => reply(data));
    expect(byId(expectOk(result), "acme/widgets#12").checks).toEqual([]);
  });

  test("a pull request without commits yields no checks", async () => {
    const data = await fixture("one-page");
    dig(data, "data", "authored", "nodes", 0)["commits"] = { nodes: [] };
    const { result } = await run(() => reply(data));
    expect(byId(expectOk(result), "acme/widgets#12").checks).toEqual([]);
  });

  test("every check outcome mapping", async () => {
    const data = await fixture("checks-page");
    const { result } = await run(() => reply(data));
    const checks = byId(expectOk(result), "acme/widgets#50").checks;
    const outcomes = Object.fromEntries(checks.map((check) => [check.name, check.outcome]));
    expect(outcomes).toEqual({
      "run/success": "success",
      "run/neutral": "neutral",
      "run/skipped": "neutral",
      "run/failure": "failure",
      "run/timed-out": "failure",
      "run/cancelled": "failure",
      "run/startup": "failure",
      "run/action-required": "failure",
      "run/stale": "failure",
      "run/in-progress": "pending",
      "run/null-conclusion": "pending",
      "ctx/success": "success",
      "ctx/failure": "failure",
      "ctx/error": "failure",
      "ctx/pending": "pending",
      "ctx/expected": "pending",
    });
  });

  test("an unknown check conclusion is a schema mismatch, not a silent pass", async () => {
    const data = await fixture("checks-page");
    const nodes = dig(data, "data", "authored", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts")["nodes"] as Json[];
    nodes[0] = { __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "BRAND_NEW" };
    const { result } = await run(() => reply(data));
    expectFailure(result, "invalid_response");
  });

  test("an unexpected mergeable value is a schema mismatch", async () => {
    const data = await fixture("one-page");
    dig(data, "data", "authored", "nodes", 0)["mergeable"] = "SOMETHING";
    const { result } = await run(() => reply(data));
    expectFailure(result, "invalid_response");
  });

  test("a pull request in both lists is authored and returned once", async () => {
    const data = await fixture("one-page");
    const authoredNode = dig(data, "data", "authored", "nodes", 0);
    const requested = dig(data, "data", "requested");
    (requested["nodes"] as unknown[]).unshift(structuredClone(authoredNode));
    requested["issueCount"] = 2;
    const { result } = await run(() => reply(data));
    const prs = expectOk(result);
    expect(prs.map((pr) => pr.id).sort()).toEqual(["acme/widgets#12", "acme/widgets#34"]);
    expect(byId(prs, "acme/widgets#12").relation).toBe("authored");
  });

  test("a pull request listed only by the requested search is review_requested", async () => {
    const data = await fixture("one-page");
    const node = structuredClone(dig(data, "data", "authored", "nodes", 0));
    dig(data, "data", "authored")["nodes"] = [];
    dig(data, "data", "authored")["issueCount"] = 0;
    (dig(data, "data", "requested")["nodes"] as unknown[]).push(node);
    dig(data, "data", "requested")["issueCount"] = 2;
    const { result } = await run(() => reply(data));
    expect(byId(expectOk(result), "acme/widgets#12").relation).toBe("review_requested");
  });
});

describe("request shape", () => {
  test("a one-page result takes exactly one GraphQL request and one gh call", async () => {
    const data = await fixture("one-page");
    const exec = fakeExec();
    const { result, requests } = await run(() => reply(data), { exec: exec.exec });
    expectOk(result);
    expect(requests).toHaveLength(1);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]?.argv).toEqual(["/fake/bin/gh", "auth", "token"]);
    expect(exec.calls[0]?.options.timeoutMs).toBe(5000);
  });

  test("page sizes come from config and search strings travel as variables", async () => {
    const data = await fixture("one-page");
    const { requests } = await run(() => reply(data));
    const request = requests[0];
    expect(request?.variables).toMatchObject({
      top: 7,
      nested: 5,
      q_authored: "repo:acme/widgets is:pr is:open author:owner-user",
      q_requested: "repo:acme/widgets is:pr is:open user-review-requested:owner-user",
    });
    expect(request?.query).not.toContain("owner-user");
    expect(request?.query).not.toContain("mutation");
    expect(request?.url).toBe(githubConfig.endpoint);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  test("review teams add team-review-requested searches, bare slugs use the repo owner", async () => {
    const data = await fixture("one-page");
    const empty = { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    dig(data, "data")["team0"] = empty;
    dig(data, "data")["team1"] = empty;
    const { result, requests } = await run(() => reply(data), {
      identity: { ...identity, reviewTeams: ["other-org/reviewers", "platform"] },
    });
    expectOk(result);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.variables["q_team0"]).toBe("repo:acme/widgets is:pr is:open team-review-requested:other-org/reviewers");
    expect(requests[0]?.variables["q_team1"]).toBe("repo:acme/widgets is:pr is:open team-review-requested:acme/platform");
  });

  test("page sizes that fit two searches but not the configured teams are not_configured before any call", async () => {
    const exec = fakeExec();
    const github = { ...githubConfig, pullRequestPageSize: 50, nestedPageSize: 40, threadCommentPageSize: 20 };
    const teams = Array.from({ length: 10 }, (_, index) => `team${index.toString()}`);
    const { result, requests } = await run(() => reply({}), {
      exec: exec.exec,
      github,
      identity: { ...identity, reviewTeams: teams },
    });
    expectFailure(result, "not_configured");
    expect(exec.calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test("an invalid repo is not_configured and never reaches gh or the network", async () => {
    const exec = fakeExec();
    const { result, requests } = await run(() => reply({}), {
      exec: exec.exec,
      project: { ...project, repo: "acme/widgets is:private" },
    });
    expectFailure(result, "not_configured");
    expect(exec.calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});

describe("pagination", () => {
  test("nested connections with more pages are followed by node id", async () => {
    const data = await fixture("one-page");
    const reviews = dig(data, "data", "authored", "nodes", 0, "reviews");
    reviews["pageInfo"] = { hasNextPage: true, endCursor: "R1" };
    const page2 = await fixture("nested-reviews-page");
    const { result, requests } = await run((_request, index) => reply(index === 0 ? data : page2));

    expect(requests).toHaveLength(2);
    expect(requests[1]?.variables).toEqual({ nested: 5, id_c0: "PR_node_12", after_c0: "R1" });
    expect(requests[1]?.query).toContain("node(id: $id_c0)");
    expect(requests[1]?.query).not.toContain("mutation");
    expect(requests[1]?.headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
    const pr = byId(expectOk(result), "acme/widgets#12");
    expect(pr.reviews.map((review) => review.id)).toEqual(["RV_1", "RV_2", "RV_3", "RV_4", "RV_5"]);
  });

  test("several nested kinds are fetched in one follow-up request and merged", async () => {
    const data = await fixture("one-page");
    const pr = dig(data, "data", "authored", "nodes", 0);
    dig(pr, "timelineItems")["pageInfo"] = { hasNextPage: true, endCursor: "L1" };
    dig(pr, "reviewRequests")["pageInfo"] = { hasNextPage: true, endCursor: "Q1" };
    dig(pr, "reviewThreads", "nodes", 0, "comments")["pageInfo"] = { hasNextPage: true, endCursor: "C1" };
    dig(pr, "commits", "nodes", 0, "commit", "statusCheckRollup", "contexts")["pageInfo"] = { hasNextPage: true, endCursor: "X1" };
    const done = { hasNextPage: false, endCursor: "END" };
    const responder: Responder = (request, index) => {
      if (index === 0) {
        return reply(data);
      }
      const body: Json = { rateLimit: { remaining: 4000 } };
      const kinds = Object.keys(request.variables).filter((key) => key.startsWith("id_"));
      expect(kinds).toHaveLength(4);
      for (const query of request.query.split("\n")) {
        const alias = /^\s*(c\d+): node/.exec(query)?.[1];
        if (alias === undefined) continue;
        if (query.includes("timelineItems")) {
          body[alias] = { timelineItems: { nodes: [{ __typename: "PullRequestCommit", commit: { committedDate: "2026-09-30T00:00:00Z" } }], pageInfo: done } };
          expect(request.query).toContain("itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]");
        } else if (query.includes("reviewRequests")) {
          body[alias] = { reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "reviewer-c" } }], pageInfo: done } };
        } else if (query.includes("comments(")) {
          body[alias] = { comments: { nodes: [{ author: { __typename: "User", login: "reviewer-a" }, createdAt: "2026-09-30T01:00:00Z" }], pageInfo: done } };
        } else if (query.includes("statusCheckRollup")) {
          body[alias] = { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "CI / Lint", status: "COMPLETED", conclusion: "SKIPPED" }], pageInfo: done } } };
        }
      }
      return reply({ data: body });
    };
    const { result, requests } = await run(responder);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.variables["id_c0"]).toBeDefined();
    const pr12 = byId(expectOk(result), "acme/widgets#12");
    expect(pr12.timeline).toHaveLength(3);
    expect(pr12.reviewRequests).toContainEqual({ kind: "user", login: "reviewer-c" });
    expect(pr12.threads[0]?.comments).toHaveLength(3);
    expect(pr12.checks.map((check) => check.name)).toEqual(["CI / Build", "legacy/ci", "CI / Lint"]);
  });

  test("a nested page that is itself followed by another page keeps walking until hasNextPage is false", async () => {
    const data = await fixture("one-page");
    dig(data, "data", "authored", "nodes", 0, "reviews")["pageInfo"] = { hasNextPage: true, endCursor: "R1" };
    const pages = [data, await fixture("nested-reviews-page"), await fixture("nested-reviews-page")];
    dig(pages[1], "data", "c0", "reviews")["pageInfo"] = { hasNextPage: true, endCursor: "R2" };
    dig(pages[2], "data", "c0", "reviews", "nodes", 0)["id"] = "RV_6";
    const { result, requests } = await run((_request, index) => reply(pages[index]));
    expect(requests).toHaveLength(3);
    expect(requests[2]?.variables["after_c0"]).toBe("R2");
    expect(byId(expectOk(result), "acme/widgets#12").reviews).toHaveLength(6);
  });

  test("top-level search pages are followed with the cursor", async () => {
    const data = await fixture("one-page");
    const authored = dig(data, "data", "authored");
    authored["issueCount"] = 2;
    authored["pageInfo"] = { hasNextPage: true, endCursor: "A1" };
    const second = await fixture("one-page");
    const node13 = dig(second, "data", "authored", "nodes", 0);
    node13["id"] = "PR_node_13";
    node13["number"] = 13;
    dig(second, "data", "authored")["issueCount"] = 2;
    const responder: Responder = (_request, index) => {
      if (index === 0) return reply(data);
      return reply({ data: { rateLimit: { remaining: 4000 }, authored: dig(second, "data", "authored") } });
    };
    const { result, requests } = await run(responder);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.variables["after_authored"]).toBe("A1");
    expect(requests[1]?.variables["top"]).toBe(7);
    expect(Object.keys(requests[1]?.variables ?? {})).not.toContain("q_requested");
    expect(expectOk(result).map((pr) => pr.id).sort()).toEqual(["acme/widgets#12", "acme/widgets#13", "acme/widgets#34"]);
  });

  test("a repeating nested cursor is reported as truncated", async () => {
    const data = await fixture("one-page");
    dig(data, "data", "authored", "nodes", 0, "reviews")["pageInfo"] = { hasNextPage: true, endCursor: "R1" };
    const page2 = await fixture("nested-reviews-page");
    dig(page2, "data", "c0", "reviews")["pageInfo"] = { hasNextPage: true, endCursor: "R1" };
    const { result, requests } = await run((_request, index) => reply(index === 0 ? data : page2));
    expectFailure(result, "truncated");
    expect(requests).toHaveLength(2);
  });

  test("hasNextPage without an end cursor is reported as truncated", async () => {
    const data = await fixture("one-page");
    dig(data, "data", "authored", "nodes", 0, "reviews")["pageInfo"] = { hasNextPage: true, endCursor: null };
    const { result } = await run(() => reply(data));
    expectFailure(result, "truncated");
  });

  test("a repeating top-level cursor is reported as truncated", async () => {
    const data = await fixture("one-page");
    dig(data, "data", "authored")["pageInfo"] = { hasNextPage: true, endCursor: "A1" };
    dig(data, "data", "authored")["issueCount"] = 5;
    const { result, requests } = await run(() => reply(data));
    expectFailure(result, "truncated");
    expect(requests).toHaveLength(2);
  });

  test("a search that reports more results than it returned is truncated", async () => {
    const data = await fixture("one-page");
    dig(data, "data", "authored")["issueCount"] = 1001;
    const { result } = await run(() => reply(data));
    expectFailure(result, "truncated");
  });
});

describe("errors", () => {
  test("401 is unauthenticated", async () => {
    const { result } = await run(() => reply({ message: "Bad credentials" }, 401));
    expect(expectFailure(result, "unauthenticated")).not.toContain("Bad credentials");
  });

  test.each([403, 429])("HTTP %i is rate_limited", async (status) => {
    const { result } = await run(() => reply({ message: "provider text" }, status));
    expect(expectFailure(result, "rate_limited")).not.toContain("provider text");
  });

  test("HTTP 502 is unavailable", async () => {
    const { result } = await run(() => new Response("<html>bad gateway</html>", { status: 502 }));
    expectFailure(result, "unavailable");
  });

  test("an unexpected 4xx is invalid_response", async () => {
    const { result } = await run(() => reply({}, 404));
    expectFailure(result, "invalid_response");
  });

  test("a fetch timeout is timeout", async () => {
    const { result } = await run(() => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });
    expectFailure(result, "timeout");
  });

  test("a network error is unavailable and does not echo the error text", async () => {
    const { result } = await run(() => {
      throw new TypeError(`connect failed with ${FAKE_TOKEN}`);
    });
    expectFailure(result, "unavailable");
  });

  test("a RATE_LIMITED GraphQL error is rate_limited", async () => {
    const { result } = await run(() => reply({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }));
    expect(expectFailure(result, "rate_limited")).not.toContain("exceeded");
  });

  test("an exhausted rateLimit budget is rate_limited", async () => {
    const data = await fixture("one-page");
    dig(data, "data", "rateLimit")["remaining"] = 0;
    const { result } = await run(() => reply(data));
    expectFailure(result, "rate_limited");
  });

  test("GraphQL errors are invalid_response with the error type only", async () => {
    const { result } = await run(() =>
      reply({ errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository named secret-repo" }] }),
    );
    const message = expectFailure(result, "invalid_response");
    expect(message).toContain("NOT_FOUND");
    expect(message).not.toContain("secret-repo");
  });

  test("a non-JSON body is invalid_response", async () => {
    const { result } = await run(() => new Response("not json", { status: 200 }));
    expectFailure(result, "invalid_response");
  });

  test("a response without data is invalid_response", async () => {
    const { result } = await run(() => reply({ unexpected: true }));
    expectFailure(result, "invalid_response");
  });

  test("a follow-up request failure fails the whole result", async () => {
    const data = await fixture("one-page");
    dig(data, "data", "authored", "nodes", 0, "reviews")["pageInfo"] = { hasNextPage: true, endCursor: "R1" };
    const { result } = await run((_request, index) => (index === 0 ? reply(data) : reply({}, 503)));
    expectFailure(result, "unavailable");
  });
});

describe("token handling", () => {
  test("the token appears only in the Authorization header of the fetch", async () => {
    const data = await fixture("one-page");
    const exec = fakeExec();
    const { requests } = await run(() => reply(data), { exec: exec.exec });
    expect(requests[0]?.headers["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(requests[0]?.query).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(requests[0]?.variables)).not.toContain(FAKE_TOKEN);
    expect(requests[0]?.url).not.toContain(FAKE_TOKEN);
    for (const call of exec.calls) {
      expect(call.argv.join(" ")).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(call.options)).not.toContain(FAKE_TOKEN);
    }
  });

  test("gh exiting non-zero is unauthenticated and its output is not echoed", async () => {
    const exec = fakeExec({ exitCode: 1, stdout: "leaked-stdout-value", stderr: "leaked-stderr-value" });
    const { result, requests } = await run(() => reply({}), { exec: exec.exec });
    const message = expectFailure(result, "unauthenticated");
    expect(message).not.toContain("leaked");
    expect(requests).toHaveLength(0);
  });

  test("an empty token is unauthenticated", async () => {
    const { result } = await run(() => reply({}), { exec: fakeExec({ stdout: "\n" }).exec });
    expectFailure(result, "unauthenticated");
  });

  test("a token containing whitespace is rejected before it can reach a header", async () => {
    const { result, requests } = await run(() => reply({}), { exec: fakeExec({ stdout: "fake token\nInjected: 1" }).exec });
    expectFailure(result, "unauthenticated");
    expect(requests).toHaveLength(0);
  });

  test("a missing gh binary is unauthenticated", async () => {
    const exec: Exec = () => Promise.reject(new SpawnError("/fake/bin/gh", new Error(`ENOENT ${FAKE_TOKEN}`)));
    const { result } = await run(() => reply({}), { exec });
    expectFailure(result, "unauthenticated");
  });

  test("a gh timeout is timeout", async () => {
    const { result } = await run(() => reply({}), { exec: fakeExec({ exitCode: null, stdout: "", timedOut: true }).exec });
    expectFailure(result, "timeout");
  });
});
