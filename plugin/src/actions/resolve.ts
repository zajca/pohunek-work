// Resolves one row by key from a fresh pipeline run; never from stale data.
import { collectRows, type CollectedRow, type ListDeps } from "../commands/list.ts";
import { isSourceFailure, type SourceStatus } from "../types/item.ts";
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
  includeIgnored: boolean,
  deps: Omit<ListDeps, "cliVersion">,
): Promise<Resolved> {
  const key = normalizeKey(input);
  const collected = await collectRows(config, onlyProject === null ? null : [onlyProject], deps);
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
  // A mutating action may only rest on data read in this run. Stale data (a failed refresh) is displayed by `list`,
  // but a rule that finds an issue in it would decide on a state nobody checked, so every source of the row's
  // project has to be fresh here.
  const unavailable = Object.entries(row.listItem.sources).filter((entry): entry is [string, SourceStatus] => isSourceFailure(entry[1]));
  if (unavailable.length > 0) {
    const names = unavailable.map(([name, status]) => `${name} (${status})`).join(", ");
    throw new ActionError(
      "source_unavailable",
      `${key} refused: source ${names} is stale or unavailable in this run; an action needs every source it reads fresh`,
    );
  }
  // An ignored row is parked on purpose: acting on it needs an explicit opt-in, for every action.
  if (row.listItem.ignored && !includeIgnored) {
    throw new ActionError(
      "precondition_failed",
      `${key} carries the ignore label and is parked: pass --include-ignored to act on it, or remove the label`,
    );
  }
  return { row, warnings: collected.warnings, sessions: collected.sessions };
}
