// End-to-end scenarios of the pull request fields `list --json` gives for reviewing older work, and of
// the rows `--stale-days` leaves out, against a real pohunekd from the pinned core release. The owner's
// pull requests come from a local GraphQL server (helpers/github-provider.ts): one updated a day ago, one
// untouched for thirty days. Every age is checked against `read_at`, the instant `list` read its sources.
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
const SCENARIO_TIMEOUT_MS = 120_000;
const MS_PER_DAY = 86_400_000;
/** Read by the plugin and the test within one run; both use the same system clock. */
const CLOCK_TOLERANCE_MS = 60_000;
const STALE_DAYS = 7;
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
const OLD: GithubPullRequest = {
  number: 22,
  title: "Old change",
  headRefName: "bob/old-22",
  authorLogin: "alice",
  createdAt: new Date(now - 45 * MS_PER_DAY).toISOString(),
  updatedAt: new Date(now - 30 * MS_PER_DAY).toISOString(),
  additions: 100,
  deletions: 2,
  changedFiles: 7,
  baseRefName: "release/1",
};
const ISSUE_KEY = "github-issue:acme/widgets#7";
const RECENT_KEY = "github:acme/widgets#21";
const OLD_KEY = "github:acme/widgets#22";

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
  const provider = await startGithubProvider(join(core.root, "github"), ISSUE, [RECENT, OLD]);
  github = provider;
  const fixture = await writePluginConfig(core, [{ label: "widgets", repo: ISSUE.repo, template: GITHUB_ISSUE_PROJECT }], {
    overrides: { "github.endpoint": provider.endpoint, "github.gh_bin": provider.ghBin },
  });
  return { ...fixture, env: { ...fixture.env, NODE_EXTRA_CA_CERTS: provider.caFile } };
}

interface ListedPullRequest {
  readonly key: string;
  readonly pull_request: Record<string, unknown> | null;
}

interface ListPayload {
  readonly items: readonly ListedPullRequest[];
  readonly omitted_ignored: number;
  readonly omitted_stale: number;
  readonly read_at: string;
}

/** The `ok` payload of `list --json` with the given extra arguments. */
async function listJson(fixture: PluginFixture, args: readonly string[] = []): Promise<ListPayload> {
  const result = await runPlugin(fixture, ["list", "--json", ...args], PROCESS_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`list --json failed (${String(result.code)}): ${result.out}${result.err}`);
  const envelope = JSON.parse(result.out) as { ok?: ListPayload };
  if (envelope.ok === undefined) throw new Error(`no ok payload: ${result.out}`);
  return envelope.ok;
}

function rowOf(payload: ListPayload, key: string): Record<string, unknown> {
  const row = payload.items.find((item) => item.key === key);
  if (row === undefined || row.pull_request === null) throw new Error(`no pull request row ${key}`);
  return row.pull_request;
}

test("list --json gives the opening time, base, size and both ages of each pull request, measured at read_at", async () => {
  const fixture = await setUp();
  const before = Date.now();
  const payload = await listJson(fixture);
  const after = Date.now();

  const readAt = Date.parse(payload.read_at);
  expect(readAt).toBeGreaterThanOrEqual(before - CLOCK_TOLERANCE_MS);
  expect(readAt).toBeLessThanOrEqual(after + CLOCK_TOLERANCE_MS);

  const pr = rowOf(payload, RECENT_KEY);
  expect(pr["created_at"]).toBe(RECENT.createdAt);
  expect(pr["base_branch"]).toBe("main");
  expect(pr["size"]).toEqual({ additions: 40, deletions: 5, changed_files: 3 });
  expect(pr["age_days"]).toBeCloseTo((readAt - Date.parse(RECENT.createdAt)) / MS_PER_DAY, 6);
  expect(pr["idle_days"]).toBeCloseTo((readAt - Date.parse(RECENT.updatedAt)) / MS_PER_DAY, 6);

  const old = rowOf(payload, OLD_KEY);
  expect(old["base_branch"]).toBe("release/1");
  expect(old["age_days"] as number).toBeGreaterThan(old["idle_days"] as number);
  expect(old["idle_days"] as number).toBeGreaterThan(STALE_DAYS);
  expect(payload.omitted_stale).toBe(0);
}, SCENARIO_TIMEOUT_MS);

test("list --stale-days removes the pull requests idle for longer than N days and counts them in omitted_stale", async () => {
  const fixture = await setUp();
  const payload = await listJson(fixture, ["--stale-days", String(STALE_DAYS)]);

  // The issue row carries no pull request, so no staleness applies to it.
  expect(payload.items.map((item) => item.key).sort()).toEqual([ISSUE_KEY, RECENT_KEY].sort());
  expect(payload.omitted_stale).toBe(1);
  expect(payload.omitted_ignored).toBe(0);

  // The same clock decides: the kept row is idle for less than N days, the removed one for more.
  expect(rowOf(payload, RECENT_KEY)["idle_days"] as number).toBeLessThan(STALE_DAYS);
}, SCENARIO_TIMEOUT_MS);

test("list --stale-days with a window no pull request exceeds keeps every row and reports omitted_stale 0", async () => {
  const fixture = await setUp();
  const payload = await listJson(fixture, ["--stale-days", "365"]);

  expect(payload.items.map((item) => item.key).sort()).toEqual([ISSUE_KEY, OLD_KEY, RECENT_KEY].sort());
  expect(payload.omitted_stale).toBe(0);
}, SCENARIO_TIMEOUT_MS);

test("the table names the rows --stale-days hid", async () => {
  const fixture = await setUp();
  const result = await runPlugin(fixture, ["list", "--stale-days", String(STALE_DAYS)], PROCESS_TIMEOUT_MS);

  expect(result.code).toBe(0);
  expect(result.out).toContain("1 stale row(s) hidden (--stale-days)");
  expect(result.out).not.toContain(OLD_KEY);
}, SCENARIO_TIMEOUT_MS);
