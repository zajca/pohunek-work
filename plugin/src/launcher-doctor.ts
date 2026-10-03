// Launcher requirement checks of `pohunek-work doctor`: rofi, swaymsg, python3,
// the terminal, the installed scripts and the sway include. The launcher is
// optional, so every finding is advisory (`warn`) and never changes the exit
// code. On macOS only the terminal is checked: rofi and sway are Linux
// capabilities.
import { access, constants, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveSetupPaths, SetupPathError, type SetupPaths } from "./setup/paths.ts";
import { configIncludesDropin, readSwayConfig } from "./setup/sway-include.ts";
import { SWAY_DROPIN_DIR } from "./setup/settings.ts";

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
 * The `terminal=` value of `launcher.conf`, read like the launcher's `pohunek_config_get`:
 * blank and `#` lines are skipped, the last assignment wins, and a non-comment line without
 * `=` makes the lookup fail, which reads as unset. An empty value means unset.
 */
export function parseLauncherTerminal(contents: string): string | null {
  let value: string | null = null;
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) return null;
    if (line.slice(0, separator).trim() === "terminal") value = line.slice(separator + 1).trim();
  }
  return value === null || value === "" ? null : value;
}

async function configuredTerminal(paths: SetupPaths | null): Promise<string | null> {
  if (paths === null) return null;
  try {
    return parseLauncherTerminal(await readFile(join(paths.configDir, "launcher.conf"), "utf8"));
  } catch {
    return null;
  }
}

async function linuxTerminal(probe: LauncherProbe, paths: SetupPaths | null): Promise<LauncherCheck> {
  const configured = await configuredTerminal(paths);
  if (configured !== null) return ok("terminal", `terminal=${configured} (launcher.conf)`);
  const fromEnv = probe.env["TERMINAL"];
  if (fromEnv !== undefined && fromEnv !== "") return ok("terminal", `TERMINAL=${fromEnv}`);
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

async function launcherScripts(paths: SetupPaths): Promise<LauncherCheck> {
  const entrypoint = join(paths.launcherBinDir, "pohunek-rofi");
  const present = await stat(entrypoint).then(
    (info) => info.isFile(),
    () => false,
  );
  return present
    ? ok("launcher_scripts", `installed at ${paths.launcherBinDir}`)
    : warn("launcher_scripts", "not installed; run 'pohunek-work setup scripts'");
}

async function swayInclude(paths: SetupPaths): Promise<LauncherCheck> {
  const contents = await readSwayConfig(paths.swayConfigDir);
  if (contents === null) return warn("sway_include", `sway config not found at ${join(paths.swayConfigDir, "config")}`);
  if (configIncludesDropin(contents)) return ok("sway_include", `sway config includes ${SWAY_DROPIN_DIR}`);
  return warn(
    "sway_include",
    `add 'include ${paths.swayConfigDir}/${SWAY_DROPIN_DIR}/*' to your sway config (see 'pohunek-work setup sway')`,
  );
}

/** Runs the launcher checks for the probed platform and environment. */
export async function runLauncherChecks(probe: LauncherProbe): Promise<LauncherCheck[]> {
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
  if (paths === null) {
    if (pathsFailure !== null) checks.push(pathsFailure);
    return checks;
  }
  checks.push(await launcherScripts(paths), await swayInclude(paths));
  return checks;
}
