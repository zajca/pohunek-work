// Resolves one row by key from a fresh pipeline run; never from stale data.
import { collectRows, type CollectedRow, type ListDeps } from "../commands/list.ts";
import type { PluginConfig } from "../types/config.ts";
import type { PohunekSession } from "../types/sources.ts";
import { ActionError } from "./types.ts";

const BARE_LINEAR_KEY = /^[A-Z][A-Z0-9]*-[0-9]+$/;

/** A bare Linear identifier means the `linear:` row of that issue. */
export function normalizeKey(input: string): string {
  return BARE_LINEAR_KEY.test(input) ? `linear:${input}` : input;
}

export interface Resolved {
  readonly row: CollectedRow;
  readonly warnings: readonly string[];
  /** Every session pohunek reported, for checks that go beyond the row. */
  readonly sessions: readonly PohunekSession[];
}

export async function resolveRow(
  config: PluginConfig,
  input: string,
  onlyProject: string | null,
  deps: Omit<ListDeps, "cliVersion">,
): Promise<Resolved> {
  const key = normalizeKey(input);
  const collected = await collectRows(config, onlyProject, deps);
  const matches = collected.rows.filter((row) => row.listItem.key === key);
  const [row] = matches;
  if (row === undefined) {
    const failures = collected.sourceFailures.length > 0 ? ` (sources: ${collected.sourceFailures.join("; ")})` : "";
    throw new ActionError("unknown_item", `no row with key ${key} in the current data${failures}`);
  }
  if (matches.length > 1) {
    const projects = matches.map((m) => m.project.pohunekLabel).join(", ");
    throw new ActionError("ambiguous_item", `key ${key} appears in several projects (${projects}); pass --project`);
  }
  return { row, warnings: collected.warnings, sessions: collected.sessions };
}
