// End-to-end tests of `pohunek-work do <key> cleanup` with a project `[teardown]` command. The CLI runs
// as a real process against a fake `pohunek` executable, a fake `gh`, a local HTTPS GraphQL server, a
// real git repository with a real worktree and a fake teardown executable. Every fake appends to one
// call log, so the order of the teardown and `session rm` is read from a single file.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const ROW_KEY = "github-issue:acme/widgets#7";
const SESSION_ID = "s-clean";
const BRANCH = "alice/issue-7/cache-widgets";
const TOKEN = "test-token-not-a-secret";
const HOST = "localhost";
const GIT = "/usr/bin/git";
const PROCESS_TIMEOUT_MS = 60_000;
const TEARDOWN_TIMEOUT_MS = 30_000;
const SHORT_TEARDOWN_TIMEOUT_MS = 1500;

interface Recorded {
  /** Present for a `pohunek` call. */
  readonly argv?: readonly string[];
  /** Present for a teardown run: the working directory it saw and its arguments. */
  readonly teardown?: { readonly cwd: string; readonly args: string };
}

interface CliResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

// ---------------------------------------------------------------- fake GraphQL server

const PAGE_INFO = { hasNextPage: false, endCursor: "end" };
const EMPTY_CONNECTION = { issueCount: 0, pageInfo: PAGE_INFO, nodes: [] };

const ISSUE = {
  number: 7,
  url: "https://github.example/acme/widgets/issues/7",
  title: "Cache widgets",
  state: "OPEN",
  body: "Cache the widgets.",
};

/** Answers the plugin's real queries for one open, started issue without a pull request. */
function graphqlData(operation: string, variables: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  const rateLimit = { remaining: 4900 };
  switch (operation) {
    case "PohunekWorkPullRequests": {
      const searches = Object.keys(variables)
        .filter((name) => name.startsWith("q_"))
        .map((name) => [name.slice(2), EMPTY_CONNECTION] as const);
      return { rateLimit, ...Object.fromEntries(searches) };
    }
    case "PohunekWorkMergedPullRequests":
      return { rateLimit, merged: EMPTY_CONNECTION };
    case "PohunekWorkIssues":
      return {
        rateLimit,
        issues: {
          issueCount: 1,
          pageInfo: PAGE_INFO,
          nodes: [
            {
              id: "I_node_7",
              number: ISSUE.number,
              url: ISSUE.url,
              title: ISSUE.title,
              labels: { nodes: [{ name: "in-progress" }], pageInfo: PAGE_INFO },
            },
          ],
        },
      };
    case "PohunekWorkIssueDetail":
      return { rateLimit, repository: { issue: ISSUE } };
    default:
      return null;
  }
}

let serverDir = "";
let server: ReturnType<typeof Bun.serve> | null = null;
let caPath = "";
let endpoint = "";
const unexpectedOperations: string[] = [];

beforeAll(async () => {
  serverDir = await mkdtemp(join(tmpdir(), "pw-cleanup-teardown-tls-"));
  const keyPath = join(serverDir, "key.pem");
  caPath = join(serverDir, "cert.pem");
  const generated = await exec(
    [
      "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", keyPath, "-out", caPath, "-subj", `/CN=${HOST}`,
      "-addext", `subjectAltName=DNS:${HOST},IP:127.0.0.1`,
    ],
    { timeoutMs: PROCESS_TIMEOUT_MS },
  );
  expect(generated.exitCode).toBe(0);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: Bun.file(keyPath), cert: Bun.file(caPath) },
    async fetch(request) {
      const body = (await request.json()) as { query: string; variables: Record<string, unknown> };
      const operation = /query\s+(\w+)/.exec(body.query)?.[1] ?? "";
      const data = graphqlData(operation, body.variables);
      if (data === null) {
        unexpectedOperations.push(operation);
        return Response.json({ errors: [{ message: `unexpected operation ${operation}` }] });
      }
      return Response.json({ data });
    },
  });
  endpoint = `https://${HOST}:${String(server.port)}/graphql`;
});

afterAll(async () => {
  await server?.stop(true);
  await rm(serverDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- per-test sandbox

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const GLOBAL_CONFIG = (ghBin: string, pohunekBin: string): string => `
[identity]
github_login = "alice"
agent_identities = ["alice", "alice-agent"]
review_teams = []

[github]
endpoint = "${endpoint}"
gh_bin = "${ghBin}"
timeout_ms = 20000
pull_request_page_size = 20
issue_page_size = 30
nested_page_size = 50
thread_comment_page_size = 10
merged_lookback_days = 30

[pohunek]
bin = "${pohunekBin}"
timeout_ms = 20000
notifications_page_size = 25

[watch]
poll_interval_secs = 300

[notify]
command = "/usr/bin/notify-send"
timeout_ms = 5000

[log]
max_string_length = 2000

[actions]
branch_prefix = "alice"
review_branch_segment = "review"
slug_max_length = 40
issue_number_prefix = "issue-"
issue_body_max_length = 2000
launch_timeout_ms = 20000
launch_kill_margin_ms = 5000
prompt_delivery_timeout_ms = 4000
git_bin = "/usr/bin/git"
git_timeout_ms = 15000
cleanup_remote = "origin"
cleanup_timeout_ms = 60000
holder_entries_listed = 5
holder_entry_max_length = 80

[policy]
delegable = ["review"]
max_active_tasks = 2
daily_cost_ceiling_usd = 12.5

[profiles]
implement = "profile-a"
review = "profile-b"

[tui]
self_bin = "/usr/local/bin/pohunek-work"
refresh_interval_secs = 300
list_timeout_ms = 60000
stale_after_secs = 900
stale_pr_days = 30
initial_view = "mine"
bell_on_transition = false
open_command = "/usr/bin/xdg-open"
open_url_hosts = ["github.com"]
stderr_max_lines = 10
detail_min_width = 120
`;

const PROJECT_CONFIG = `
[project]
pohunek_label = "widgets"
repo = "acme/widgets"
reviews = "session"
issue_source = "github"
issue_signal = "labels"
started_labels = ["in-progress"]
paused_labels = []
branch_pattern = "^alice/issue-(?P<key>[0-9]+)/"
ignored_checks = []
policy_checks = []
ai_reviewers = []
`;

/**
 * Fake `pohunek`: answers the reads and writes of `do cleanup` in the JSON shapes the plugin parses. The
 * session is listed as stopped until `session rm` ran, which deletes the worktree directory like the real
 * command and records itself in the call log.
 */
const fakePohunek = (dir: string, worktree: string): string => `#!${process.execPath}
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";

const dir = ${JSON.stringify(dir)};
const worktree = ${JSON.stringify(worktree)};
const argv = process.argv.slice(2);
const sub = argv.slice(0, 2).join(" ");
appendFileSync(dir + "/calls.jsonl", JSON.stringify({ argv }) + "\\n");

const envelope = (ok) => JSON.stringify({ cli_version: "0.0.0", protocol: { minimum: 4, maximum: 4 }, ok });
const removed = existsSync(dir + "/removed");
const session = {
  id: ${JSON.stringify(SESSION_ID)},
  name: "acme/widgets#7",
  project_label: "widgets",
  branch: ${JSON.stringify(BRANCH)},
  worktree_path: worktree,
  cwd: worktree,
  state: "stopped",
  runtime: { state: "dead" },
  metadata: {
    "work.link.provider": "github",
    "work.link.kind": "issue",
    "work.link.id": "acme/widgets#7",
  },
};

if (sub === "project list") {
  console.log(envelope([{ id: "prj_1", label: "widgets", origin_url: "git@github.com:acme/widgets.git", default_base_branch: "main" }]));
} else if (sub === "session list") {
  console.log(envelope(removed ? [] : [session]));
} else if (sub === "project show") {
  console.log(envelope({ worktrees: [{ path: worktree, branch: ${JSON.stringify(BRANCH)}, head: "0".repeat(40), session_id: ${JSON.stringify(SESSION_ID)} }] }));
} else if (sub === "session diff") {
  console.log(envelope({ base: "main", truncated: false, diff: "" }));
} else if (sub === "notifications list") {
  console.log(envelope({ notifications: [] }));
} else if (sub === "session rm") {
  rmSync(worktree, { recursive: true, force: true });
  writeFileSync(dir + "/removed", "");
  console.log(envelope({ removed: true, stopped: false, worktrees_removed: 1, worktrees_failed: 0 }));
} else {
  console.error("unexpected pohunek call: " + argv.join(" "));
  process.exit(64);
}
`;

/** Fake teardown: logs its working directory and arguments, then behaves as `teardown-mode` says. */
const fakeTeardown = (dir: string): string => `#!/bin/sh
printf '{"teardown":{"cwd":"%s","args":"%s"}}\\n' "$(pwd -P)" "$*" >> ${dir}/calls.jsonl
case "$(cat ${dir}/teardown-mode)" in
  fail) exit 3 ;;
  sleep) sleep 30 ;;
esac
exit 0
`;

type TeardownMode = "ok" | "fail" | "sleep";

interface SandboxOptions {
  /** Content of the project's `[teardown]` table; omitted for a project without one. */
  readonly teardown?: (teardownBin: string) => string;
  readonly teardownMode?: TeardownMode;
  /** Replaces the project file wholesale (config validation cases). */
  readonly projectToml?: string;
}

interface Sandbox {
  readonly dir: string;
  readonly worktree: string;
  readonly teardownBin: string;
  readonly run: (args: readonly string[]) => Promise<CliResult>;
  readonly calls: () => Promise<readonly Recorded[]>;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await exec([GIT, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-C", cwd, ...args], {
    timeoutMs: PROCESS_TIMEOUT_MS,
    env: { PATH: process.env["PATH"] ?? "", HOME: cwd, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  expect(result.exitCode, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
}

/** A bare origin, a clone and a worktree on the pushed session branch, so all seven checks pass for real. */
async function createRepository(dir: string): Promise<string> {
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  const worktree = join(dir, "wt");
  await mkdir(origin);
  await git(origin, ["init", "--bare", "--initial-branch=main"]);
  await git(dir, ["clone", origin, repo]);
  await writeFile(join(repo, "README.md"), "widgets\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["push", "origin", "HEAD:refs/heads/main"]);
  await git(repo, ["worktree", "add", "-b", BRANCH, worktree, "HEAD"]);
  await git(worktree, ["push", "-u", "origin", BRANCH]);
  return await realpath(worktree);
}

async function sandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "pw-cleanup-teardown-"));
  tempDirs.push(dir);
  const worktree = await createRepository(dir);
  const configDir = join(dir, "config");
  const binDir = join(dir, "bin");
  await mkdir(join(configDir, "projects"), { recursive: true });
  await mkdir(binDir);
  const ghBin = join(binDir, "gh");
  const pohunekBin = join(binDir, "pohunek");
  const teardownBin = join(binDir, "teardown");
  await writeFile(ghBin, `#!/bin/sh\necho ${TOKEN}\n`);
  await writeFile(pohunekBin, fakePohunek(dir, worktree));
  await writeFile(teardownBin, fakeTeardown(dir));
  await Promise.all([chmod(ghBin, 0o755), chmod(pohunekBin, 0o755), chmod(teardownBin, 0o755)]);
  await writeFile(join(configDir, "config.toml"), GLOBAL_CONFIG(ghBin, pohunekBin));
  const project = options.projectToml ?? `${PROJECT_CONFIG}${options.teardown === undefined ? "" : options.teardown(teardownBin)}`;
  await writeFile(join(configDir, "projects", "widgets.toml"), project);
  await writeFile(join(dir, "teardown-mode"), options.teardownMode ?? "ok");
  await writeFile(join(dir, "calls.jsonl"), "");

  const run = async (args: readonly string[]): Promise<CliResult> => {
    const result = await exec(["bun", MAIN, ...args], {
      timeoutMs: PROCESS_TIMEOUT_MS,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: dir,
        POHUNEK_WORK_CONFIG_DIR: configDir,
        POHUNEK_WORK_STATE_DIR: join(dir, "state"),
        NODE_EXTRA_CA_CERTS: caPath,
      },
    });
    return { code: result.exitCode, out: result.stdout, err: result.stderr };
  };
  const calls = async (): Promise<readonly Recorded[]> =>
    (await readFile(join(dir, "calls.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Recorded);
  return { dir, worktree, teardownBin, run, calls };
}

const teardownTable = (timeoutMs: number) => (bin: string): string => `
[teardown]
argv = ["${bin}", "--network-cleanup"]
timeout_ms = ${String(timeoutMs)}
`;

function pohunekSubcommands(calls: readonly Recorded[], name: string): readonly Recorded[] {
  return calls.filter((call) => call.argv?.slice(0, 2).join(" ") === name);
}

/** Position of the first entry matching `predicate` in the call log; -1 when none does. */
function positionOf(calls: readonly Recorded[], predicate: (call: Recorded) => boolean): number {
  return calls.findIndex(predicate);
}

const isRm = (call: Recorded): boolean => call.argv?.slice(0, 2).join(" ") === "session rm";
const isTeardown = (call: Recorded): boolean => call.teardown !== undefined;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function parseErr(out: string): { class: string; code: string; msg: string } {
  return (JSON.parse(out) as { err: { class: string; code: string; msg: string } }).err;
}

// ---------------------------------------------------------------- scenarios

test("the teardown runs once in the worktree before session rm and the cleanup succeeds", async () => {
  const box = await sandbox({ teardown: teardownTable(TEARDOWN_TIMEOUT_MS) });
  const result = await box.run(["do", ROW_KEY, "cleanup", "--yes", "--json"]);

  expect(unexpectedOperations).toEqual([]);
  expect(result.err).toBe("");
  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.out) as { ok: { dry_run: boolean; plan: { teardown_argv: string[] }; result: { teardown_ran: boolean; removed: boolean } } };
  expect(envelope.ok.dry_run).toBe(false);
  expect(envelope.ok.plan.teardown_argv).toEqual([box.teardownBin, "--network-cleanup"]);
  expect(envelope.ok.result.teardown_ran).toBe(true);
  expect(envelope.ok.result.removed).toBe(true);

  const calls = await box.calls();
  const runs = calls.filter(isTeardown);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.teardown).toEqual({ cwd: box.worktree, args: "--network-cleanup" });
  expect(pohunekSubcommands(calls, "session rm")).toHaveLength(1);
  expect(positionOf(calls, isTeardown)).toBeLessThan(positionOf(calls, isRm));
  // The session list recheck is the last read before the removal.
  const rm = positionOf(calls, isRm);
  expect(calls[rm - 1]?.argv?.slice(0, 2).join(" ")).toBe("session list");
  expect(await exists(box.worktree)).toBe(false);
});

test("a teardown that exits nonzero refuses the cleanup and removes nothing", async () => {
  const box = await sandbox({ teardown: teardownTable(TEARDOWN_TIMEOUT_MS), teardownMode: "fail" });
  const result = await box.run(["do", ROW_KEY, "cleanup", "--yes", "--json"]);

  expect(result.code).not.toBe(0);
  const err = parseErr(result.out);
  expect(err.class).toBe("action");
  expect(err.code).toBe("command_failed");
  expect(err.msg).toContain("exited with code 3");
  expect(err.msg).toContain("the session was not touched and nothing was removed");

  const calls = await box.calls();
  expect(calls.filter(isTeardown)).toHaveLength(1);
  expect(pohunekSubcommands(calls, "session rm")).toHaveLength(0);
  expect(await exists(join(box.worktree, ".git"))).toBe(true);
});

test("a teardown that outlives its timeout is command_timed_out and removes nothing", async () => {
  const box = await sandbox({ teardown: teardownTable(SHORT_TEARDOWN_TIMEOUT_MS), teardownMode: "sleep" });
  const result = await box.run(["do", ROW_KEY, "cleanup", "--yes", "--json"]);

  expect(result.code).not.toBe(0);
  const err = parseErr(result.out);
  expect(err.code).toBe("command_timed_out");
  expect(err.msg).toContain(`did not finish within ${String(SHORT_TEARDOWN_TIMEOUT_MS)} ms`);
  expect(err.msg).toContain("nothing was removed");

  const calls = await box.calls();
  expect(calls.filter(isTeardown)).toHaveLength(1);
  expect(pohunekSubcommands(calls, "session rm")).toHaveLength(0);
  expect(await exists(join(box.worktree, ".git"))).toBe(true);
});

test("--dry-run shows the teardown command and executes nothing", async () => {
  const box = await sandbox({ teardown: teardownTable(TEARDOWN_TIMEOUT_MS) });

  const text = await box.run(["do", ROW_KEY, "cleanup", "--dry-run"]);
  expect(text.code).toBe(0);
  expect(text.out).toContain(`teardown: ${box.teardownBin} --network-cleanup`);

  const json = await box.run(["do", ROW_KEY, "cleanup", "--dry-run", "--json"]);
  expect(json.code).toBe(0);
  const envelope = JSON.parse(json.out) as { ok: { dry_run: boolean; plan: { eligible: boolean; teardown_argv: string[] } } };
  expect(envelope.ok.dry_run).toBe(true);
  expect(envelope.ok.plan.eligible).toBe(true);
  expect(envelope.ok.plan.teardown_argv).toEqual([box.teardownBin, "--network-cleanup"]);

  const calls = await box.calls();
  expect(calls.filter(isTeardown)).toHaveLength(0);
  expect(pohunekSubcommands(calls, "session rm")).toHaveLength(0);
  expect(await exists(join(box.worktree, ".git"))).toBe(true);
});

test("a project without [teardown] cleans up as before and reports no teardown", async () => {
  const box = await sandbox();

  const dry = await box.run(["do", ROW_KEY, "cleanup", "--dry-run", "--json"]);
  expect(dry.code).toBe(0);
  const plan = (JSON.parse(dry.out) as { ok: { plan: { teardown_argv: string[] | null } } }).ok.plan;
  expect(plan.teardown_argv).toBeNull();
  const text = await box.run(["do", ROW_KEY, "cleanup", "--dry-run"]);
  expect(text.out).not.toContain("\nteardown:");

  const result = await box.run(["do", ROW_KEY, "cleanup", "--yes", "--json"]);
  expect(result.code).toBe(0);
  const done = (JSON.parse(result.out) as { ok: { result: { teardown_ran: boolean; removed: boolean } } }).ok.result;
  expect(done).toMatchObject({ teardown_ran: false, removed: true });
  const calls = await box.calls();
  expect(calls.filter(isTeardown)).toHaveLength(0);
  expect(pohunekSubcommands(calls, "session rm")).toHaveLength(1);
});

const INVALID_TEARDOWNS: readonly { readonly name: string; readonly table: (bin: string) => string; readonly message: string }[] = [
  { name: "a relative argv[0]", table: () => '\n[teardown]\nargv = ["teardown.sh"]\ntimeout_ms = 1000\n', message: "[teardown] argv must start with an absolute program path" },
  { name: "a missing timeout_ms", table: (bin) => `\n[teardown]\nargv = ["${bin}"]\n`, message: "[teardown] timeout_ms is required" },
  { name: "a missing argv", table: () => "\n[teardown]\ntimeout_ms = 1000\n", message: "[teardown] argv is required" },
  { name: "an empty argv", table: () => "\n[teardown]\nargv = []\ntimeout_ms = 1000\n", message: "[teardown] argv must not be empty" },
  { name: "a non-positive timeout_ms", table: (bin) => `\n[teardown]\nargv = ["${bin}"]\ntimeout_ms = 0\n`, message: "[teardown] timeout_ms must be a positive integer" },
  { name: "an unknown key", table: (bin) => `\n[teardown]\nargv = ["${bin}"]\ntimeout_ms = 1000\nshell = true\n`, message: "[teardown] shell is not a known key" },
];

for (const invalid of INVALID_TEARDOWNS) {
  test(`the config loader rejects ${invalid.name} in [teardown]`, async () => {
    const box = await sandbox({ teardown: invalid.table });
    const result = await box.run(["do", ROW_KEY, "cleanup", "--dry-run", "--json"]);

    expect(result.code).not.toBe(0);
    const err = parseErr(result.out);
    expect(err.class).toBe("configuration");
    expect(err.code).toBe("config_invalid");
    expect(err.msg).toContain(invalid.message);
    expect(await box.calls()).toEqual([]);
  });
}
