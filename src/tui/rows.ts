// Pure selectors over the decoded `list` payload: row identity, order and the
// client-side filters (the TUI always fetches every row and filters itself).
import type { ListItem, ListPayload, TurnActor } from "../types/item.ts";
import { toSafe } from "./safe.ts";

export type ActorFilter = "all" | TurnActor;

export const ACTOR_FILTERS: readonly ActorFilter[] = ["all", "me", "agent", "reviewer", "unknown"];

/** Row order of section 4.6: the owner's turn first, then rows that may be. */
const ACTOR_ORDER: readonly TurnActor[] = ["me", "unknown", "agent", "reviewer"];

export interface Filters {
  readonly actor: ActorFilter;
  readonly project: string | null;
  /** Case-insensitive substring of the key or the title; empty matches every row. */
  readonly text: string;
}

/** A key is unique per project only, so the project is part of the identity. */
export function rowId(item: ListItem): string {
  return `${item.project} ${item.key}`;
}

export function rowTitle(item: ListItem): string {
  return item.issue?.title ?? item.pull_request?.title ?? "";
}

export function sortRows(items: readonly ListItem[]): ListItem[] {
  return [...items].sort(
    (a, b) =>
      ACTOR_ORDER.indexOf(a.on_turn.actor) - ACTOR_ORDER.indexOf(b.on_turn.actor) ||
      a.key.localeCompare(b.key) ||
      a.project.localeCompare(b.project),
  );
}

function matchesText(item: ListItem, text: string): boolean {
  if (text === "") return true;
  const needle = text.toLowerCase();
  // Matching runs on the sanitized text, so ASCII typed by the owner finds titles with diacritics.
  return [item.key, rowTitle(item)].some((field) => toSafe(field).toLowerCase().includes(needle));
}

function matchesBase(item: ListItem, filters: Filters): boolean {
  return (filters.project === null || item.project === filters.project) && matchesText(item, filters.text);
}

export function filterRows(payload: ListPayload, filters: Filters): ListItem[] {
  return sortRows(
    payload.items.filter(
      (item) => matchesBase(item, filters) && (filters.actor === "all" || item.on_turn.actor === filters.actor),
    ),
  );
}

/**
 * Unknown rows the actor filter hides from the `mine` view: an unknown row may
 * be the owner's turn, so their number is always shown there.
 */
export function hiddenUnknownCount(payload: ListPayload, filters: Filters): number {
  if (filters.actor !== "me") return 0;
  return payload.items.filter((item) => item.on_turn.actor === "unknown" && matchesBase(item, filters)).length;
}

/** Every project label in the payload, sorted; the `P` cycle and the PROJECT column use it. */
export function projectLabels(payload: ListPayload): string[] {
  return [...new Set([...payload.projects.map((p) => p.project), ...payload.items.map((i) => i.project)])].sort();
}

export function actorCounts(payload: ListPayload): Readonly<Record<TurnActor, number>> {
  const counts: Record<TurnActor, number> = { me: 0, agent: 0, reviewer: 0, unknown: 0 };
  for (const item of payload.items) counts[item.on_turn.actor] += 1;
  return counts;
}

/**
 * Rows that became the owner's turn since the last known state. Unknown
 * actors never update the baseline, so a source outage and its recovery do
 * not mark rows; a row that appears already on the owner's turn is marked.
 */
export function transitionsToMe(
  baseline: ReadonlyMap<string, TurnActor> | null,
  next: readonly ListItem[],
): { readonly marked: ReadonlySet<string>; readonly baseline: ReadonlyMap<string, TurnActor> } {
  const updated = new Map(baseline ?? []);
  const marked = new Set<string>();
  for (const item of next) {
    const id = rowId(item);
    const actor = item.on_turn.actor;
    if (actor === "unknown") continue;
    const before = updated.get(id);
    if (baseline !== null && actor === "me" && before !== "me") marked.add(id);
    updated.set(id, actor);
  }
  return { marked, baseline: updated };
}
