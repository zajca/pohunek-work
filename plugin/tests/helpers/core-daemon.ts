// A real, isolated `pohunekd` from the pinned core release (plugin/core-release.json)
// for behavioral scenarios, plus a plugin configuration and runner pointed at it.
// Every directory the daemon, the pohunek CLI and the plugin use lives under one
// private root, except XDG_RUNTIME_DIR, which holds the length-limited sockets and
// lives in a short private directory below /tmp; `stop()` removes both. Child
// environments are built from scratch, so no host `POHUNEK_*` variable and no host
// daemon can leak into a scenario.
import { closeSync, openSync } from "node:fs";
import { access, chmod, constants, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDaemonSocket } from "@pohunek/sdk";
import { CORE_BINARIES, CORE_DIR_ENV } from "../../scripts/core-binaries.ts";
import { exec, type ExecResult } from "../../src/util/exec.ts";

const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;
const FIXTURE_CONFIG = new URL("../fixtures/config/", import.meta.url).pathname;
/** Template of every generated project file; its label and repository are replaced. */
const PROJECT_TEMPLATE = "widgets";
const DAEMON_READY_TIMEOUT_MS = 15_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;
/** Time `stop()` allows for removing the daemon's directories after the process ended. */
const DIR_REMOVAL_MARGIN_MS = 5_000;
/** Upper bound of `CoreDaemon.stop()`; a test hook that stops a daemon needs at least this as its timeout. */
export const DAEMON_STOP_HOOK_TIMEOUT_MS = DAEMON_STOP_TIMEOUT_MS + DIR_REMOVAL_MARGIN_MS;
const POLL_INTERVAL_MS = 50;
const CLI_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 10_000;
/** Size of `sockaddr_un.sun_path`, which also holds the terminating NUL. */
const SUN_PATH_SIZE: Readonly<Partial<Record<NodeJS.Platform, number>>> = { linux: 108, darwin: 104 };
/** Characters of a session id after its `s-` prefix (a ULID). */
const SESSION_ULID_LENGTH = 26;
/** A session id of the longest form, for the worst-case socket path. */
const LONGEST_SESSION_ID = `s-${"0".repeat(SESSION_ULID_LENGTH)}`;
/**
 * Base of XDG_RUNTIME_DIR: the shortest temporary directory Linux and macOS both
 * provide, because TMPDIR (on macOS `/var/folders/...`) leaves no room for a worker socket.
 */
const SOCKET_BASE = "/tmp";
const PRIVATE_DIRS = ["data", "state", "cache", "config", "home", "bin", "tmp", "repos"] as const;

export interface CliResult {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

export interface CoreDaemon {
  /** Private root of every directory of this daemon and its clients except the runtime directory. */
  readonly root: string;
  /** XDG_RUNTIME_DIR of the daemon and its clients: the daemon socket and the worker sockets live below it. */
  readonly runtimeDir: string;
  /** Directory holding `pohunekd`, `pohunek-sessiond` and `pohunek`. */
  readonly coreDir: string;
  /** Path of the longest socket the daemon may bind (a session worker's), checked against the platform limit. */
  readonly longestSocketPath: string;
  /** Where the worker of session `sessionId` binds its control socket. */
  workerSocketPath(sessionId: string): string;
  /** Environment of the daemon's clients: the CLI finds the socket through `XDG_RUNTIME_DIR`. */
  readonly clientEnv: Readonly<Record<string, string>>;
  /** Runs the release's `pohunek` CLI against this daemon. */
  pohunek(args: readonly string[]): Promise<ExecResult>;
  /** Creates a git repository named `label` with origin `git@github.com:<repo>.git` and registers it. */
  registerProject(label: string, repo: string): Promise<void>;
  /** Stops the daemon (SIGTERM, then SIGKILL after a deadline) and removes the root; safe to call twice. */
  stop(): Promise<void>;
}

/** The core binaries directory, or an error that names how to install it. */
async function requireCoreDir(): Promise<string> {
  const dir = process.env[CORE_DIR_ENV];
  const hint = `run \`eval "$(bun scripts/core-binaries.ts)"\` in plugin/ first`;
  if (dir === undefined || dir === "") throw new Error(`${CORE_DIR_ENV} is not set: the real-daemon tests need the pinned core binaries; ${hint}`);
  for (const name of CORE_BINARIES) {
    try {
      await access(join(dir, name), constants.X_OK);
    } catch (error) {
      throw new Error(`${CORE_DIR_ENV} names ${dir}, which has no executable ${name}; ${hint}`, { cause: error });
    }
  }
  return dir;
}

function requireGit(): string {
  const git = Bun.which("git");
  if (git === null) throw new Error("git is not on PATH; the fixture repositories and the daemon need it");
  return git;
}

function parseOk(stdout: string): Record<string, unknown> | null {
  try {
    const envelope = JSON.parse(stdout) as { ok?: Record<string, unknown> };
    return envelope.ok ?? null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Fails before the daemon starts when a session worker could not bind its socket below the runtime directory. */
function checkSocketPathLength(path: string): void {
  const size = SUN_PATH_SIZE[process.platform];
  if (size === undefined) throw new Error(`no unix socket path limit is known for platform ${process.platform}`);
  const length = Buffer.byteLength(path);
  if (length >= size) {
    throw new Error(
      `the runtime directory below ${SOCKET_BASE} is too long for the daemon's sockets: a session worker socket would be ${path} ` +
        `(${String(length)} bytes, the ${process.platform} limit is ${String(size - 1)})`,
    );
  }
}

/**
 * The session worker's control socket, the longest socket the daemon binds below
 * XDG_RUNTIME_DIR; core's layout as observed on the pinned release.
 */
function workerSocketPath(runtimeDir: string, sessionId: string): string {
  return join(runtimeDir, "pohunek", "workers", sessionId, "control.sock");
}

export async function startCoreDaemon(): Promise<CoreDaemon> {
  const coreDir = await requireCoreDir();
  const git = requireGit();
  // Real paths: the daemon refuses a directory with a symlink component (macOS /tmp and /var are symlinks).
  const root = await realpath(await mkdtemp(join(tmpdir(), "pw-")));
  let runtimeDir: string | null = null;
  const dir = (name: (typeof PRIVATE_DIRS)[number]): string => join(root, name);
  // The runtime directory is outside the private TMPDIR, so it is removed even when removing the root fails.
  const removeDirs = async (): Promise<void> => {
    try {
      await rm(root, { recursive: true, force: true });
    } finally {
      if (runtimeDir !== null) await rm(runtimeDir, { recursive: true, force: true });
    }
  };
  let daemon: Bun.Subprocess | null = null;
  try {
    const runtime = await realpath(await mkdtemp(join(await realpath(SOCKET_BASE), "pw-")));
    runtimeDir = runtime;
    await chmod(runtime, 0o700);
    const longestSocketPath = workerSocketPath(runtime, LONGEST_SESSION_ID);
    checkSocketPathLength(longestSocketPath);
    for (const name of PRIVATE_DIRS) await mkdir(dir(name), { mode: 0o700 });
    // `pohunek host discover` creates this directory with the umask's mode (zajca/pohunek#962), and the
    // daemon refuses a worker start while it is not private; the fixture creates it private before any client runs.
    await mkdir(join(dir("cache"), "pohunek"), { mode: 0o700 });
    await chmod(join(dir("cache"), "pohunek"), 0o700);
    // The daemon's PATH holds only this directory; it runs git for project and worktree work.
    await writeFile(join(dir("bin"), "git"), `#!/bin/sh\nexec '${git.replaceAll("'", "'\\''")}' "$@"\n`);
    await chmod(join(dir("bin"), "git"), 0o755);

    const clientEnv: Record<string, string> = {
      XDG_RUNTIME_DIR: runtime,
      XDG_DATA_HOME: dir("data"),
      XDG_STATE_HOME: dir("state"),
      XDG_CACHE_HOME: dir("cache"),
      XDG_CONFIG_HOME: dir("config"),
      HOME: dir("home"),
      TMPDIR: dir("tmp"),
      PATH: dir("bin"),
      SHELL: "/bin/sh",
      LANG: "C.UTF-8",
    };
    const logPath = join(root, "daemon.log");
    // One append descriptor for both streams keeps the daemon's lines in order; the child holds its own copy.
    const logFd = openSync(logPath, "a", 0o600);
    try {
      daemon = Bun.spawn([join(coreDir, "pohunekd")], {
        env: { ...clientEnv, POHUNEK_WORKER_LAUNCHER: "subprocess", POHUNEK_WORKER_BIN: join(coreDir, "pohunek-sessiond") },
        stdin: "ignore",
        stdout: logFd,
        stderr: logFd,
      });
    } finally {
      closeSync(logFd);
    }
    const child = daemon;
    const pohunek = (args: readonly string[]): Promise<ExecResult> =>
      exec([join(coreDir, "pohunek"), ...args], { timeoutMs: CLI_TIMEOUT_MS, env: clientEnv });

    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`pohunekd exited during start (${String(child.exitCode ?? child.signalCode)}):\n${await readFile(logPath, "utf8")}`);
      }
      const health = parseOk((await pohunek(["health", "--json"])).stdout);
      if (health?.["status"] === "ok") break;
      if (Date.now() > deadline) throw new Error(`pohunekd did not report healthy within ${String(DAEMON_READY_TIMEOUT_MS)} ms:\n${await readFile(logPath, "utf8")}`);
      await Bun.sleep(POLL_INTERVAL_MS);
    }

    const gitEnv = { ...clientEnv, GIT_CONFIG_NOSYSTEM: "1" };
    const runGit = async (args: readonly string[]): Promise<void> => {
      const result = await exec([git, ...args], { timeoutMs: GIT_TIMEOUT_MS, env: gitEnv });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${String(result.exitCode)}): ${result.stderr}`);
    };

    let stopped = false;
    return {
      root,
      runtimeDir: runtime,
      coreDir,
      longestSocketPath,
      workerSocketPath: (sessionId) => workerSocketPath(runtime, sessionId),
      clientEnv,
      pohunek,
      async registerProject(label, repo) {
        const repoDir = join(dir("repos"), label);
        await runGit(["init", "-q", "-b", "main", repoDir]);
        await runGit(["-C", repoDir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
        await runGit(["-C", repoDir, "remote", "add", "origin", `git@github.com:${repo}.git`]);
        const added = await pohunek(["project", "add", repoDir, "--json"]);
        if (parseOk(added.stdout)?.["label"] !== label) throw new Error(`pohunek project add ${repoDir} failed: ${added.stdout}${added.stderr}`);
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await stopProcess(child);
        } finally {
          await removeDirs();
        }
      },
    };
  } catch (error) {
    try {
      if (daemon !== null) await stopProcess(daemon);
    } finally {
      await removeDirs();
    }
    throw error;
  }
}

/** SIGTERM, then SIGKILL when the process outlives the deadline; the latter fails the scenario. */
async function stopProcess(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    child.exited.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(true);
      }, DAEMON_STOP_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (timedOut) {
    child.kill("SIGKILL");
    await child.exited;
    throw new Error(`pohunekd did not stop within ${String(DAEMON_STOP_TIMEOUT_MS)} ms of SIGTERM`);
  }
}

export interface PluginProject {
  readonly label: string;
  /** GitHub `owner/name` the project file names. */
  readonly repo: string;
  /** Text of the project file in place of the Linear template; its `pohunek_label` and `repo` lines are replaced the same way. */
  readonly template?: string;
}

/** Options of `writePluginConfig`. */
export interface PluginConfigOptions {
  /** Directory name of this configuration below the root, so one daemon can serve several configurations. */
  readonly name?: string;
  /** TOML appended to the global file, for optional tables such as `[manager]`. */
  readonly extraGlobal?: string;
  /**
   * Values of existing global keys, by `<table>.<key>` (for example `actions.launch_timeout_ms`); a number is
   * written as a TOML integer, a string as a TOML string. Applied after the paths this function sets.
   */
  readonly overrides?: Readonly<Record<string, string | number>>;
}

export interface PluginFixture {
  readonly configDir: string;
  readonly stateDir: string;
  /** Environment of a plugin process: the daemon's client environment plus the plugin directories. */
  readonly env: Readonly<Record<string, string>>;
}

/** Replaces the value of the one line `key = ...`; fails when the fixture does not have exactly one. */
function setValue(text: string, key: string, value: string): string {
  const line = new RegExp(`^${key} = .*$`, "gm");
  const matches = text.match(line)?.length ?? 0;
  if (matches !== 1) throw new Error(`the fixture has ${String(matches)} lines for ${key}, expected 1`);
  return text.replace(line, `${key} = ${JSON.stringify(value)}`);
}

/** Replaces the value of the one line `key = ...` inside `[table]`; fails when that table does not have exactly one. */
function setTableValue(text: string, table: string, key: string, value: string | number): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`[${table}]`);
  if (start === -1) throw new Error(`the fixture has no table [${table}]`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("["));
  const end = next === -1 ? lines.length : next;
  const matches = lines.flatMap((line, index) => (index > start && index < end && line.startsWith(`${key} = `) ? [index] : []));
  const [only] = matches;
  if (only === undefined || matches.length !== 1) throw new Error(`the fixture has ${String(matches.length)} lines for ${table}.${key}, expected 1`);
  lines[only] = `${key} = ${typeof value === "number" ? String(value) : JSON.stringify(value)}`;
  return lines.join("\n");
}

/**
 * Writes a plugin configuration based on tests/fixtures/config: `[pohunek] bin` is
 * the release CLI, and `gh`, `secret-tool` and the notify command point at paths
 * that do not exist, so the GitHub and Linear sources fail at once without any
 * network access. One project file is written per entry of `projects`.
 */
export async function writePluginConfig(daemon: CoreDaemon, projects: readonly PluginProject[], options: PluginConfigOptions = {}): Promise<PluginFixture> {
  const name = options.name ?? "plugin";
  const configDir = join(daemon.root, `${name}-config`);
  const stateDir = join(daemon.root, `${name}-state`);
  const missing = join(daemon.root, "missing");
  await mkdir(join(configDir, "projects"), { recursive: true, mode: 0o700 });
  let global = await readFile(join(FIXTURE_CONFIG, "config.toml"), "utf8");
  global = setValue(global, "bin", join(daemon.coreDir, "pohunek"));
  global = setValue(global, "gh_bin", join(missing, "gh"));
  global = setValue(global, "secret_tool_bin", join(missing, "secret-tool"));
  global = setValue(global, "command", join(missing, "notify-send"));
  for (const [path, value] of Object.entries(options.overrides ?? {})) {
    const dot = path.indexOf(".");
    if (dot === -1) throw new Error(`override ${path} is not <table>.<key>`);
    global = setTableValue(global, path.slice(0, dot), path.slice(dot + 1), value);
  }
  await writeFile(join(configDir, "config.toml"), `${global}${options.extraGlobal ?? ""}`);
  const template = await readFile(join(FIXTURE_CONFIG, "projects", `${PROJECT_TEMPLATE}.toml`), "utf8");
  for (const project of projects) {
    const text = setValue(setValue(project.template ?? template, "pohunek_label", project.label), "repo", project.repo);
    await writeFile(join(configDir, "projects", `${project.label}.toml`), text);
  }
  const env = { ...daemon.clientEnv, POHUNEK_WORK_CONFIG_DIR: configDir, POHUNEK_WORK_STATE_DIR: stateDir };
  return { configDir, stateDir, env };
}

/**
 * Installs the host agent profile `name` of the daemon, based on agent `shell`, whose program is `script`
 * (the text of a `/bin/sh` script). The daemon reads profiles from `$XDG_CONFIG_HOME/pohunek/agents`; the
 * script lives in the daemon's `bin` directory, so it must name every other program by absolute path.
 */
export async function installAgentProfile(daemon: CoreDaemon, name: string, script: string): Promise<void> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`agent profile name ${JSON.stringify(name)} is not lowercase letters, digits and -`);
  const program = join(daemon.root, "bin", `agent-${name}`);
  await writeFile(program, script, { mode: 0o755 });
  await chmod(program, 0o755);
  const agents = join(daemon.root, "config", "pohunek", "agents");
  await mkdir(agents, { recursive: true, mode: 0o700 });
  await writeFile(join(agents, `${name}.toml`), `base = "shell"\nprogram = ${JSON.stringify(program)}\nargs = []\n`, { mode: 0o600 });
}

/**
 * The local socket of `daemon` as the plugin resolves it: the SDK route for this user and the daemon's
 * client environment, so a test passes the socket the TUI would connect to.
 */
export function daemonLocalSocket(daemon: CoreDaemon): string {
  return resolveDaemonSocket({ platform: process.platform === "darwin" ? "macos" : "linux", effectiveUid: process.getuid?.() ?? 0 }, daemon.clientEnv);
}

/** pgrep exit status when no process matched. */
const PGREP_NO_MATCH = 1;
const PGREP_TIMEOUT_MS = 10_000;

/** Pids of the session workers whose command line names a path below `dir` (a daemon's runtime directory). */
export async function workersBelow(dir: string): Promise<string[]> {
  const pattern = `pohunek-sessiond .*${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`;
  const result = await exec(["pgrep", "-f", pattern], { timeoutMs: PGREP_TIMEOUT_MS });
  if (result.exitCode === PGREP_NO_MATCH) return [];
  if (result.exitCode !== 0) throw new Error(`pgrep failed (${String(result.exitCode)}): ${result.stderr}`);
  return result.stdout.split("\n").filter((line) => line !== "");
}

/** Runs `pohunek-work <args>` to completion with the fixture's environment. */
export async function runPlugin(fixture: PluginFixture, args: readonly string[], timeoutMs: number): Promise<CliResult> {
  const result = await exec([process.execPath, MAIN, ...args], { timeoutMs, env: fixture.env });
  if (result.timedOut) throw new Error(`pohunek-work ${args.join(" ")} did not finish within ${String(timeoutMs)} ms:\n${result.stderr}`);
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
}

/** A `pohunek-work` process on a pseudo-terminal: what it shows accumulates in `output.text`. */
export interface TerminalRun {
  readonly process: Bun.Subprocess;
  readonly output: { text: string };
  /** Settles when the terminal reaches end of file, after the process's last output arrived. */
  readonly ended: Promise<void>;
  /** Types `text` into the terminal. */
  write(text: string): void;
  close(): void;
}

/**
 * Starts `pohunek-work <args>` on a pseudo-terminal of Bun's own, so the plugin sees a
 * terminal on stdin and stdout on every platform without an external `script`.
 */
export function spawnPluginInTerminal(fixture: PluginFixture, args: readonly string[]): TerminalRun {
  const output = { text: "" };
  const decoder = new TextDecoder();
  const { promise: ended, resolve: end } = Promise.withResolvers<undefined>();
  const child = Bun.spawn([process.execPath, MAIN, ...args], {
    env: { ...fixture.env },
    terminal: {
      data: (_terminal, data) => {
        output.text += decoder.decode(data, { stream: true });
      },
      exit: () => {
        end(undefined);
      },
    },
  });
  const { terminal } = child;
  if (terminal === undefined) throw new Error("Bun did not attach a terminal to the spawned process");
  return {
    process: child,
    output,
    ended,
    write: (text) => {
      terminal.write(text);
    },
    close: () => {
      terminal.close();
    },
  };
}

/** Starts a long-running `pohunek-work <args>` (such as `watch`) with the fixture's environment. */
export function spawnPlugin(fixture: PluginFixture, args: readonly string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([process.execPath, MAIN, ...args], { env: { ...fixture.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}
