// Launcher requirement checks of `pohunek-work doctor`: rofi, swaymsg, python3,
// the terminal, the installed scripts, the sway include and, for a GitHub issue
// project, the `pohunek_work_bin` the GitHub issue picker runs. The launcher is
// optional, so every finding is advisory (`warn`) and never changes the exit
// code. On macOS only the terminal is checked: rofi and sway are Linux
// capabilities.
import { access, constants, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SCRIPT_ASSETS } from "./setup/assets.ts";
import { swayDropinPath } from "./setup/install.ts";
import { resolveSetupPaths, SetupPathError, type SetupPaths } from "./setup/paths.ts";
import { configIncludesDropin, readSwayConfig } from "./setup/sway-include.ts";
import { SCRIPT_LIBRARY, SWAY_DROPIN_DIR } from "./setup/settings.ts";

export interface LauncherCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface LauncherProbe {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

/** Stock macOS terminal application. */
const MACOS_TERMINAL_APP = "/System/Applications/Utilities/Terminal.app";

function ok(name: string, message: string): LauncherCheck {
  return { name, ok: true, message };
}

function warn(name: string, message: string): LauncherCheck {
  return { name, ok: false, message };
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `program` like a shell would: a name with a path separator must be an
 * absolute path, a bare name is searched in the absolute entries of `pathVar`.
 * Relative and empty entries are skipped.
 */
export async function resolveExecutable(program: string, pathVar: string | undefined): Promise<string | null> {
  if (program.includes("/")) {
    return program.startsWith("/") && (await isExecutableFile(program)) ? program : null;
  }
  if (pathVar === undefined) return null;
  for (const dir of pathVar.split(":")) {
    if (!dir.startsWith("/")) continue;
    const candidate = join(dir, program);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

async function binary(name: string, pathVar: string | undefined): Promise<LauncherCheck> {
  const found = await resolveExecutable(name, pathVar);
  return found === null ? warn(`bin:${name}`, `'${name}' not found on PATH`) : ok(`bin:${name}`, `found at ${found}`);
}

/**
 * The value of `key` in `launcher.conf`, read like the launcher's `pohunek_config_get`:
 * blank and `#` lines are skipped, the last assignment wins, and a non-comment line without
 * `=` makes the lookup fail, which reads as unset. An empty value means unset.
 */
export function parseLauncherValue(contents: string, key: string): string | null {
  let value: string | null = null;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) return null;
    if (line.slice(0, separator).trim() === key) value = line.slice(separator + 1).trim();
  }
  return value === null || value === "" ? null : value;
}

/** The `terminal=` value of `launcher.conf`. */
export function parseLauncherTerminal(contents: string): string | null {
  return parseLauncherValue(contents, "terminal");
}

async function configuredValue(paths: SetupPaths | null, key: string): Promise<string | null> {
  if (paths === null) return null;
  try {
    return parseLauncherValue(await readFile(join(paths.configDir, "launcher.conf"), "utf8"), key);
  } catch {
    return null;
  }
}

async function configuredTerminal(paths: SetupPaths | null): Promise<string | null> {
  return configuredValue(paths, "terminal");
}

/**
 * The GitHub issue picker runs the whole `pohunek_work_bin=` value as one program name
 * (`pohunek-work list`, `pohunek-work do`), so it is resolved as one executable.
 */
async function pohunekWorkBin(probe: LauncherProbe, paths: SetupPaths | null): Promise<LauncherCheck> {
  const name = "pohunek_work_bin";
  const command = await configuredValue(paths, "pohunek_work_bin");
  if (command === null) {
    return warn(name, "set 'pohunek_work_bin=' in launcher.conf (the GitHub issue picker runs pohunek-work for a project with issue_source = \"github\")");
  }
  const resolved = await resolveExecutable(command, probe.env["PATH"]);
  if (resolved === null) {
    return warn(name, `'${command}' (launcher.conf) does not resolve to one executable; the picker runs the whole value as a single program name`);
  }
  return ok(name, `'${command}' resolves to ${resolved}`);
}

/**
 * The launcher runs the whole terminal value as one program name (`"$terminal_bin" -e ...`),
 * so it is resolved as one executable and never split into words: a value such as `kitty -e`
 * does not resolve.
 */
async function resolvedTerminal(probe: LauncherProbe, command: string, source: string): Promise<LauncherCheck> {
  const resolved = await resolveExecutable(command, probe.env["PATH"]);
  if (resolved !== null) return ok("terminal", `${source} '${command}' resolves to ${resolved}`);
  return warn(
    "terminal",
    `${source} '${command}' does not resolve to one executable; the launcher runs the whole value as a single program name, so put arguments in a wrapper script, or fix the value`,
  );
}

/** `terminal=` of launcher.conf wins over `$TERMINAL`, like in the launcher. */
async function linuxTerminal(probe: LauncherProbe, paths: SetupPaths | null): Promise<LauncherCheck> {
  const configured = await configuredTerminal(paths);
  if (configured !== null) return resolvedTerminal(probe, configured, "terminal= (launcher.conf)");
  const fromEnv = probe.env["TERMINAL"];
  if (fromEnv !== undefined && fromEnv !== "") return resolvedTerminal(probe, fromEnv, "TERMINAL");
  return warn("terminal", "set $TERMINAL or 'terminal=' in launcher.conf (the rofi launcher needs a terminal)");
}

/**
 * The launcher runs the whole `terminal=` value as one program name, so it is resolved
 * as one executable and never split into words.
 */
async function macosTerminal(probe: LauncherProbe, paths: SetupPaths | null): Promise<LauncherCheck> {
  const name = "terminal";
  const appPresent = await stat(MACOS_TERMINAL_APP).then(
    (info) => info.isDirectory(),
    () => false,
  );
  const command = await configuredTerminal(paths);
  const resolved = command === null ? null : await resolveExecutable(command, probe.env["PATH"]);
  if (command !== null && resolved === null) {
    return warn(
      name,
      `configured terminal '${command}' (launcher.conf) does not resolve to one executable; the launcher runs the whole value as a single program name, so put arguments in a wrapper script, or fix or remove the 'terminal=' key`,
    );
  }
  if (command !== null) {
    return ok(name, appPresent ? `configured terminal '${command}' resolves; stock ${MACOS_TERMINAL_APP} is also available` : `configured terminal '${command}' resolves`);
  }
  if (appPresent) return ok(name, `stock terminal available at ${MACOS_TERMINAL_APP}; 'terminal=' in launcher.conf is optional`);
  return warn(name, `${MACOS_TERMINAL_APP} not found and no 'terminal=' set in launcher.conf; set 'terminal=' to a terminal command`);
}

async function accessible(path: string, mode: number): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** Every entrypoint must be executable and the library they source must be readable. */
async function launcherScripts(paths: SetupPaths): Promise<LauncherCheck> {
  const problems: string[] = [];
  let present = 0;
  for (const { name } of SCRIPT_ASSETS) {
    const path = join(paths.launcherBinDir, name);
    const library = name === SCRIPT_LIBRARY;
    if (await accessible(path, library ? constants.R_OK : constants.X_OK)) {
      present += 1;
    } else if (await stat(path).then(() => true, () => false)) {
      problems.push(`${name} is not ${library ? "readable" : "executable"}`);
    } else {
      problems.push(`${name} is missing`);
    }
  }
  if (problems.length === 0) return ok("launcher_scripts", `installed at ${paths.launcherBinDir}`);
  if (present === 0 && problems.every((problem) => problem.endsWith("is missing"))) {
    return warn("launcher_scripts", "not installed; run 'pohunek-work setup scripts'");
  }
  return warn("launcher_scripts", `incomplete install at ${paths.launcherBinDir}: ${problems.join(", ")}; run 'pohunek-work setup scripts --force'`);
}

async function swayInclude(probe: LauncherProbe, paths: SetupPaths): Promise<LauncherCheck> {
  const contents = await readSwayConfig(paths.swayConfigDir);
  if (contents === null) return warn("sway_include", `sway config not found at ${join(paths.swayConfigDir, "config")}`);
  const context = { dropinPath: swayDropinPath(paths), configDir: paths.swayConfigDir, env: probe.env };
  if (configIncludesDropin(contents, context)) return ok("sway_include", `sway config includes ${SWAY_DROPIN_DIR}`);
  return warn(
    "sway_include",
    `add 'include ${paths.swayConfigDir}/${SWAY_DROPIN_DIR}/*' to your sway config (see 'pohunek-work setup sway')`,
  );
}

/**
 * Runs the launcher checks for the probed platform and environment.
 * `githubIssuePicker` adds the `pohunek_work_bin` check when a configured project uses GitHub issues.
 */
export async function runLauncherChecks(probe: LauncherProbe, githubIssuePicker = false): Promise<LauncherCheck[]> {
  let paths: SetupPaths | null = null;
  let pathsFailure: LauncherCheck | null = null;
  try {
    paths = resolveSetupPaths(probe.env);
  } catch (error) {
    if (!(error instanceof SetupPathError)) throw error;
    pathsFailure = warn("launcher_paths", `cannot locate the launcher directories: ${error.message}`);
  }
  if (probe.platform === "darwin") {
    return [...(pathsFailure === null ? [] : [pathsFailure]), await macosTerminal(probe, paths)];
  }
  const pathVar = probe.env["PATH"];
  const checks: LauncherCheck[] = [
    await binary("rofi", pathVar),
    await binary("swaymsg", pathVar),
    await binary("python3", pathVar),
    await linuxTerminal(probe, paths),
  ];
  if (githubIssuePicker) checks.push(await pohunekWorkBin(probe, paths));
  if (paths === null) {
    if (pathsFailure !== null) checks.push(pathsFailure);
    return checks;
  }
  checks.push(await launcherScripts(paths), await swayInclude(probe, paths));
  return checks;
}
