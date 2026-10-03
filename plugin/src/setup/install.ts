// Filesystem side of `pohunek-work setup`. An existing file is never replaced
// without `force`: identical content is reported as unchanged, anything else is
// skipped. With `force` a file is replaced through a temporary sibling and a
// rename, so a symbolic link at the target is replaced itself and its referent
// is never written.
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { CONFIG_ASSETS, renderSwayDropin, SCRIPT_ASSETS } from "./assets.ts";
import type { SetupPaths } from "./paths.ts";
import { configIncludesDropin, readSwayConfig } from "./sway-include.ts";
import { hasControlCharacter, isPlainKeybind, quoteForSwayExec } from "./sway-quote.ts";
import { OBSOLETE_SCRIPTS, SCRIPT_MODE, SWAY_DROPIN_DIR, SWAY_DROPIN_FILE } from "./settings.ts";

export type WriteOutcome = "created" | "overwritten" | "unchanged" | "skipped";

export interface FileResult {
  readonly path: string;
  readonly outcome: WriteOutcome;
}

export interface ScriptsResult {
  readonly dir: string;
  readonly files: readonly FileResult[];
  /** Obsolete scripts deleted (only with `force`). */
  readonly removed: readonly string[];
}

export interface ConfigResult {
  readonly dir: string;
  readonly files: readonly FileResult[];
}

export interface SwayResult {
  readonly path: string;
  /** Null when the snippet was only printed. */
  readonly outcome: WriteOutcome | null;
  readonly printed: boolean;
  readonly snippet: string;
  /** Whether the issue picker binding is part of the snippet. */
  readonly issue_binding: boolean;
  /** Whether the main sway config already includes the drop-in directory; false in print mode. */
  readonly include_present: boolean;
}

export interface InstallOptions {
  readonly force: boolean;
}

export interface SwayOptions extends InstallOptions {
  readonly print: boolean;
  readonly keybind: string;
  readonly issueKeybind: string;
  /** Project the issue picker is bound for; null leaves the issue binding out, the picker needs one. */
  readonly issueProject: string | null;
  /** Environment used to resolve variables in the sway config's include directives. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A launcher file could not be written. */
export class SetupIoError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SetupIoError";
  }
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function ioFailure(action: string, path: string, error: unknown): SetupIoError {
  const detail = error instanceof Error ? error.message : String(error);
  return new SetupIoError(`cannot ${action} ${path}: ${detail}`, { cause: error });
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw ioFailure("create directory", dir, error);
  }
}

/** Writes `body` to a new sibling of `path` and renames it over `path`. */
async function replaceFile(path: string, body: string, mode: number | undefined): Promise<void> {
  const temporary = join(dirname(path), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, body, { flag: "wx", mode: mode ?? 0o666 });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw ioFailure("write", path, error);
  }
}

async function sameAsDesired(path: string, body: string, mode: number | undefined): Promise<boolean> {
  const info = await lstat(path);
  if (!info.isFile()) return false;
  if (mode !== undefined && (info.mode & 0o777) !== mode) return false;
  return (await readFile(path, "utf8")) === body;
}

/** Installs one file; `mode`, when given, is applied exactly (the umask does not narrow it). */
export async function writeManaged(
  path: string,
  body: string,
  options: InstallOptions & { readonly mode?: number },
): Promise<WriteOutcome> {
  await ensureDir(dirname(path));
  const { mode } = options;
  if (options.force) {
    const existed = await lstat(path).then(
      () => true,
      () => false,
    );
    await replaceFile(path, body, mode);
    return existed ? "overwritten" : "created";
  }
  try {
    await writeFile(path, body, { flag: "wx", mode: mode ?? 0o666 });
    if (mode !== undefined) await chmod(path, mode);
    return "created";
  } catch (error) {
    if (errno(error) !== "EEXIST") throw ioFailure("write", path, error);
  }
  try {
    return (await sameAsDesired(path, body, mode)) ? "unchanged" : "skipped";
  } catch (error) {
    throw ioFailure("inspect", path, error);
  }
}

/** Installs the launcher scripts into the launcher bin directory. */
export async function installScripts(paths: SetupPaths, options: InstallOptions): Promise<ScriptsResult> {
  const dir = paths.launcherBinDir;
  const files: FileResult[] = [];
  for (const asset of SCRIPT_ASSETS) {
    const path = join(dir, asset.name);
    files.push({ path, outcome: await writeManaged(path, asset.body, { ...options, mode: SCRIPT_MODE }) });
  }
  const removed: string[] = [];
  if (options.force) {
    for (const name of OBSOLETE_SCRIPTS) {
      const path = join(dir, name);
      const existed = await lstat(path).then(
        () => true,
        () => false,
      );
      if (!existed) continue;
      try {
        await rm(path);
      } catch (error) {
        throw ioFailure("remove", path, error);
      }
      removed.push(path);
    }
  }
  return { dir, files, removed };
}

/** Installs `launcher.conf` and the starter prompt templates. */
export async function installConfig(paths: SetupPaths, options: InstallOptions): Promise<ConfigResult> {
  const files: FileResult[] = [];
  for (const asset of CONFIG_ASSETS) {
    const path = join(paths.configDir, asset.name);
    files.push({ path, outcome: await writeManaged(path, asset.body, options) });
  }
  return { dir: paths.configDir, files };
}

/** Path the sway drop-in is written to. */
export function swayDropinPath(paths: SetupPaths): string {
  return join(paths.swayConfigDir, SWAY_DROPIN_DIR, SWAY_DROPIN_FILE);
}

/** Builds the drop-in text; refuses values that would change what sway parses or add a line to its config. */
export function buildSwaySnippet(paths: SetupPaths, options: Pick<SwayOptions, "keybind" | "issueKeybind" | "issueProject">): string {
  const words: [string, string][] = [
    ["launcher path", join(paths.launcherBinDir, "pohunek-rofi")],
    ["issue launcher path", join(paths.launcherBinDir, "pohunek-rofi-issue")],
  ];
  if (options.issueProject !== null) words.push(["issue project", options.issueProject]);
  for (const [name, value] of words) {
    if (value === "" || hasControlCharacter(value)) {
      throw new SetupIoError(`sway drop-in value ${name} is empty or contains a control character`);
    }
  }
  const keybinds = [["keybind", options.keybind], ...(options.issueProject === null ? [] : [["issue keybind", options.issueKeybind]])];
  for (const [name, value] of keybinds) {
    if (!isPlainKeybind(value ?? "")) {
      throw new SetupIoError(`sway drop-in ${name} ${JSON.stringify(value)} is not a plain key sequence`);
    }
  }
  return renderSwayDropin({
    launcher: quoteForSwayExec(words[0]?.[1] ?? ""),
    keybind: options.keybind,
    ...(options.issueProject === null
      ? {}
      : {
          issue: {
            keybind: options.issueKeybind,
            launcher: quoteForSwayExec(words[1]?.[1] ?? ""),
            project: quoteForSwayExec(options.issueProject),
          },
        }),
  });
}

/** Prints (`print`) or writes the sway drop-in, then reports whether the main config includes the drop-in directory. */
export async function installSway(paths: SetupPaths, options: SwayOptions): Promise<SwayResult> {
  const snippet = buildSwaySnippet(paths, options);
  const path = swayDropinPath(paths);
  const issueBinding = options.issueProject !== null;
  if (options.print) {
    return { path, outcome: null, printed: true, snippet, issue_binding: issueBinding, include_present: false };
  }
  const outcome = await writeManaged(path, snippet, options);
  const config = await readSwayConfig(paths.swayConfigDir);
  const includePresent = config !== null && configIncludesDropin(config, { dropinPath: path, configDir: paths.swayConfigDir, env: options.env });
  return { path, outcome, printed: false, snippet, issue_binding: issueBinding, include_present: includePresent };
}
