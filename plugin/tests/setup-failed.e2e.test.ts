// End-to-end tests of `pohunek-work do <key> implement` when the daemon reports warnings for the new
// session. The CLI runs as a real process against a fake `pohunek` executable, a fake `gh` and a local
// HTTPS GraphQL server; a warning of a failed setup hook has to fail the command before the session is
// waited for.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.ts";

const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const ROW_KEY = "github-issue:acme/widgets#7";
const SESSION_ID = "s-new";
const TOKEN = "test-token-not-a-secret";
const HOST = "localhost";
const PROCESS_TIMEOUT_MS = 60_000;

interface Warning {
  readonly kind: string;
  readonly message: string;
  readonly detail: string;
}

interface Recorded {
  readonly argv: readonly string[];
  readonly stdin: string;
}

interface CliResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

const HOOK_WARNING: Warning = {
  kind: "hook",
  message: "The post-create hook failed; the session proceeded without it.",
  detail: "/work/widgets/.pohunek/hooks/post-create exited with status exit status: 7",
};
const SETUP_FALLBACK_WARNING: Warning = {
  kind: "hook",
  message: "The post-create hook failed; the session proceeded without it.",
  detail: "/work/widgets/.pohunek/setup exited with status exit status: 3",
};
const SETUP_SCRIPT_WARNING: Warning = {
  kind: "setup_script",
  message: "The setup script failed.",
  detail: "/work/widgets/.pohunek/setup timed out",
};
const BASE_BRANCH_FALLBACK_WARNING: Warning = {
  kind: "base_branch_fallback",
  message: 'Requested base branch "feature/x" not found; used "main" instead.',
  detail: "git could not resolve refs/heads/feature/x",
};
const HOSTILE_WARNING: Warning = {
  kind: "hook",
  message: "The post-create hook failed;\nsecond line \u001b]8;;http://evil.example\u0007link",
  detail: "/work/wid\u00e9gets/\u202eevil exited with status exit status: 1",
};
const FETCH_WARNING: Warning = {
  kind: "fetch",
  message: 'Could not fetch requested base branch "feature/x" from origin; trying the repository default branch.',
  detail: "fatal: couldn't find remote ref feature/x",
};

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
  serverDir = await mkdtemp(join(tmpdir(), "pw-setup-failed-tls-"));
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
 * Fake `pohunek`: replays canned JSON by subcommand, records every call (argv and stdin) as one JSON line
 * and answers `session new` with a session whose metadata echoes the `--meta` pairs and whose warnings
 * come from `warnings.json`.
 */
const fakePohunek = (dir: string): string => `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const dir = ${JSON.stringify(dir)};
const argv = process.argv.slice(2);
const sub = argv.slice(0, 2).join(" ");
const stdin = sub === "session new" ? await Bun.stdin.text() : "";
appendFileSync(dir + "/calls.jsonl", JSON.stringify({ argv, stdin }) + "\\n");

const envelope = (ok) => JSON.stringify({ cli_version: "0.0.0", protocol: { minimum: 4, maximum: 4 }, ok });
const session = (metadata, warnings) => ({
  id: ${JSON.stringify(SESSION_ID)},
  name: "acme/widgets#7",
  project_label: "widgets",
  branch: "alice/issue-7/cache-widgets",
  worktree_path: "/work/wt/s-new",
  cwd: "/work/wt/s-new",
  state: "running",
  runtime: { state: "live" },
  metadata,
  warnings,
});

if (sub === "project list") {
  console.log(envelope([{ id: "prj_1", label: "widgets", origin_url: "git@github.com:acme/widgets.git", default_base_branch: "main" }]));
} else if (sub === "session list") {
  console.log(envelope([]));
} else if (sub === "notifications list") {
  console.log(envelope({ notifications: [] }));
} else if (sub === "session new" && existsSync(dir + "/session-new-error")) {
  console.log(JSON.stringify({ cli_version: "0.0.0", protocol: { minimum: 4, maximum: 4 }, err: { class: "transport", code: "request_timeout", msg: "timed out", recover: "" } }));
  process.exit(2);
} else if (sub === "session new") {
  const metadata = {};
  argv.forEach((arg, index) => {
    if (argv[index - 1] !== "--meta") return;
    const at = arg.indexOf("=");
    metadata[arg.slice(0, at)] = arg.slice(at + 1);
  });
  console.log(envelope(session(metadata, JSON.parse(readFileSync(dir + "/warnings.json", "utf8")))));
} else if (sub === "session wait") {
  console.log(envelope({ reason: "activity_matched", session: session({}, []) }));
} else {
  console.error("unexpected pohunek call: " + argv.join(" "));
  process.exit(64);
}
`;

interface Sandbox {
  readonly dir: string;
  readonly run: (args: readonly string[]) => Promise<CliResult>;
  readonly calls: () => Promise<readonly Recorded[]>;
}

async function sandbox(warnings: readonly Warning[]): Promise<Sandbox> {
  const dir = await mkdtemp(join(tmpdir(), "pw-setup-failed-"));
  tempDirs.push(dir);
  const configDir = join(dir, "config");
  const binDir = join(dir, "bin");
  await mkdir(join(configDir, "projects"), { recursive: true });
  await mkdir(binDir);
  const ghBin = join(binDir, "gh");
  const pohunekBin = join(binDir, "pohunek");
  await writeFile(ghBin, `#!/bin/sh\necho ${TOKEN}\n`);
  await writeFile(pohunekBin, fakePohunek(dir));
  await Promise.all([chmod(ghBin, 0o755), chmod(pohunekBin, 0o755)]);
  await writeFile(join(configDir, "config.toml"), GLOBAL_CONFIG(ghBin, pohunekBin));
  await writeFile(join(configDir, "projects", "widgets.toml"), PROJECT_CONFIG);
  await writeFile(join(dir, "warnings.json"), JSON.stringify(warnings));
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
  return { dir, run, calls };
}

function subcommands(calls: readonly Recorded[], name: string): readonly Recorded[] {
  return calls.filter((call) => call.argv.slice(0, 2).join(" ") === name);
}

function parseErrEnvelope(out: string): { class: string; code: string; msg: string } {
  return (JSON.parse(out) as { err: { class: string; code: string; msg: string } }).err;
}

// ---------------------------------------------------------------- scenarios

test("a failed post-create hook fails do before the session is waited for", async () => {
  const box = await sandbox([HOOK_WARNING]);
  const result = await box.run(["do", ROW_KEY, "implement", "--yes"]);

  expect(unexpectedOperations).toEqual([]);
  expect(result.code).toBe(2);
  expect(result.err).toContain(SESSION_ID);
  expect(result.err).toContain(HOOK_WARNING.message);
  expect(result.err).toContain(HOOK_WARNING.detail);
  expect(result.err).toContain(`pohunek session rm ${SESSION_ID}`);
  expect(result.out).not.toContain("started session");

  const calls = await box.calls();
  expect(subcommands(calls, "session new")).toHaveLength(1);
  expect(subcommands(calls, "session wait")).toHaveLength(0);
});

test("under --json a failed hook is an action error envelope with code setup_failed", async () => {
  const box = await sandbox([HOOK_WARNING]);
  const result = await box.run(["do", ROW_KEY, "implement", "--yes", "--json"]);

  expect(result.code).toBe(2);
  const err = parseErrEnvelope(result.out);
  expect(err.class).toBe("action");
  expect(err.code).toBe("setup_failed");
  expect(err.msg).toContain(HOOK_WARNING.detail);
  expect(err.msg).toContain(SESSION_ID);
  expect(subcommands(await box.calls(), "session wait")).toHaveLength(0);
});

test("the .pohunek/setup fallback and the reserved setup_script kind are setup_failed errors too", async () => {
  const box = await sandbox([SETUP_SCRIPT_WARNING]);
  const result = await box.run(["do", ROW_KEY, "implement", "--yes", "--json"]);

  expect(result.code).toBe(2);
  const err = parseErrEnvelope(result.out);
  expect(err.class).toBe("action");
  expect(err.code).toBe("setup_failed");
  expect(err.msg).toContain(SETUP_SCRIPT_WARNING.detail);
  expect(subcommands(await box.calls(), "session wait")).toHaveLength(0);

  const fallback = await sandbox([SETUP_FALLBACK_WARNING]);
  const fallbackResult = await fallback.run(["do", ROW_KEY, "implement", "--yes", "--json"]);
  expect(fallbackResult.code).toBe(2);
  expect(parseErrEnvelope(fallbackResult.out).msg).toContain(SETUP_FALLBACK_WARNING.detail);
});

test("warning text from the daemon reaches the human and the JSON error as strict ASCII on one line", async () => {
  const human = await (await sandbox([HOSTILE_WARNING])).run(["do", ROW_KEY, "implement", "--yes"]);
  expect(human.code).toBe(2);
  const lines = human.err.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  expect(/^[\x20-\x7e]*$/.test(lines[0] ?? "")).toBe(true);

  const json = await (await sandbox([HOSTILE_WARNING])).run(["do", ROW_KEY, "implement", "--yes", "--json"]);
  const err = parseErrEnvelope(json.out);
  expect(Object.keys(err).sort()).toEqual(["class", "code", "msg"]);
  expect(err.code).toBe("setup_failed");
  expect(/^[\x20-\x7e]*$/.test(err.msg)).toBe(true);
  expect(err.msg).toContain("second line");
  expect(err.msg).toContain("/work/wid");
});

test("a hook warning next to a fetch warning still fails the launch", async () => {
  const box = await sandbox([FETCH_WARNING, HOOK_WARNING]);
  const result = await box.run(["do", ROW_KEY, "implement", "--yes", "--json"]);

  expect(result.code).toBe(2);
  const err = parseErrEnvelope(result.out);
  expect(err.code).toBe("setup_failed");
  expect(err.msg).toContain(HOOK_WARNING.detail);
  expect(err.msg).not.toContain(FETCH_WARNING.detail);
  expect(subcommands(await box.calls(), "session wait")).toHaveLength(0);
});

test("a fetch warning alone leaves the launch successful and the session is waited for once", async () => {
  const box = await sandbox([FETCH_WARNING]);
  const result = await box.run(["do", ROW_KEY, "implement", "--yes", "--json"]);

  expect(result.err).toContain("pohunek launch warning: fetch");
  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.out) as { ok: { dry_run: boolean; result: { session_id: string; warnings: string[] } } };
  expect(envelope.ok.dry_run).toBe(false);
  expect(envelope.ok.result.session_id).toBe(SESSION_ID);
  expect(envelope.ok.result.warnings).toEqual(["fetch"]);

  const calls = await box.calls();
  expect(subcommands(calls, "session new")).toHaveLength(1);
  const waits = subcommands(calls, "session wait");
  expect(waits).toHaveLength(1);
  expect(waits[0]?.argv[2]).toBe(SESSION_ID);
});

test("a session new that the CLI gave up waiting for is launch_timed_out and never waited for", async () => {
  const box = await sandbox([]);
  await writeFile(join(box.dir, "session-new-error"), "");
  const result = await box.run(["do", ROW_KEY, "implement", "--yes", "--json"]);

  expect(result.code).toBe(2);
  const err = parseErrEnvelope(result.out);
  expect(err.code).toBe("launch_timed_out");
  expect(err.msg).toContain("pohunek session list");
  expect(subcommands(await box.calls(), "session wait")).toHaveLength(0);
});

test("a base_branch_fallback warning alone leaves the launch successful", async () => {
  const box = await sandbox([BASE_BRANCH_FALLBACK_WARNING]);
  const result = await box.run(["do", ROW_KEY, "implement", "--yes", "--json"]);

  expect(result.code).toBe(0);
  const envelope = JSON.parse(result.out) as { ok: { result: { warnings: string[] } } };
  expect(envelope.ok.result.warnings).toEqual(["base_branch_fallback"]);
  expect(subcommands(await box.calls(), "session wait")).toHaveLength(1);
});

test("a launch without warnings succeeds in text mode", async () => {
  const box = await sandbox([]);
  const result = await box.run(["do", ROW_KEY, "implement", "--yes"]);

  expect(result.code).toBe(0);
  expect(result.out).toContain(`started session ${SESSION_ID}`);
  expect(subcommands(await box.calls(), "session wait")).toHaveLength(1);
});
