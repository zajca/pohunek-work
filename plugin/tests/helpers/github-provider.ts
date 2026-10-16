// Stand-ins of GitHub for real-daemon scenarios of `pohunek-work do`: a local HTTPS GraphQL server that
// answers the plugin's queries for one open issue labeled as started, a `gh` script that prints a test
// token, and the project file of a GitHub-issue project whose branches the fixture's
// `[actions] branch_prefix` and `issue_number_prefix` produce. Everything lives below one directory the
// caller owns.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "../../src/util/exec.ts";

const HOST = "localhost";
const TOKEN = "test-token-not-a-secret";
const OPENSSL_TIMEOUT_MS = 60_000;
/** Validity of the server's self-signed certificate. */
const CERTIFICATE_DAYS = "1";
/** Label of a started issue in `GITHUB_ISSUE_PROJECT`. */
const STARTED_LABEL = "in-progress";
/** `rateLimit.remaining` every answer reports; well above anything the plugin warns about. */
const RATE_LIMIT_REMAINING = 4900;
const MS_PER_SECOND = 1000;

/**
 * Project file of a GitHub-issue project whose issues are started by `STARTED_LABEL`. The branch pattern
 * matches `<branch_prefix>/<issue_number_prefix><n>/` of the fixture configuration (`alice`, `issue-`).
 */
export const GITHUB_ISSUE_PROJECT = `[project]
pohunek_label = "widgets"
repo = "acme/widgets"
reviews = "session"
review_bot = "none"
issue_source = "github"
issue_signal = "labels"
started_labels = [${JSON.stringify(STARTED_LABEL)}]
paused_labels = []
branch_pattern = "^alice/issue-(?P<key>[0-9]+)/"
ignored_checks = []
policy_checks = []
ai_reviewers = []
`;

export interface GithubIssue {
  /** `owner/name` of the repository. */
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

/**
 * An open pull request of the owner that conflicts with its base and has no checks, reviews or threads. The
 * authored search returns every pull request of the fixture, so each one needs its own number.
 */
export interface GithubPullRequest {
  readonly number: number;
  readonly title: string;
  /** Head branch; the project's branch pattern decides whether the pull request joins an issue. */
  readonly headRefName: string;
  /** Login of the author, the owner of the configured identity. */
  readonly authorLogin: string;
  /** ISO-8601 times and sizes GitHub reports for the pull request. */
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: number;
  readonly baseRefName: string;
}

export interface GithubProvider {
  /** `[github] endpoint` of the server. */
  readonly endpoint: string;
  /** `[github] gh_bin`: a script that prints a test token. */
  readonly ghBin: string;
  /** The server's certificate, for `NODE_EXTRA_CA_CERTS` of the plugin process. */
  readonly caFile: string;
  /** URL the server reports for the issue. */
  readonly issueUrl: string;
  /** GraphQL operations the server had no answer for. */
  readonly unexpectedOperations: readonly string[];
  /** Requests received per GraphQL operation name, counted when the request arrives. */
  readonly requests: Readonly<Record<string, number>>;
  /**
   * Answers every later request with a rate-limit error that names `resetAtMs` (GitHub's GraphQL limit
   * arrives as HTTP 200 with a `RATE_LIMITED` error and `x-ratelimit-*` headers); null answers normally again.
   */
  setRateLimit(resetAtMs: number | null): void;
  /** Holds every later answer back by `ms`, so concurrent plugin processes overlap in the server. */
  setDelay(ms: number): void;
  stop(): Promise<void>;
}

/** The pull request node of the GraphQL schema, with every connection the plugin selects empty. */
function pullRequestNode(repo: string, pullRequest: GithubPullRequest): Record<string, unknown> {
  const pageInfo = { hasNextPage: false, endCursor: "end" };
  const empty = { nodes: [], pageInfo };
  return {
    id: `PR_node_${String(pullRequest.number)}`,
    number: pullRequest.number,
    url: `https://github.example/${repo}/pull/${String(pullRequest.number)}`,
    title: pullRequest.title,
    isDraft: false,
    isCrossRepository: false,
    headRefName: pullRequest.headRefName,
    headRefOid: "a".repeat(40),
    baseRefName: pullRequest.baseRefName,
    reviewDecision: null,
    mergeable: "CONFLICTING",
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changedFiles,
    repository: { nameWithOwner: repo },
    author: { __typename: "User", login: pullRequest.authorLogin },
    reviews: empty,
    reviewThreads: empty,
    timelineItems: empty,
    reviewRequests: empty,
    closingIssuesReferences: empty,
    commits: { nodes: [{ commit: { id: "C_head", statusCheckRollup: { contexts: empty } } }] },
  };
}

/** Answers the plugin's queries for one open, started issue and for the pull requests of the owner. */
function graphqlData(
  issue: GithubIssue,
  url: string,
  pullRequests: readonly GithubPullRequest[],
  operation: string,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  const rateLimit = { remaining: RATE_LIMIT_REMAINING };
  const pageInfo = { hasNextPage: false, endCursor: "end" };
  const empty = { issueCount: 0, pageInfo, nodes: [] };
  switch (operation) {
    case "PohunekWorkPullRequests": {
      const searches = Object.keys(variables)
        .filter((name) => name.startsWith("q_"))
        .map((name): [string, unknown] => {
          const alias = name.slice(2);
          if (alias !== "authored") return [alias, empty];
          const nodes = pullRequests.map((pullRequest) => pullRequestNode(issue.repo, pullRequest));
          return [alias, { issueCount: nodes.length, pageInfo, nodes }];
        });
      return { rateLimit, ...Object.fromEntries(searches) };
    }
    case "PohunekWorkMergedPullRequests":
      return { rateLimit, merged: empty };
    case "PohunekWorkIssues":
      return {
        rateLimit,
        issues: {
          issueCount: 1,
          pageInfo,
          nodes: [
            {
              id: `I_node_${String(issue.number)}`,
              number: issue.number,
              url,
              title: issue.title,
              labels: { nodes: [{ name: STARTED_LABEL }], pageInfo },
            },
          ],
        },
      };
    case "PohunekWorkIssueDetail":
      return { rateLimit, repository: { issue: { number: issue.number, url, title: issue.title, state: "OPEN", body: issue.body } } };
    default:
      return null;
  }
}

/** Starts the server and writes the certificate and the `gh` script below `dir`, which is created with mode 0700. */
export async function startGithubProvider(
  dir: string,
  issue: GithubIssue,
  pullRequests: readonly GithubPullRequest[] = [],
): Promise<GithubProvider> {
  const openssl = Bun.which("openssl");
  if (openssl === null) throw new Error("openssl is not on PATH; the local GitHub server needs a self-signed certificate");
  await mkdir(dir, { mode: 0o700 });
  const keyFile = join(dir, "key.pem");
  const caFile = join(dir, "cert.pem");
  const generated = await exec(
    [
      openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", CERTIFICATE_DAYS,
      "-keyout", keyFile, "-out", caFile, "-subj", `/CN=${HOST}`,
      "-addext", `subjectAltName=DNS:${HOST},IP:127.0.0.1`,
    ],
    { timeoutMs: OPENSSL_TIMEOUT_MS },
  );
  if (generated.exitCode !== 0) throw new Error(`openssl failed (${String(generated.exitCode)}): ${generated.stderr}`);
  const ghBin = join(dir, "gh");
  await writeFile(ghBin, `#!/bin/sh\necho ${TOKEN}\n`);
  await chmod(ghBin, 0o755);

  const issueUrl = `https://github.example/${issue.repo}/issues/${String(issue.number)}`;
  const unexpectedOperations: string[] = [];
  const requests: Record<string, number> = {};
  let rateLimitResetMs: number | null = null;
  let delayMs = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(keyFile), cert: Bun.file(caFile) },
    async fetch(request) {
      const body = (await request.json()) as { query: string; variables: Record<string, unknown> };
      const operation = /query\s+(\w+)/.exec(body.query)?.[1] ?? "";
      requests[operation] = (requests[operation] ?? 0) + 1;
      if (delayMs > 0) await Bun.sleep(delayMs);
      if (rateLimitResetMs !== null) {
        const reset = Math.ceil(rateLimitResetMs / MS_PER_SECOND).toString();
        return Response.json(
          { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
          { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } },
        );
      }
      const data = graphqlData(issue, issueUrl, pullRequests, operation, body.variables);
      if (data === null) {
        unexpectedOperations.push(operation);
        return Response.json({ errors: [{ message: `unexpected operation ${operation}` }] });
      }
      return Response.json({ data });
    },
  });
  return {
    endpoint: `https://${HOST}:${String(server.port)}/graphql`,
    ghBin,
    caFile,
    issueUrl,
    unexpectedOperations,
    requests,
    setRateLimit(resetAtMs: number | null): void {
      rateLimitResetMs = resetAtMs;
    },
    setDelay(ms: number): void {
      delayMs = ms;
    },
    async stop() {
      await server.stop(true);
    },
  };
}
