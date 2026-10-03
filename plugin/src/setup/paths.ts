// Install locations of the launcher integration, derived with the XDG rules of
// the pohunek core (`pohunek-paths`): an XDG variable that is set must be a
// valid absolute path, an unset one falls back to the documented `$HOME`
// location, and nothing is guessed when `HOME` is missing too.
import { join } from "node:path";

export const XDG_DATA_HOME = "XDG_DATA_HOME";
export const XDG_CONFIG_HOME = "XDG_CONFIG_HOME";
export const HOME = "HOME";

/** Application directory under the XDG base directories. */
const APP_DIR = "pohunek";
/** Launcher script directory under the application data directory. */
const BIN_SUBDIR = "bin";
/** Sway config directory under the XDG config home. */
const SWAY_CONFIG_DIR = "sway";
const HOME_DATA_RELATIVE: readonly string[] = [".local", "share"];
const HOME_CONFIG_RELATIVE: readonly string[] = [".config"];

export interface SetupPaths {
  /** XDG config base directory. */
  readonly configHome: string;
  /** pohunek config directory holding `launcher.conf` and `prompts/`. */
  readonly configDir: string;
  /** pohunek data directory. */
  readonly dataDir: string;
  /** Directory the launcher scripts are installed into. */
  readonly launcherBinDir: string;
  /** User sway config directory. */
  readonly swayConfigDir: string;
}

/** An environment value that cannot name an install location. */
export class SetupPathError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SetupPathError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function validateEnvPath(key: string, value: string): string {
  const reason = invalidReason(value);
  if (reason !== null) {
    throw new SetupPathError(`${key} is not usable: ${reason}`);
  }
  return value;
}

function invalidReason(value: string): string | null {
  if (value === "") return "it is empty";
  if (value.includes("\0")) return "it contains a NUL byte";
  if (!value.startsWith("/")) return "it is not an absolute path";
  if (value.split("/").includes("..")) return "it contains a `..` component";
  return null;
}

function resolveXdgOrHome(env: Env, key: string, homeRelative: readonly string[]): string {
  const explicit = env[key];
  if (explicit !== undefined) return validateEnvPath(key, explicit);
  const home = env[HOME];
  if (home === undefined) throw new SetupPathError(`missing ${key} or ${HOME}`);
  return join(validateEnvPath(HOME, home), ...homeRelative);
}

/** Resolves every install location from `env`; throws `SetupPathError` when it cannot. */
export function resolveSetupPaths(env: Env = process.env): SetupPaths {
  const dataDir = join(resolveXdgOrHome(env, XDG_DATA_HOME, HOME_DATA_RELATIVE), APP_DIR);
  const configHome = resolveXdgOrHome(env, XDG_CONFIG_HOME, HOME_CONFIG_RELATIVE);
  return {
    configHome,
    configDir: join(configHome, APP_DIR),
    dataDir,
    launcherBinDir: join(dataDir, BIN_SUBDIR),
    swayConfigDir: join(configHome, SWAY_CONFIG_DIR),
  };
}
