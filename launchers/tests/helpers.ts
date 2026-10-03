// Shared harness for the launcher script tests. Each test runs a script from
// launchers/ in a sandbox directory with stub binaries on a private PATH.
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shell the scripts run under, for example `dash`, `bash --posix` or `sh`. */
export const SHELL_ENV = "POHUNEK_TEST_SHELL";
/** The pohunek CLI that renders prompts and link metadata for the launchers. */
export const POHUNEK_BIN_ENV = "POHUNEK_TEST_BIN";

/** Upper bound of one script run. */
const SCRIPT_TIMEOUT_MS = 60_000;
/** Deadline for output a script's background children write after it returned. */
const SETTLE_DEADLINE_MS = 5_000;
const SETTLE_POLL_MS = 25;

export const LAUNCHERS_DIR = new URL("../", import.meta.url).pathname;

export function scriptPath(name: string): string {
  return join(LAUNCHERS_DIR, name);
}

/** The shell under test; a missing value is a failure, not a default. */
export function shellArgv(): string[] {
  const value = process.env[SHELL_ENV];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${SHELL_ENV} is not set: name the shell under test, for example ${SHELL_ENV}=dash`);
  }
  return value.trim().split(/\s+/);
}

/** The pohunek binary under test; a missing value is a failure, not a skip. */
export function pohunekBin(): string {
  const value = process.env[POHUNEK_BIN_ENV];
  if (value === undefined || value === "") {
    throw new Error(`${POHUNEK_BIN_ENV} is not set: point it at a pohunek binary that provides \`prompt render\` and \`prompt link\``);
  }
  return value;
}

export interface Sandbox {
  readonly root: string;
  readonly bin: string;
}

export async function sandbox(tag: string): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), `pohunek-script-${tag}-`));
  const bin = join(root, "bin");
  await mkdir(bin);
  return { root, bin };
}

export async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

/** Writes `<root>/config/pohunek/launcher.conf` and returns its directory. */
export async function writeConfig(root: string, lines: readonly (readonly [string, string])[]): Promise<string> {
  const configDir = join(root, "config", "pohunek");
  await mkdir(join(configDir, "prompts"), { recursive: true });
  await writeFile(join(configDir, "launcher.conf"), lines.map(([key, value]) => `${key}=${value}\n`).join(""));
  return configDir;
}

export async function read(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a launcher script under the shell under test. The child environment is built
 * explicitly: nothing from the caller's `POHUNEK_*` variables or credentials leaks in.
 */
export async function runScript(
  script: string,
  args: readonly string[],
  box: Sandbox,
  configDir: string,
  env: Readonly<Record<string, string>> = {},
): Promise<RunResult> {
  const child = Bun.spawn([...shellArgv(), scriptPath(script), ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: SCRIPT_TIMEOUT_MS,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: box.root,
      TMPDIR: tmpdir(),
      POHUNEK_CONFIG_DIR: configDir,
      ...env,
    },
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { status: child.exitCode, stdout, stderr };
}

/**
 * Polls `path` until it contains every needle. The switcher spawns terminals in the
 * background, so a stub terminal may finish writing slightly after the script returned.
 */
export async function waitForFileContains(path: string, needles: readonly string[], label: string): Promise<void> {
  const deadline = Date.now() + SETTLE_DEADLINE_MS;
  for (;;) {
    const content = await read(path);
    if (needles.every((needle) => content.includes(needle))) return;
    if (Date.now() >= deadline) {
      throw new Error(`${label}: timed out waiting for ${JSON.stringify(needles)} in:\n${content}`);
    }
    await Bun.sleep(SETTLE_POLL_MS);
  }
}

export function assertMetaArgs(args: string, expected: readonly (readonly [string, string])[]): void {
  for (const [key, value] of expected) {
    const needle = `--meta\n${key}=${value}\n`;
    if (!args.includes(needle)) throw new Error(`missing metadata arg ${key}=${value} in:\n${args}`);
  }
}

/** Stub `pohunek`: logs argv, delegates `prompt` to the real binary, answers `project action` with a recipe. */
export const POHUNEK_STUB = `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_POHUNEK_ARGS"; done
if [ "\${1:-}" = "prompt" ]; then
  exec "$POHUNEK_TEST_REAL_POHUNEK" "$@"
fi
case " $* " in
  *" project action "*)
    if [ -n "\${POHUNEK_TEST_RECIPE_FAIL:-}" ]; then
      printf 'pohunek: prompt_not_found\\n' >&2
      exit 1
    fi
    printf '%s' "$POHUNEK_TEST_RECIPE_JSON"
    ;;
esac
`;
