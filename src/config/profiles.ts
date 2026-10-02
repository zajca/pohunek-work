// Agent profile lookup shared by `list --json` (shown per action) and `do`
// (launched): a project's [profiles] table replaces the global one whole.
import type { ProfilesConfig } from "../types/config.ts";

export function configuredProfile(
  action: string,
  projectProfiles: ProfilesConfig | null,
  globalProfiles: ProfilesConfig,
): string | undefined {
  return (projectProfiles ?? globalProfiles)[action];
}
