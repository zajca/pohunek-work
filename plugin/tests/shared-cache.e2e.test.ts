// End-to-end scenarios of the shared cache of GitHub results: `list` processes of the real plugin CLI
// against a real pohunekd from the pinned core release, and a local GraphQL server (helpers/github-provider.ts)
// that counts the requests it receives. The server is a stand-in because GitHub cannot be rate-limited on demand
// and cannot be asked for its request count; the plugin code path from the HTTP response onward is the real one.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, runPlugin, startCoreDaemon, writePluginConfig, type CoreDaemon, type PluginFixture } from "./helpers/core-daemon.ts";
import {
  GITHUB_ISSUE_PROJECT,
  startGithubProvider,
  type GithubIssue,
  type GithubPullRequest,
  type GithubProvider,
} from "./helpers/github-provider.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 180_000;
/** Answer delay that makes concurrent `list` processes overlap in the server; each source is one request. */
const ANSWER_DELAY_MS = 1_500;
const CONCURRENT_PROCESSES = 4;
/** Length of the rate-limit window of the third scenario; long enough that the whole scenario ends inside it. */
const RATE_LIMIT_WINDOW_MS = 600_000;
const MS_PER_DAY = 86_400_000;
const ISSUE: GithubIssue = { repo: "acme/widgets", number: 7, title: "Cache widgets", body: "Cache the widgets." };
const now = Date.now();
const RECENT: GithubPullRequest = {
  number: 21,
  title: "Recent change",
  headRefName: "bob/recent-21",
  authorLogin: "alice",
  createdAt: new Date(now - 3 * MS_PER_DAY).toISOString(),
  updatedAt: new Date(now - MS_PER_DAY).toISOString(),
  additions: 40,
  deletions: 5,
  changedFiles: 3,
  baseRefName: "main",
};
/** The operations behind the three sources of one project: pull requests, merged pull requests and issues. */
const SOURCE_OPERATIONS = ["PohunekWorkPullRequests", "PohunekWorkMergedPullRequests", "PohunekWorkIssues"] as const;

interface ProjectStatus {
  readonly project: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly freshness: Readonly<Record<string, { readonly fetched_at: string | null; readonly stale: boolean; readonly retry_at: string | null } | null>>;
}

interface ListedItem {
  readonly key: string;
}

interface ListPayload {
  readonly items: readonly ListedItem[];
  readonly projects: readonly ProjectStatus[];
}

let daemon: CoreDaemon | null = null;
let github: GithubProvider | null = null;

afterEach(async () => {
  try {
    await github?.stop();
  } finally {
    github = null;
    await daemon?.stop();
    daemon = null;
  }
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

async function setUp(): Promise<PluginFixture> {
  const core = await startCoreDaemon();
  daemon = core;
  await core.registerProject("widgets", ISSUE.repo);
  const provider = await startGithubProvider(join(core.root, "github"), ISSUE, [RECENT]);
  github = provider;
  const fixture = await writePluginConfig(core, [{ label: "widgets", repo: ISSUE.repo, template: GITHUB_ISSUE_PROJECT }], {
    overrides: { "github.endpoint": provider.endpoint, "github.gh_bin": provider.ghBin },
  });
  return { ...fixture, env: { ...fixture.env, NODE_EXTRA_CA_CERTS: provider.caFile } };
}

function requireProvider(): GithubProvider {
  if (github === null) throw new Error("the GitHub stand-in is not running");
  return github;
}

/** One `list --json` process; its exit code and envelope, whatever the source state. */
async function listRun(fixture: PluginFixture, args: readonly string[] = []): Promise<{ code: number; payload: ListPayload; err: string }> {
  const result = await runPlugin(fixture, ["list", "--json", ...args], PROCESS_TIMEOUT_MS);
  const envelope = JSON.parse(result.out) as { ok?: ListPayload };
  if (envelope.ok === undefined) throw new Error(`no ok payload (exit ${String(result.code)}): ${result.out}${result.err}`);
  return { code: result.code ?? -1, payload: envelope.ok, err: result.err };
}

function keysOf(payload: ListPayload): string[] {
  return payload.items.map((item) => item.key).sort();
}

test("a second list within max_age makes no GitHub request and reports the time of the first read", async () => {
  const fixture = await setUp();
  const provider = requireProvider();
  const first = await listRun(fixture);
  expect(first.code).toBe(0);
  for (const operation of SOURCE_OPERATIONS) expect(provider.requests[operation]).toBe(1);

  const second = await listRun(fixture);
  expect(second.code).toBe(0);
  for (const operation of SOURCE_OPERATIONS) expect(provider.requests[operation]).toBe(1);
  expect(keysOf(second.payload)).toEqual(keysOf(first.payload));

  const firstFetchedAt = first.payload.projects[0]?.freshness["github"]?.fetched_at ?? null;
  expect(typeof firstFetchedAt).toBe("string");
  expect(second.payload.projects[0]?.freshness["github"]).toEqual({ fetched_at: firstFetchedAt, stale: false, retry_at: null });
}, SCENARIO_TIMEOUT_MS);

test("concurrent list processes make one fetch per source and all report the same read", async () => {
  const fixture = await setUp();
  const provider = requireProvider();
  provider.setDelay(ANSWER_DELAY_MS);
  const runs = await Promise.all(Array.from({ length: CONCURRENT_PROCESSES }, () => listRun(fixture)));

  for (const operation of SOURCE_OPERATIONS) expect(provider.requests[operation]).toBe(1);
  expect(runs.every((run) => run.code === 0)).toBe(true);
  expect(new Set(runs.map((run) => keysOf(run.payload).join(","))).size).toBe(1);
  expect(new Set(runs.map((run) => run.payload.projects[0]?.freshness["github"]?.fetched_at)).size).toBe(1);
}, SCENARIO_TIMEOUT_MS);

test("a rate-limited refresh keeps the last good data as stale and no process asks GitHub again before the reset", async () => {
  const fixture = await setUp();
  const provider = requireProvider();
  const first = await listRun(fixture);
  expect(first.code).toBe(0);
  const fetchedAt = first.payload.projects[0]?.freshness["github"]?.fetched_at;

  const resetAtMs = Date.now() + RATE_LIMIT_WINDOW_MS;
  provider.setRateLimit(resetAtMs);
  const refreshed = await listRun(fixture, ["--refresh"]);
  // One attempt per source; the failed refresh does not retry.
  for (const operation of SOURCE_OPERATIONS) expect(provider.requests[operation]).toBe(2);
  expect(refreshed.code).not.toBe(0);
  expect(refreshed.err).toContain("github: rate_limited");
  expect(refreshed.err).toContain("showing data read at");
  expect(keysOf(refreshed.payload)).toEqual(keysOf(first.payload));
  const status = refreshed.payload.projects[0];
  expect(status?.sources["github"]).toBe("rate_limited");
  expect(status?.freshness["github"]?.stale).toBe(true);
  expect(status?.freshness["github"]?.fetched_at).toBe(fetchedAt);
  // The reset header has whole seconds, so the reported instant is the reset rounded up to the second.
  expect(Date.parse(status?.freshness["github"]?.retry_at ?? "")).toBe(Math.ceil(resetAtMs / 1000) * 1000);

  // Within the window no process reaches the server, explicit refreshes included. A plain read inside
  // max_age is served from the cache as fresh, so it is not affected by the rate limit at all.
  const beforeBackoff = { ...provider.requests };
  const plain = await listRun(fixture);
  const explicit = await listRun(fixture, ["--refresh"]);
  expect(plain.code).toBe(0);
  expect(plain.payload.projects[0]?.freshness["github"]?.stale).toBe(false);
  expect(explicit.payload.projects[0]?.sources["github"]).toBe("rate_limited");
  expect(explicit.payload.projects[0]?.freshness["github"]?.stale).toBe(true);
  expect(provider.requests).toEqual(beforeBackoff);
}, SCENARIO_TIMEOUT_MS);
