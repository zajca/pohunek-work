// Provisional plugin directories (implementation plan D3). The environment
// overrides exist for tests and for the later injected-directory switch.
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_ENV = "POHUNEK_WORK_CONFIG_DIR";
export const STATE_DIR_ENV = "POHUNEK_WORK_STATE_DIR";

export function resolveConfigDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[CONFIG_DIR_ENV] ?? join(homedir(), ".config", "pohunek", "plugins", "work");
}

export function resolveStateDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[STATE_DIR_ENV] ?? join(homedir(), ".local", "state", "pohunek", "plugins", "work");
}

export function resolveLogDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(resolveStateDir(env), "logs");
}
