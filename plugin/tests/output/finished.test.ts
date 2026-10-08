import { describe, expect, test } from "bun:test";
import { finishedCutoff, isRecentlyFinished } from "../../src/output/finished.ts";
import type { ListItem, ListSession } from "../../src/types/item.ts";
import { row } from "../tui/builders.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-06-15T12:00:00Z");
const cutoff = finishedCutoff(NOW, 6);

function listSession(overrides: Partial<ListSession>): ListSession {
  return { id: "s-1", name: "impl", role: "implement", state: "stopped", activity: null, indicator: "stopped", updated_at: "2026-06-15T10:00:00Z", ...overrides };
}

function withSessions(...sessions: ListSession[]): ListItem {
  return row("linear:A-1", { sessions });
}

describe("finishedCutoff", () => {
  test("is the given number of hours before now", () => {
    expect(finishedCutoff(NOW, 6)).toBe(NOW - 6 * HOUR);
  });
});

describe("isRecentlyFinished", () => {
  test("a stopped or done session updated inside the window qualifies", () => {
    expect(isRecentlyFinished(withSessions(listSession({})), cutoff)).toBe(true);
    expect(isRecentlyFinished(withSessions(listSession({ state: "done", indicator: "done" })), cutoff)).toBe(true);
  });

  test("the window edge is inclusive and older sessions do not qualify", () => {
    expect(isRecentlyFinished(withSessions(listSession({ updated_at: new Date(cutoff).toISOString() })), cutoff)).toBe(true);
    expect(isRecentlyFinished(withSessions(listSession({ updated_at: new Date(cutoff - 1000).toISOString() })), cutoff)).toBe(false);
  });

  test("a missing or unparsable updated_at never qualifies", () => {
    expect(isRecentlyFinished(withSessions(listSession({ updated_at: null })), cutoff)).toBe(false);
    expect(isRecentlyFinished(withSessions(listSession({ updated_at: "yesterday" })), cutoff)).toBe(false);
  });

  test("a row without sessions or with another state does not qualify", () => {
    expect(isRecentlyFinished(withSessions(), cutoff)).toBe(false);
    expect(isRecentlyFinished(withSessions(listSession({ state: "lost", indicator: "lost" })), cutoff)).toBe(false);
  });

  test("a running or input-waiting session disqualifies the row even next to a finished one", () => {
    const finished = listSession({});
    expect(isRecentlyFinished(withSessions(finished, listSession({ id: "s-2", state: "running", indicator: "running" })), cutoff)).toBe(false);
    expect(isRecentlyFinished(withSessions(finished, listSession({ id: "s-3", state: "running", indicator: "waiting_input" })), cutoff)).toBe(false);
    expect(isRecentlyFinished(withSessions(finished, listSession({ id: "s-4", state: "running", indicator: "lost" })), cutoff)).toBe(true);
  });
});
