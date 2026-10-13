// End-to-end scenarios of the review-bot re-request in the `rebase` prompt, against a real pohunekd from the
// pinned core release. `do <key> rebase --dry-run` plans from the GitHub pull request that the local GraphQL
// server answers (helpers/github-provider.ts) and prints the prompt the launch would send. The project file
// decides the bot: a login is requested again after the force-push, `none` requests nothing.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, runPlugin, startCoreDaemon, writePluginConfig, type CliResult, type CoreDaemon, type PluginFixture } from "./helpers/core-daemon.ts";
import { GITHUB_ISSUE_PROJECT, startGithubProvider, type GithubIssue, type GithubProvider } from "./helpers/github-provider.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const EXIT_ERROR = 2;
const BOT_LOGIN = "review-bot";
const ISSUE: GithubIssue = { repo: "acme/widgets", number: 7, title: "Cache widgets", body: "Cache the widgets." };
/** Joins the pull request through `branch_pattern` of the project, which takes the issue number from the branch. */
const ROW_KEY = `github-issue:${ISSUE.repo}#${String(ISSUE.number)}`;
const PULL_REQUEST = { number: 12, title: "Cache widgets", headRefName: "alice/issue-7/cache-widgets", authorLogin: "alice" };
/** The project file of `GITHUB_ISSUE_PROJECT` with a review bot instead of `none`. */
const BOT_PROJECT = GITHUB_ISSUE_PROJECT.replace('review_bot = "none"', `review_bot = ${JSON.stringify(BOT_LOGIN)}`);
const REQUEST_MARKER = "requestReviewsByLogin";
/** Agent profile of the planned rebase; a dry run never launches it, so the name only has to be a valid profile name. */
const AGENT_PROFILE = "shell";

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

/** A daemon, a GitHub server that answers the conflicting pull request, and a configuration with `projectFile`. */
async function setUp(projectFile: string): Promise<PluginFixture> {
  const core = await startCoreDaemon();
  daemon = core;
  await core.registerProject("widgets", ISSUE.repo);
  const provider = await startGithubProvider(join(core.root, "github"), ISSUE, PULL_REQUEST);
  github = provider;
  const fixture = await writePluginConfig(core, [{ label: "widgets", repo: ISSUE.repo, template: projectFile }], {
    overrides: { "github.endpoint": provider.endpoint, "github.gh_bin": provider.ghBin },
  });
  return { ...fixture, env: { ...fixture.env, NODE_EXTRA_CA_CERTS: provider.caFile } };
}

/** The prompt of the planned `rebase`, from the envelope of `do --dry-run --json`. */
async function rebasePrompt(fixture: PluginFixture): Promise<string> {
  const result: CliResult = await runPlugin(fixture, ["do", ROW_KEY, "rebase", "--dry-run", "--json", "--profile", AGENT_PROFILE], PROCESS_TIMEOUT_MS);
  if (result.code !== 0) throw new Error(`do rebase --dry-run failed (${String(result.code)}): ${result.out}${result.err}`);
  const envelope = JSON.parse(result.out) as { ok?: { plan?: { prompt?: string } } };
  const prompt = envelope.ok?.plan?.prompt;
  if (prompt === undefined) throw new Error(`no plan prompt in ${result.out}`);
  return prompt;
}

test("rebase asks the project's review bot for the new head and verifies the request", async () => {
  const fixture = await setUp(BOT_PROJECT);
  const prompt = await rebasePrompt(fixture);

  expect(github?.unexpectedOperations).toEqual([]);
  expect(prompt).toContain("## Review bot");
  expect(prompt).toContain(`botLogins: ["${BOT_LOGIN}[bot]"]`);
  expect(prompt).toContain(`reviewRequests`);
  expect(prompt).toContain(`Verify the request`);
  // The request follows the push, so a failed push never asks the bot.
  expect(prompt.indexOf("git push --force-with-lease")).toBeLessThan(prompt.indexOf("## Review bot"));
  expect(prompt.indexOf("## Review bot")).toBeLessThan(prompt.indexOf("## When done"));
}, SCENARIO_TIMEOUT_MS);

test("rebase in a project with review_bot none requests no review", async () => {
  const fixture = await setUp(GITHUB_ISSUE_PROJECT);
  const prompt = await rebasePrompt(fixture);

  expect(github?.unexpectedOperations).toEqual([]);
  expect(prompt).not.toContain("## Review bot");
  expect(prompt).not.toContain(REQUEST_MARKER);
  expect(prompt).toContain("## When done");
}, SCENARIO_TIMEOUT_MS);

test("a review_bot that is neither none nor a GitHub login stops every command with the key named", async () => {
  const fixture = await setUp(GITHUB_ISSUE_PROJECT.replace('review_bot = "none"', 'review_bot = "not a login"'));
  const result = await runPlugin(fixture, ["list", "--json"], PROCESS_TIMEOUT_MS);

  expect(result.code).toBe(EXIT_ERROR);
  expect(`${result.out}${result.err}`).toContain("review_bot");
}, SCENARIO_TIMEOUT_MS);
