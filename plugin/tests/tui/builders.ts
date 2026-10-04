// Shared TUI test data: contract rows per rule, settings, and states reached
// through the reducer the way the running TUI reaches them.
import { expect } from "bun:test";
import type { ListItem, ListPayload, ListProjectStatus } from "../../src/types/item.ts";
import { decodeListEnvelope, type ListOutcome } from "../../src/tui/decode.ts";
import { initialState, start, update, type ChildRun, type Event, type Settings, type State } from "../../src/tui/model.ts";
import type { Key, Size } from "../../src/tui/terminal.ts";

export const T0 = Date.UTC(2026, 9, 2, 8, 0, 0);
export const OWN_VERSION = "0.1.0";

export const SETTINGS: Settings = {
  selfBin: "/opt/bin/pohunek-work",
  cliVersion: OWN_VERSION,
  refreshIntervalMs: 300_000,
  staleAfterMs: 900_000,
  stalePrDays: 30,
  initialView: "all",
  bellOnTransition: true,
  stderrMaxLines: 3,
  detailMinWidth: 120,
  openUrlHosts: ["github.com", "linear.app"],
};

export const NARROW: Size = { columns: 80, rows: 24 };
export const WIDE: Size = { columns: 160, rows: 30 };

const OK = { github: "ok", github_merged: "ok", linear: "ok", pohunek: "ok" } as const;

export function row(key: string, overrides: Partial<ListItem> = {}): ListItem {
  return {
    key,
    project: "connection",
    issue: null,
    pull_request: null,
    no_issue: false,
    issue_key: null,
    sessions: [],
    on_turn: { actor: "reviewer", reason: "waiting", rule: 10 },
    actions: [],
    sources: OK,
    ...overrides,
  };
}

function issue(id: string, title: string): NonNullable<ListItem["issue"]> {
  return { id, title, state: "In Progress", url: `https://linear.app/acme/issue/${id}` };
}

function pr(number: number, overrides: Partial<NonNullable<ListItem["pull_request"]>> = {}): NonNullable<ListItem["pull_request"]> {
  return {
    id: `keboola/connection#${number.toString()}`,
    url: `https://github.com/keboola/connection/pull/${number.toString()}`,
    title: `PR ${number.toString()}`,
    draft: false,
    updated_at: "2026-09-30T08:00:00Z",
    review_decision: null,
    checks: "success",
    mergeable: "MERGEABLE",
    fix_delivered: null,
    threads_answered: null,
    rerequested: null,
    ...overrides,
  };
}

const liveSession = { id: "s-01ABC", name: "DMD-101", role: "implement", state: "running", activity: "idle" } as const;

/** One row per rule of RFC 8.1 (rule 5 twice), an unknown row and a second project. */
export const RULE_ROWS: readonly ListItem[] = [
  row("linear:DMD-101", {
    issue: issue("DMD-101", "Agent asks a question"),
    sessions: [liveSession],
    on_turn: { actor: "me", reason: "answer agent", rule: 1 },
    actions: [{ name: "attach", delegable: false }],
  }),
  row("linear:DMD-102", {
    issue: issue("DMD-102", "Agent is working"),
    sessions: [{ ...liveSession, id: "s-02", activity: "working" }],
    on_turn: { actor: "agent", reason: "working", rule: 2 },
    actions: [{ name: "attach", delegable: false }],
  }),
  row("github:keboola/connection#9003", {
    pull_request: pr(9003, { title: "Review me please" }),
    no_issue: true,
    issue_key: null,
    on_turn: { actor: "me", reason: "review", rule: 3 },
    actions: [{ name: "review", delegable: false, profile: "codex-pr-review" }],
  }),
  row("linear:DMD-104", {
    issue: issue("DMD-104", "Changes were requested"),
    pull_request: pr(9004, { review_decision: "CHANGES_REQUESTED", fix_delivered: true, threads_answered: false, rerequested: false }),
    on_turn: { actor: "me", reason: "respond", rule: 4 },
    actions: [{ name: "babysit", delegable: false, profile: "claude-otel" }],
  }),
  row("linear:DMD-105", {
    issue: issue("DMD-105", "Red CI"),
    pull_request: pr(9005, { checks: "failure" }),
    on_turn: { actor: "me", reason: "fix CI", rule: 5 },
    actions: [{ name: "fix-ci", delegable: false, profile: "claude-otel" }],
  }),
  row("linear:DMD-106", {
    issue: issue("DMD-106", "Conflicting branch"),
    pull_request: pr(9006, { mergeable: "CONFLICTING" }),
    on_turn: { actor: "me", reason: "rebase", rule: 5 },
    actions: [{ name: "rebase", delegable: false, profile: "claude-otel" }],
  }),
  row("linear:DMD-107", {
    issue: issue("DMD-107", "Still a draft"),
    pull_request: pr(9007, { draft: true }),
    on_turn: { actor: "me", reason: "leave draft", rule: 6 },
    actions: [{ name: "ready", delegable: false }],
  }),
  row("linear:DMD-108", {
    issue: issue("DMD-108", "Approved and green"),
    pull_request: pr(9008, { review_decision: "APPROVED" }),
    on_turn: { actor: "me", reason: "merge", rule: 7 },
  }),
  row("linear:DMD-109", {
    issue: issue("DMD-109", "Nothing runs yet"),
    on_turn: { actor: "me", reason: "nothing runs", rule: 8 },
    actions: [{ name: "implement", delegable: false, profile: "claude-otel" }],
  }),
  row("linear:DMD-110", {
    issue: issue("DMD-110", "Nobody asked to review"),
    pull_request: pr(9010),
    on_turn: { actor: "me", reason: "request review", rule: 9 },
  }),
  row("linear:DMD-111", {
    issue: issue("DMD-111", "Waiting for reviewers"),
    pull_request: pr(9011, { review_decision: "REVIEW_REQUIRED" }),
  }),
  row("linear:DMD-112", {
    issue: issue("DMD-112", "Agent went idle"),
    sessions: [{ ...liveSession, id: "s-12" }],
    on_turn: { actor: "me", reason: "check agent", rule: 11 },
    actions: [{ name: "attach", delegable: false }],
  }),
  row("linear:OPS-7", {
    project: "ops",
    issue: issue("OPS-7", "Rate limited source"),
    on_turn: { actor: "unknown", reason: "github:rate_limited", rule: null },
    sources: { github: "rate_limited", github_merged: "ok", linear: "ok", pohunek: "ok" },
  }),
];

export const PROJECTS_OK: readonly ListProjectStatus[] = [
  { project: "connection", sources: OK },
  { project: "ops", sources: OK },
];

export const PROJECTS_PARTIAL: readonly ListProjectStatus[] = [
  { project: "connection", sources: OK },
  { project: "ops", sources: { github: "rate_limited", github_merged: "ok", linear: "ok", pohunek: "ok" } },
];

export function payload(items: readonly ListItem[], projects: readonly ListProjectStatus[] = PROJECTS_OK): ListPayload {
  return {
    items,
    orphaned_sessions: [{ id: "s-orphan", name: "old work", linkId: "DMD-1" }],
    unlinked_sessions: [{ id: "s-loose", name: null, project: "connection", state: "running", activity: "idle" }],
    projects,
  };
}

export function envelopeText(body: ListPayload, cliVersion = OWN_VERSION, protocol = { minimum: 3, maximum: 3 }): string {
  return JSON.stringify({ cli_version: cliVersion, protocol, ok: body });
}

export function okOutcome(body: ListPayload, cliVersion = OWN_VERSION): ListOutcome {
  const outcome = decodeListEnvelope(envelopeText(body, cliVersion));
  expect(outcome.kind).toBe("ok");
  return outcome;
}

export const NO_STDERR: ChildRun = { exitCode: 0, timedOut: false, spawnError: null, stderr: [] };

export function listDone(outcome: ListOutcome | null, now: number, run: Partial<ChildRun> = {}): Event {
  return { kind: "listDone", run: { ...NO_STDERR, ...run }, outcome, now };
}

/** Initial state, first refresh started and answered with `outcome`. */
export function loaded(
  outcome: ListOutcome,
  options: { size?: Size; settings?: Partial<Settings>; now?: number; stderr?: readonly string[] } = {},
): State {
  const state = initialState({ ...SETTINGS, ...options.settings }, options.size ?? NARROW, T0);
  const [started] = start(state);
  const [next] = update(started, listDone(outcome, options.now ?? T0, { stderr: options.stderr ?? [] }));
  return next;
}

export function key(spec: string): Key {
  const named: Readonly<Record<string, Key>> = {
    "<enter>": { kind: "enter" },
    "<esc>": { kind: "escape" },
    "<tab>": { kind: "tab" },
    "<down>": { kind: "down" },
    "<up>": { kind: "up" },
    "<pgdn>": { kind: "pageDown" },
    "<pgup>": { kind: "pageUp" },
    "<bs>": { kind: "backspace" },
    "<c-c>": { kind: "ctrlC" },
  };
  return named[spec] ?? { kind: "char", char: spec };
}

/** Presses keys in order; returns the final state and every effect produced. */
export function press(state: State, keys: readonly string[], now = state.now): { state: State; effects: unknown[] } {
  let current = state;
  const effects: unknown[] = [];
  for (const spec of keys) {
    const [next, produced] = update(current, { kind: "key", key: key(spec), now });
    current = next;
    effects.push(...produced);
  }
  return { state: current, effects };
}
