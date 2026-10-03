// Whether a sway config pulls in the drop-in directory. Shared by `setup sway`
// and `doctor` so both reach the same verdict.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SWAY_DROPIN_DIR } from "./settings.ts";

/** True when some non-comment line mentions the drop-in directory. */
export function configIncludesDropin(contents: string): boolean {
  return contents.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith("#") && trimmed.includes(SWAY_DROPIN_DIR);
  });
}

/** Reads `<swayConfigDir>/config`; null when it does not exist or cannot be read. */
export async function readSwayConfig(swayConfigDir: string): Promise<string | null> {
  try {
    return await readFile(join(swayConfigDir, "config"), "utf8");
  } catch {
    return null;
  }
}
