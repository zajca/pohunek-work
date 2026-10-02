// TUI state and the pure reducer: update(state, event) -> [state, effects].
// Every side effect (children, timers, bell, quit) is returned as data and run
// by src/commands/tui.ts, so the whole interaction is testable without a TTY.
import type { ListError, ListItem, ListPayload, TurnActor } from "../types/item.ts";
import { listArgv, type Argv } from "./actions.ts";
import type { ListOutcome } from "./decode.ts";
import { columnsFor, computeLayout, headerFlags, overlayHeight, type Layout } from "./layout.ts";
import { ACTOR_FILTERS, filterRows, projectLabels, rowId, transitionsToMe, type ActorFilter, type Filters } from "./rows.ts";
import type { Key, Size } from "./terminal.ts";

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;

export interface Settings {
  readonly selfBin: string;
  /** Version of this build; a different `cli_version` from `self_bin` is a header warning. */
  readonly cliVersion: string;
  readonly refreshIntervalMs: number;
  readonly staleAfterMs: number;
  readonly initialView: "mine" | "all";
  readonly bellOnTransition: boolean;
  readonly stderrMaxLines: number;
  readonly detailMinWidth: number;
  readonly openUrlHosts: readonly string[];
}

export interface Data {
  readonly payload: ListPayload;
  readonly cliVersion: string;
  readonly receivedAt: number;
}

/** Full-screen states: an `err` envelope (data kept) or an incompatible `self_bin` (data dropped). */
export type Fatal = { readonly kind: "error"; readonly err: ListError } | { readonly kind: "incompatible"; readonly message: string };

export type Overlay = "none" | "help" | "sessions" | "detail";

export interface Status {
  readonly text: string;
  readonly error: boolean;
}

export interface State {
  readonly settings: Settings;
  readonly size: Size;
  readonly now: number;
  readonly data: Data | null;
  readonly fatal: Fatal | null;
  /** Last `list` stderr lines (warnings, `source unavailable:`), at most `stderr_max_lines`. */
  readonly listStderr: readonly string[];
  readonly refreshing: boolean;
  readonly status: Status | null;
  readonly filters: Filters;
  readonly editingFilter: boolean;
  readonly selected: string | null;
  readonly top: number;
  readonly overlay: Overlay;
  /** Wide layout: scroll keys move the detail pane. */
  readonly detailFocus: boolean;
  readonly detailTop: number;
  readonly sessionsTop: number;
  /** Last known non-unknown actor per row; null until the first good data. */
  readonly baseline: ReadonlyMap<string, TurnActor> | null;
  /** Rows that became the owner's turn while the TUI ran (`*`). */
  readonly marked: ReadonlySet<string>;
}

export type Effect =
  | { readonly kind: "list"; readonly argv: Argv }
  /** Next timer refresh; replaces any pending one. */
  | { readonly kind: "schedule"; readonly delayMs: number }
  /** Redraw at this time (data age, STALE); replaces any pending one. */
  | { readonly kind: "wake"; readonly at: number }
  | { readonly kind: "bell" }
  | { readonly kind: "quit" };

export interface ChildRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The child could not be started. */
  readonly spawnError: string | null;
  readonly stderr: readonly string[];
}

export type Event =
  | { readonly kind: "key"; readonly key: Key; readonly now: number }
  | { readonly kind: "resize"; readonly size: Size }
  | { readonly kind: "tick"; readonly now: number }
  | { readonly kind: "timer"; readonly now: number }
  | { readonly kind: "listDone"; readonly run: ChildRun; readonly outcome: ListOutcome | null; readonly now: number };
export type Update = readonly [State, readonly Effect[]];

export function initialState(settings: Settings, size: Size, now: number): State {
  return {
    settings,
    size,
    now,
    data: null,
    fatal: null,
    listStderr: [],
    refreshing: false,
    status: null,
    filters: { actor: settings.initialView === "mine" ? "me" : "all", project: null, text: "" },
    editingFilter: false,
    selected: null,
    top: 0,
    overlay: "none",
    detailFocus: false,
    detailTop: 0,
    sessionsTop: 0,
    baseline: null,
    marked: new Set(),
  };
}

/** The first refresh, started together with the TUI. */
export function start(state: State): Update {
  return startRefresh(state);
}

// ------------------------------------------------------------- selectors

export function visibleRows(state: State): ListItem[] {
  return state.data === null ? [] : filterRows(state.data.payload, state.filters);
}

export function selectedRow(state: State): ListItem | null {
  if (state.selected === null) return null;
  return visibleRows(state).find((item) => rowId(item) === state.selected) ?? null;
}

export function layoutOf(state: State): Layout {
  const payload = state.data?.payload ?? { items: [], orphaned_sessions: [], unlinked_sessions: [], projects: [] };
  const flags =
    state.data === null
      ? { partial: false, versionMismatch: false, listStderr: state.listStderr.length > 0, hiddenUnknown: false }
      : headerFlags(payload, state.filters, state.settings.cliVersion, state.data.cliVersion, state.listStderr.length);
  return computeLayout(state.size, columnsFor(payload), flags, state.settings.detailMinWidth);
}

export function isStale(state: State): boolean {
  return state.data !== null && state.now - state.data.receivedAt >= state.settings.staleAfterMs;
}

// --------------------------------------------------------------- helpers

function status(text: string, error = false): Status {
  return { text, error };
}

/** Keeps the selection on the same row id; falls back to the same position, then clamps the scroll. */
function normalize(state: State, fallbackIndex: number | null = null): State {
  const rows = visibleRows(state);
  const ids = rows.map(rowId);
  let index = state.selected === null ? -1 : ids.indexOf(state.selected);
  if (index < 0 && rows.length > 0) index = Math.min(Math.max(fallbackIndex ?? 0, 0), rows.length - 1);
  const selected = index < 0 ? null : (ids[index] ?? null);
  const body = Math.max(1, layoutOf(state).bodyHeight);
  let top = state.top;
  if (index >= 0) {
    if (index < top) top = index;
    if (index >= top + body) top = index - body + 1;
  }
  top = Math.max(0, Math.min(top, Math.max(0, rows.length - body)));
  const changedRow = selected !== state.selected;
  return { ...state, selected, top, detailTop: changedRow ? 0 : state.detailTop };
}

function moveSelection(state: State, delta: number): State {
  const rows = visibleRows(state);
  if (rows.length === 0) return state;
  const current = state.selected === null ? 0 : Math.max(0, rows.findIndex((item) => rowId(item) === state.selected));
  const index = Math.max(0, Math.min(rows.length - 1, current + delta));
  return normalize({ ...state, selected: rowId(rows[index] ?? rows[0] as ListItem) });
}

function startRefresh(state: State): Update {
  if (state.refreshing) return [{ ...state, status: status("refresh already running") }, []];
  return [{ ...state, refreshing: true }, [{ kind: "list", argv: listArgv(state.settings.selfBin) }]];
}

function nextWake(state: State): Effect[] {
  if (state.data === null) return [];
  const { receivedAt } = state.data;
  const age = Math.max(0, state.now - receivedAt);
  const nextMinute = receivedAt + (Math.floor(age / MS_PER_MINUTE) + 1) * MS_PER_MINUTE;
  const staleAt = receivedAt + state.settings.staleAfterMs;
  return [{ kind: "wake", at: staleAt > state.now ? Math.min(nextMinute, staleAt) : nextMinute }];
}

function stderrTail(lines: readonly string[], max: number): string[] {
  return lines.filter((line) => line.trim() !== "").slice(-max);
}

// ------------------------------------------------------------------ keys

const READ_ONLY = "read-only view: run actions with pohunek-work do <key> <action>";

function cycle<T>(values: readonly T[], current: T): T {
  const next = (values.indexOf(current) + 1) % values.length;
  return next < values.length ? (values[next] as T) : current;
}

function setFilters(state: State, filters: Partial<Filters>): State {
  const index = visibleRows(state).findIndex((item) => rowId(item) === state.selected);
  return normalize({ ...state, filters: { ...state.filters, ...filters } }, index);
}

function isChar(key: Key, char: string): boolean {
  return key.kind === "char" && key.char === char;
}

function scrollBy(key: Key, page: number): number | null {
  if (key.kind === "down" || isChar(key, "j")) return 1;
  if (key.kind === "up" || isChar(key, "k")) return -1;
  if (key.kind === "pageDown") return page;
  if (key.kind === "pageUp") return -page;
  return null;
}

function editFilter(state: State, key: Key): Update {
  if (key.kind === "enter") return [{ ...state, editingFilter: false }, []];
  if (key.kind === "escape") return [{ ...setFilters(state, { text: "" }), editingFilter: false }, []];
  if (key.kind === "backspace") return [setFilters(state, { text: state.filters.text.slice(0, -1) }), []];
  if (key.kind === "char") return [setFilters(state, { text: state.filters.text + key.char }), []];
  return [state, []];
}

function overlayKey(state: State, key: Key): Update {
  const page = overlayHeight(state.size);
  switch (state.overlay) {
    case "help":
      return [{ ...state, overlay: "none" }, []];
    case "sessions": {
      const delta = scrollBy(key, page);
      if (delta !== null) return [{ ...state, sessionsTop: Math.max(0, state.sessionsTop + delta) }, []];
      if (key.kind === "escape" || isChar(key, "s") || isChar(key, "q")) return [{ ...state, overlay: "none" }, []];
      return [state, []];
    }
    case "detail": {
      const delta = scrollBy(key, page);
      if (delta !== null) return [{ ...state, detailTop: Math.max(0, state.detailTop + delta) }, []];
      if (key.kind === "escape" || key.kind === "tab" || isChar(key, "q")) return [{ ...state, overlay: "none" }, []];
      return [state, []];
    }
    case "none":
      return [state, []];
  }
}

function listKey(state: State, key: Key): Update {
  const layout = layoutOf(state);
  const page = Math.max(1, layout.bodyHeight);
  if (state.detailFocus) {
    const delta = scrollBy(key, page);
    if (delta !== null) return [{ ...state, detailTop: Math.max(0, state.detailTop + delta) }, []];
    if (key.kind === "tab" || key.kind === "escape") return [{ ...state, detailFocus: false }, []];
  }
  const delta = scrollBy(key, page);
  if (delta !== null) return [moveSelection(state, delta), []];
  if (key.kind === "home" || isChar(key, "g")) return [moveSelection(state, -Number.MAX_SAFE_INTEGER), []];
  if (key.kind === "end" || isChar(key, "G")) return [moveSelection(state, Number.MAX_SAFE_INTEGER), []];
  if (key.kind === "enter") return [{ ...state, status: status(READ_ONLY) }, []];
  if (key.kind === "tab") {
    if (selectedRow(state) === null) return [state, []];
    return layout.wide ? [{ ...state, detailFocus: true }, []] : [{ ...state, overlay: "detail" }, []];
  }
  if (key.kind === "escape") {
    return state.filters.text === "" ? [{ ...state, status: null }, []] : [setFilters(state, { text: "" }), []];
  }
  if (key.kind !== "char") return [state, []];
  switch (key.char) {
    case "a":
    case "p":
    case "t":
    case "o":
      return [{ ...state, status: status(READ_ONLY) }, []];
    case "r":
      return startRefresh(state);
    case "m":
      return [setFilters(state, { actor: state.filters.actor === "me" ? "all" : "me" }), []];
    case "f":
      return [setFilters(state, { actor: cycle<ActorFilter>(ACTOR_FILTERS, state.filters.actor) }), []];
    case "P": {
      const labels: (string | null)[] = [null, ...(state.data === null ? [] : projectLabels(state.data.payload))];
      return [setFilters(state, { project: cycle(labels, state.filters.project) }), []];
    }
    case "/":
      return [{ ...state, editingFilter: true }, []];
    case "s":
      return [{ ...state, overlay: "sessions", sessionsTop: 0 }, []];
    case "?":
      return [{ ...state, overlay: "help" }, []];
    case "q":
      return [state, [{ kind: "quit" }]];
    default:
      return [state, []];
  }
}

/** A status message lasts until the next key; the key's handler may set a new one. */
function onKey(pressed: State, key: Key): Update {
  const state: State = { ...pressed, status: null };
  if (key.kind === "ctrlC") return [state, [{ kind: "quit" }]];
  if (state.editingFilter) return editFilter(state, key);
  if (state.overlay !== "none") return overlayKey(state, key);
  // Loading and full-screen states: only quit, help and (for an error) retry.
  if (state.fatal !== null || state.data === null) {
    if (isChar(key, "q")) return [state, [{ kind: "quit" }]];
    if (isChar(key, "?")) return [{ ...state, overlay: "help" }, []];
    if (isChar(key, "r") && state.fatal !== null) return startRefresh(state);
    return [state, []];
  }
  return listKey(state, key);
}

// --------------------------------------------------------- child results

function listDone(state: State, run: ChildRun, outcome: ListOutcome | null, now: number): Update {
  const settings = state.settings;
  let next: State = { ...state, now, refreshing: false, listStderr: stderrTail(run.stderr, settings.stderrMaxLines) };
  const effects: Effect[] = [];
  const keptIndex = visibleRows(state).findIndex((item) => rowId(item) === state.selected);
  if (run.spawnError !== null) {
    next = { ...next, status: status(`refresh failed: ${run.spawnError}`, true) };
  } else if (run.timedOut) {
    next = { ...next, status: status("refresh timed out; showing the last good data", true) };
  } else if (outcome === null || outcome.kind === "malformed") {
    const detail = outcome === null ? "no output" : outcome.message;
    next = { ...next, status: status(`refresh failed: list output unusable (${detail}, exit ${String(run.exitCode)})`, true) };
  } else if (outcome.kind === "error") {
    next = { ...next, fatal: { kind: "error", err: outcome.err } };
  } else if (outcome.kind === "incompatible") {
    next = { ...next, fatal: { kind: "incompatible", message: outcome.message }, data: null, baseline: null, marked: new Set() };
  } else {
    const transitions = transitionsToMe(state.baseline, outcome.payload.items);
    const meNow = new Set(outcome.payload.items.filter((item) => item.on_turn.actor === "me").map(rowId));
    const marked = new Set([...state.marked, ...transitions.marked].filter((id) => meNow.has(id)));
    const clearsStatus = state.status?.error === true && state.status.text.startsWith("refresh");
    next = {
      ...next,
      data: { payload: outcome.payload, cliVersion: outcome.cliVersion, receivedAt: now },
      fatal: null,
      baseline: transitions.baseline,
      marked,
      status: clearsStatus ? null : next.status,
    };
    if (transitions.marked.size > 0 && settings.bellOnTransition) effects.push({ kind: "bell" });
  }
  next = normalize(next, keptIndex);
  return [next, [...effects, { kind: "schedule", delayMs: settings.refreshIntervalMs }, ...nextWake(next)]];
}

// ---------------------------------------------------------------- update

export function update(state: State, event: Event): Update {
  switch (event.kind) {
    case "key":
      return onKey({ ...state, now: event.now }, event.key);
    case "resize":
      return [normalize({ ...state, size: event.size }), []];
    case "tick":
      return [{ ...state, now: event.now }, nextWake({ ...state, now: event.now })];
    case "timer":
      return state.refreshing ? [state, []] : startRefresh({ ...state, now: event.now });
    case "listDone":
      return listDone(state, event.run, event.outcome, event.now);
  }
}
