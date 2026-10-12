// End-to-end scenarios of the two launch failures `pohunek-work manager start` and `do` share, against a
// real pohunekd from the pinned core release. Every scenario gets its own daemon. The launched agent is the
// host profile `silent`: a script that turns off the terminal echo and sleeps, so it never reads the prompt,
// never prints and never reaches activity `working`. That gives `launch_unverified` after
// `[actions] prompt_delivery_timeout_ms`, and, with `[actions] launch_timeout_ms` below the time core keeps
// `session new` open for such an agent, `launch_timed_out` while the daemon still creates the session.
// `do` reads its GitHub issue from a local GraphQL server (helpers/github-provider.ts).
import { afterEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DAEMON_STOP_HOOK_TIMEOUT_MS,
  installAgentProfile,
  runPlugin,
  startCoreDaemon,
  workersBelow,
  writePluginConfig,
  type CliResult,
  type CoreDaemon,
  type PluginFixture,
} from "./helpers/core-daemon.ts";
import { GITHUB_ISSUE_PROJECT, startGithubProvider, type GithubIssue, type GithubProvider } from "./helpers/github-provider.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 120_000;
/** Upper bound for the daemon to finish creating a session the plugin stopped waiting for. */
const SESSION_CREATE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;
const EXIT_ERROR = 2;
/** The host agent profile that never reads its input. */
const SILENT_PROFILE = "silent";
/** How long the silent agent sleeps; longer than any scenario, the daemon's stop ends it. */
const SILENT_SLEEP_SECS = 3600;
/**
 * `[actions] launch_timeout_ms` of the timed-out scenarios. With `--input-stdin` the CLI asks for the extended
 * input-ready wait, so core keeps `session new` open for a silent agent until its startup grace of 5 s passes
 * (core's `DEFAULT_INPUT_TIMING`). One second leaves the CLI ample time to connect and send the request on a
 * loaded host, and its own deadline still fires long before the daemon answers.
 */
const SHORT_LAUNCH_TIMEOUT_MS = 1000;
const ISSUE: GithubIssue = { repo: "acme/widgets", number: 7, title: "Cache widgets", body: "Cache the widgets." };
const ISSUE_KEY = `${ISSUE.repo}#${String(ISSUE.number)}`;
const ROW_KEY = `github-issue:${ISSUE_KEY}`;
/** `<branch_prefix>/<issue_number_prefix><n>/<slug of the title>` of the fixture configuration. */
const ISSUE_BRANCH = "alice/issue-7/cache-widgets";
const MANAGER_METADATA = { "work.role": "manager", "work.manager.projects": "widgets" };

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

function quoted(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function requireProgram(name: string): string {
  const path = Bun.which(name);
  if (path === null) throw new Error(`${name} is not on PATH; the silent agent profile needs it`);
  return path;
}

/** Installs `SILENT_PROFILE`: without the echo off, the terminal would show the prompt and the shell manifest could match its words. */
async function installSilentAgent(core: CoreDaemon): Promise<void> {
  const script = `#!/bin/sh\n${quoted(requireProgram("stty"))} -echo\nexec ${quoted(requireProgram("sleep"))} ${String(SILENT_SLEEP_SECS)}\n`;
  await installAgentProfile(core, SILENT_PROFILE, script);
}

async function startDaemon(): Promise<CoreDaemon> {
  const started = await startCoreDaemon();
  daemon = started;
  await installSilentAgent(started);
  await started.registerProject("widgets", "acme/widgets");
  return started;
}

interface Setup {
  readonly daemon: CoreDaemon;
  readonly fixture: PluginFixture;
}

/** A daemon with project widgets and a configuration whose `[manager]` runs the silent agent. */
async function setUpManager(overrides: Readonly<Record<string, string | number>> = {}): Promise<Setup> {
  const core = await startDaemon();
  const workdir = join(core.root, "manager");
  await mkdir(workdir, { mode: 0o700 });
  const extraGlobal = `\n[manager]\nprofile = ${JSON.stringify(SILENT_PROFILE)}\nworkdir = ${JSON.stringify(workdir)}\n`;
  const fixture = await writePluginConfig(core, [{ label: "widgets", repo: "acme/widgets" }], { extraGlobal, overrides });
  return { daemon: core, fixture };
}

/** A daemon with the GitHub-issue project widgets, whose started issue `ISSUE` `implement` launches with the silent agent. */
async function setUpDo(overrides: Readonly<Record<string, string | number>> = {}): Promise<Setup> {
  const core = await startDaemon();
  const provider = await startGithubProvider(join(core.root, "github"), ISSUE);
  github = provider;
  const fixture = await writePluginConfig(core, [{ label: "widgets", repo: ISSUE.repo, template: GITHUB_ISSUE_PROJECT }], {
    overrides: { "github.endpoint": provider.endpoint, "github.gh_bin": provider.ghBin, "profiles.implement": SILENT_PROFILE, ...overrides },
  });
  return { daemon: core, fixture: { ...fixture, env: { ...fixture.env, NODE_EXTRA_CA_CERTS: provider.caFile } } };
}

function implementMetadata(provider: GithubProvider): Record<string, string> {
  return {
    "work.link.provider": "github",
    "work.link.kind": "issue",
    "work.link.id": ISSUE_KEY,
    "work.link.url": provider.issueUrl,
    "work.link.branch": ISSUE_BRANCH,
    "work.role": "implement",
    "work.rev": "started",
  };
}

interface DaemonSession {
  readonly id: string;
  readonly name?: string;
  readonly state: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

async function sessions(core: CoreDaemon): Promise<DaemonSession[]> {
  const listed = await core.pohunek(["session", "list", "--json"]);
  const envelope = JSON.parse(listed.stdout) as { ok?: DaemonSession[] };
  if (envelope.ok === undefined) throw new Error(`session list failed: ${listed.stdout}${listed.stderr}`);
  return envelope.ok;
}

/** The sessions once at least one runs; the daemon may still be creating a session the plugin stopped waiting for. */
async function waitForRunningSession(core: CoreDaemon): Promise<DaemonSession[]> {
  const deadline = Date.now() + SESSION_CREATE_TIMEOUT_MS;
  for (;;) {
    const listed = await sessions(core);
    if (listed.some((session) => session.state === "running")) return listed;
    if (Date.now() > deadline) {
      throw new Error(`no session was running within ${String(SESSION_CREATE_TIMEOUT_MS)} ms: ${JSON.stringify(listed)}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

function errOf(result: CliResult): { class: string; code: string; msg: string } {
  expect(result.code).toBe(EXIT_ERROR);
  const envelope = JSON.parse(result.out) as { err?: { class: string; code: string; msg: string } };
  if (envelope.err === undefined) throw new Error(`expected an error envelope: ${result.out}${result.err}`);
  return envelope.err;
}

/** Stops the daemon and checks that no session worker outlived it. */
async function stopAndCheckWorkers(core: CoreDaemon): Promise<void> {
  await core.stop();
  expect(await workersBelow(core.runtimeDir)).toEqual([]);
}

/** The one session the daemon holds, still running and left in place by the plugin. */
function onlyRunningSession(listed: readonly DaemonSession[]): DaemonSession {
  expect(listed).toHaveLength(1);
  const [session] = listed;
  if (session === undefined) throw new Error("no session was listed");
  expect(session.state).toBe("running");
  return session;
}

test("manager start fails with launch_unverified when the manager never starts working, and leaves it running", async () => {
  const { daemon: core, fixture } = await setUpManager();
  const result = await runPlugin(fixture, ["manager", "start", "--project", "widgets", "--yes", "--json"], PROCESS_TIMEOUT_MS);

  const err = errOf(result);
  expect(err.code).toBe("launch_unverified");
  const session = onlyRunningSession(await sessions(core));
  expect(session.metadata).toEqual(MANAGER_METADATA);
  expect(err.msg).toContain(`session ${session.id} was created but did not start working`);
  expect(err.msg).toContain(`pohunek session rm ${session.id}`);
  await stopAndCheckWorkers(core);
}, SCENARIO_TIMEOUT_MS);

test("do implement fails with launch_unverified when the session never starts working, and leaves it running", async () => {
  const { daemon: core, fixture } = await setUpDo();
  const result = await runPlugin(fixture, ["do", ROW_KEY, "implement", "--yes", "--json"], PROCESS_TIMEOUT_MS);

  const err = errOf(result);
  expect(err.code).toBe("launch_unverified");
  expect(github?.unexpectedOperations).toEqual([]);
  const session = onlyRunningSession(await sessions(core));
  if (github === null) throw new Error("the GitHub provider is not running");
  expect(session.metadata).toEqual(implementMetadata(github));
  expect(session.name).toBe(ISSUE_KEY);
  expect(err.msg).toContain(`session ${session.id} was created but did not start working`);
  expect(err.msg).toContain(`pohunek session rm ${session.id}`);
  await stopAndCheckWorkers(core);
}, SCENARIO_TIMEOUT_MS);

test("manager start fails with launch_timed_out at the CLI's deadline, and the daemon still creates exactly one manager", async () => {
  const { daemon: core, fixture } = await setUpManager({ "actions.launch_timeout_ms": SHORT_LAUNCH_TIMEOUT_MS });
  const result = await runPlugin(fixture, ["manager", "start", "--project", "widgets", "--yes", "--json"], PROCESS_TIMEOUT_MS);

  const err = errOf(result);
  expect(err.code).toBe("launch_timed_out");
  // The CLI's own `--request-timeout-ms` answered, not the plugin's kill after the margin.
  expect(err.msg).toContain("pohunek error request_timeout");
  expect(err.msg).toContain("check `pohunek session list` before retrying");

  // The plugin has exited, so the count it left is final: one session, not retried.
  const session = onlyRunningSession(await waitForRunningSession(core));
  expect(session.metadata).toEqual(MANAGER_METADATA);
  await stopAndCheckWorkers(core);
}, SCENARIO_TIMEOUT_MS);

test("do implement fails with launch_timed_out at the CLI's deadline, and the daemon still creates exactly one session", async () => {
  const { daemon: core, fixture } = await setUpDo({ "actions.launch_timeout_ms": SHORT_LAUNCH_TIMEOUT_MS });
  const result = await runPlugin(fixture, ["do", ROW_KEY, "implement", "--yes", "--json"], PROCESS_TIMEOUT_MS);

  const err = errOf(result);
  expect(err.code).toBe("launch_timed_out");
  expect(err.msg).toContain("pohunek error request_timeout");
  expect(err.msg).toContain("check `pohunek session list` before retrying");
  expect(github?.unexpectedOperations).toEqual([]);

  const session = onlyRunningSession(await waitForRunningSession(core));
  if (github === null) throw new Error("the GitHub provider is not running");
  expect(session.metadata).toEqual(implementMetadata(github));
  await stopAndCheckWorkers(core);
}, SCENARIO_TIMEOUT_MS);
