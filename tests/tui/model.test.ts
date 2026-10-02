import { describe, expect, test } from "bun:test";
import { decodeListEnvelope } from "../../src/tui/decode.ts";
import { initialState, isStale, layoutOf, selectedRow, start, update, visibleRows, type State } from "../../src/tui/model.ts";
import { rowId } from "../../src/tui/rows.ts";
import { view } from "../../src/tui/view.ts";
import { envelopeText, listDone, loaded, NARROW, okOutcome, payload, press, row, RULE_ROWS, SETTINGS, T0, WIDE } from "./builders.ts";

function keysOf(state: State): string[] {
  return visibleRows(state).map((item) => item.key);
}

describe("start and refresh", () => {
  test("the first refresh starts with the TUI and runs `self_bin list --json`", () => {
    const [state, effects] = start(initialState(SETTINGS, NARROW, T0));
    expect(state.refreshing).toBe(true);
    expect(effects).toEqual([{ kind: "list", argv: ["/opt/bin/pohunek-work", "list", "--json"] }]);
  });

  test("first load: only q, ? and Ctrl-C do anything", () => {
    const [state] = start(initialState(SETTINGS, NARROW, T0));
    for (const spec of ["j", "r", "<enter>", "m", "/", "s"]) {
      const result = press(state, [spec]);
      expect(result.effects).toEqual([]);
      expect(result.state.overlay).toBe("none");
      expect(result.state.editingFilter).toBe(false);
    }
    expect(press(state, ["q"]).effects).toEqual([{ kind: "quit" }]);
    expect(press(state, ["<c-c>"]).effects).toEqual([{ kind: "quit" }]);
    expect(press(state, ["?"]).state.overlay).toBe("help");
  });

  test("a finished refresh schedules the next one after refresh_interval_secs and a redraw for the data age", () => {
    const [started] = start(initialState(SETTINGS, NARROW, T0));
    const [, effects] = update(started, listDone(okOutcome(payload(RULE_ROWS)), T0 + 5_000));
    expect(effects).toEqual([
      { kind: "schedule", delayMs: SETTINGS.refreshIntervalMs },
      { kind: "wake", at: T0 + 5_000 + 60_000 },
    ]);
  });

  test("single flight: r while a refresh runs starts nothing and says so", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const first = press(state, ["r"]);
    expect(first.effects).toEqual([{ kind: "list", argv: ["/opt/bin/pohunek-work", "list", "--json"] }]);
    const second = press(first.state, ["r"]);
    expect(second.effects).toEqual([]);
    expect(second.state.status?.text).toBe("refresh already running");
  });

  test("the refresh timer is ignored while a refresh runs", () => {
    const [started] = start(initialState(SETTINGS, NARROW, T0));
    expect(update(started, { kind: "timer", now: T0 })[1]).toEqual([]);
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    expect(update(state, { kind: "timer", now: T0 + 1 })[1]).toEqual([{ kind: "list", argv: ["/opt/bin/pohunek-work", "list", "--json"] }]);
  });
});

describe("stale data with a fake clock", () => {
  test("STALE from stale_after_secs on; the wake lands on the stale moment", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const [before, wake] = update(state, { kind: "tick", now: T0 + SETTINGS.staleAfterMs - 30_000 });
    expect(isStale(before)).toBe(false);
    expect(wake).toEqual([{ kind: "wake", at: T0 + SETTINGS.staleAfterMs }]);
    const [after] = update(state, { kind: "tick", now: T0 + SETTINGS.staleAfterMs });
    expect(isStale(after)).toBe(true);
    expect(view(after)[0]).toContain("data 15m old STALE");
  });

  test("a failed or timed-out refresh keeps the last good data and its age", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const [timedOut] = update({ ...state, refreshing: true }, listDone(null, T0 + 60_000, { timedOut: true, exitCode: null }));
    expect(timedOut.data?.receivedAt).toBe(T0);
    expect(timedOut.status).toEqual({ text: "refresh timed out; showing the last good data", error: true });
    const [garbage] = update(state, listDone(decodeListEnvelope("not json"), T0 + 60_000, { exitCode: 2 }));
    expect(garbage.data?.receivedAt).toBe(T0);
    expect(garbage.status?.text).toBe("refresh failed: list output unusable (output is not JSON, exit 2)");
    const [recovered] = update(garbage, listDone(okOutcome(payload(RULE_ROWS)), T0 + 120_000));
    expect(recovered.status).toBeNull();
    expect(recovered.data?.receivedAt).toBe(T0 + 120_000);
  });

  test("a spawn failure is shown and the data kept", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const [next] = update(state, listDone(null, T0 + 1, { spawnError: "cannot start /opt/bin/pohunek-work", exitCode: null }));
    expect(next.status).toEqual({ text: "refresh failed: cannot start /opt/bin/pohunek-work", error: true });
    expect(next.data).not.toBeNull();
  });
});

describe("err envelope and incompatible contract", () => {
  const err = decodeListEnvelope(
    JSON.stringify({ cli_version: "0.1.0", protocol: { minimum: 1, maximum: 1 }, err: { class: "configuration", code: "config_invalid", msg: "bad" } }),
  );

  test("an err envelope goes full screen, keeps the data; r retries and success returns to the rows", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const [failed] = update(state, listDone(err, T0 + 10, { exitCode: 2 }));
    expect(failed.fatal).toEqual({ kind: "error", err: { class: "configuration", code: "config_invalid", msg: "bad" } });
    expect(failed.data).not.toBeNull();
    expect(press(failed, ["j"]).state.selected).toBe(failed.selected);
    const retry = press(failed, ["r"]);
    expect(retry.effects).toEqual([{ kind: "list", argv: ["/opt/bin/pohunek-work", "list", "--json"] }]);
    const [back] = update(retry.state, listDone(okOutcome(payload(RULE_ROWS)), T0 + 20));
    expect(back.fatal).toBeNull();
  });

  test("a protocol range without v1 drops the data and never guesses", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const outcome = decodeListEnvelope(envelopeText(payload(RULE_ROWS), "2.0.0", { minimum: 2, maximum: 2 }));
    const [next] = update(state, listDone(outcome, T0 + 10));
    expect(next.fatal?.kind).toBe("incompatible");
    expect(next.data).toBeNull();
    expect(next.baseline).toBeNull();
    expect(press(next, ["r"]).effects).toEqual([{ kind: "list", argv: ["/opt/bin/pohunek-work", "list", "--json"] }]);
  });

  test("exit 3 with stderr: rows render, stderr kept up to stderr_max_lines", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)), { stderr: ["one", "", "two", "three", "four"] });
    expect(state.listStderr).toEqual(["two", "three", "four"]);
    expect(visibleRows(state)).toHaveLength(RULE_ROWS.length);
  });
});

describe("keys and filters", () => {
  test("rows are sorted me, unknown, agent, reviewer, then key", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const actors: string[] = visibleRows(state).map((item) => item.on_turn.actor);
    expect(actors).toEqual([...Array<string>(10).fill("me"), "unknown", "agent", "reviewer"]);
    const meKeys = keysOf(state).slice(0, 10);
    expect(meKeys).toEqual([...meKeys].sort((a, b) => a.localeCompare(b)));
  });

  test("j/k, G/g, PgDn/PgUp move and clamp", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const keys = keysOf(state);
    expect(press(state, ["j", "j"]).state.selected).toBe(`connection ${keys[2] ?? ""}`);
    expect(press(state, ["k"]).state.selected).toBe(`connection ${keys[0] ?? ""}`);
    expect(press(state, ["G"]).state.selected).toBe(`connection ${keys[12] ?? ""}`);
    expect(press(state, ["G", "j"]).state.selected).toBe(`connection ${keys[12] ?? ""}`);
    expect(press(state, ["G", "g"]).state.selected).toBe(`connection ${keys[0] ?? ""}`);
    const paged = press(state, ["<pgdn>"]).state;
    expect(visibleRows(paged).findIndex((item) => rowId(item) === paged.selected)).toBe(Math.min(12, layoutOf(state).bodyHeight));
  });

  test("the scroll keeps the selection on screen in a short terminal", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)), { size: { columns: 80, rows: 8 } });
    const body = layoutOf(state).bodyHeight;
    const moved = press(state, ["G"]).state;
    expect(moved.top).toBe(RULE_ROWS.length - body);
    expect(view(moved).some((line) => line.startsWith(">"))).toBe(true);
  });

  test("m toggles mine and all; f cycles all, me, agent, reviewer, unknown", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    expect(state.filters.actor).toBe("all");
    expect(press(state, ["m"]).state.filters.actor).toBe("me");
    expect(press(state, ["m", "m"]).state.filters.actor).toBe("all");
    const cycled = ["f", "f", "f", "f", "f"].map((_, index) => press(state, Array<string>(index + 1).fill("f")).state.filters.actor);
    expect(cycled).toEqual(["me", "agent", "reviewer", "unknown", "all"]);
    expect(keysOf(press(state, ["f", "f", "f", "f"]).state)).toEqual(["linear:OPS-7"]);
  });

  test("initial_view mine starts on the owner's rows", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)), { settings: { initialView: "mine" } });
    expect(visibleRows(state).every((item) => item.on_turn.actor === "me")).toBe(true);
  });

  test("P cycles the projects and back to all", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    expect(press(state, ["P"]).state.filters.project).toBe("connection");
    expect(keysOf(press(state, ["P", "P"]).state)).toEqual(["linear:OPS-7"]);
    expect(press(state, ["P", "P", "P"]).state.filters.project).toBeNull();
  });

  test("/ filters key and title case-insensitively, also through diacritics; Esc clears", () => {
    const base = payload([...RULE_ROWS, row("linear:CZ-1", { issue: { id: "CZ-1", title: "Žluťoučký kůň", state: "x", url: "https://linear.app/x" } })]);
    const state = loaded(okOutcome(base));
    const typed = press(state, ["/", "z", "l", "u", "t"]).state;
    expect(typed.editingFilter).toBe(true);
    expect(keysOf(typed)).toEqual(["linear:CZ-1"]);
    expect(keysOf(press(state, ["/", "D", "M", "D", "-", "1", "0", "5"]).state)).toEqual(["linear:DMD-105"]);
    const kept = press(typed, ["<enter>"]).state;
    expect(kept.editingFilter).toBe(false);
    expect(kept.filters.text).toBe("zlut");
    expect(press(kept, ["<esc>"]).state.filters.text).toBe("");
    expect(press(typed, ["<bs>", "<bs>", "<bs>", "<bs>", "<esc>"]).state.filters.text).toBe("");
    // Keys typed into the filter are text, not commands.
    expect(press(state, ["/", "q"]).effects).toEqual([]);
  });

  test("selection follows the row id when a filter changes", () => {
    const state = press(loaded(okOutcome(payload(RULE_ROWS))), ["j", "j", "j"]).state;
    const chosen = state.selected;
    expect(press(state, ["m"]).state.selected).toBe(chosen);
  });

  test("Tab: detail focus when wide, full-screen detail when narrow; j/k then scroll the detail", () => {
    const narrow = press(loaded(okOutcome(payload(RULE_ROWS))), ["<tab>"]).state;
    expect(narrow.overlay).toBe("detail");
    expect(press(narrow, ["j", "j"]).state.detailTop).toBe(2);
    expect(press(narrow, ["<tab>"]).state.overlay).toBe("none");
    const wide = press(loaded(okOutcome(payload(RULE_ROWS)), { size: WIDE }), ["<tab>"]).state;
    expect(wide.detailFocus).toBe(true);
    const scrolled = press(wide, ["j"]).state;
    expect(scrolled.detailTop).toBe(1);
    expect(scrolled.selected).toBe(wide.selected);
    expect(press(wide, ["<esc>"]).state.detailFocus).toBe(false);
  });

  test("s opens the sessions view, ? the help; any key closes the help", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    expect(press(state, ["s"]).state.overlay).toBe("sessions");
    expect(press(state, ["s", "<esc>"]).state.overlay).toBe("none");
    expect(press(state, ["?", "x"]).state.overlay).toBe("none");
  });

  test("q and Ctrl-C quit", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    expect(press(state, ["q"]).effects).toEqual([{ kind: "quit" }]);
    expect(press(state, ["<c-c>"]).effects).toEqual([{ kind: "quit" }]);
  });

  test("resize recomputes the layout and keeps the selection", () => {
    const state = press(loaded(okOutcome(payload(RULE_ROWS))), ["G"]).state;
    const [resized] = update(state, { kind: "resize", size: WIDE });
    expect(resized.size).toEqual(WIDE);
    expect(resized.selected).toBe(state.selected);
    expect(layoutOf(resized).wide).toBe(true);
  });
});

describe("refresh keeps the selection and marks rows that became mine", () => {
  test("selection kept by row id across a refresh that reorders rows", () => {
    const state = press(loaded(okOutcome(payload(RULE_ROWS))), ["G"]).state;
    const chosen = selectedRow(state);
    const reordered = payload([...RULE_ROWS].reverse());
    const [next] = update(state, listDone(okOutcome(reordered), T0 + 1));
    expect(selectedRow(next)?.key).toBe(chosen?.key ?? "missing");
  });

  test("a vanished selected row falls back to the same position", () => {
    const state = press(loaded(okOutcome(payload(RULE_ROWS))), ["j", "j"]).state;
    const keys = keysOf(state);
    const removed = RULE_ROWS.filter((item) => item.key !== keys[2]);
    const [next] = update(state, listDone(okOutcome(payload(removed)), T0 + 1));
    expect(selectedRow(next)?.key).toBe(keys[3] ?? "missing");
  });

  test("the first load is the baseline: nothing marked, no bell", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    expect(state.marked.size).toBe(0);
  });

  test("a row that becomes me is marked and rings once; the mark goes when it leaves me", () => {
    const waiting = RULE_ROWS.find((item) => item.key === "linear:DMD-111");
    if (waiting === undefined) throw new Error("fixture");
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const nowMine = { ...waiting, on_turn: { actor: "me", reason: "respond", rule: 4 } } as const;
    const swapped = RULE_ROWS.map((item) => (item === waiting ? nowMine : item));
    const [marked, effects] = update({ ...state, refreshing: true }, listDone(okOutcome(payload(swapped)), T0 + 1));
    expect([...marked.marked]).toEqual(["connection linear:DMD-111"]);
    expect(effects[0]).toEqual({ kind: "bell" });
    expect(view(marked).some((line) => line.includes("* linear:DMD-111"))).toBe(true);
    const [again, quiet] = update(marked, listDone(okOutcome(payload(swapped)), T0 + 2));
    expect(again.marked.size).toBe(1);
    expect(quiet.some((effect) => effect.kind === "bell")).toBe(false);
    const [cleared] = update(again, listDone(okOutcome(payload(RULE_ROWS)), T0 + 3));
    expect(cleared.marked.size).toBe(0);
  });

  test("bell_on_transition false marks without a bell", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS.slice(1))), { settings: { bellOnTransition: false } });
    const [next, effects] = update(state, listDone(okOutcome(payload(RULE_ROWS)), T0 + 1));
    expect(next.marked.size).toBe(1);
    expect(effects.some((effect) => effect.kind === "bell")).toBe(false);
  });

  test("an outage and its recovery mark nothing (unknown never updates the baseline)", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)));
    const unknown = RULE_ROWS.map((item) => ({ ...item, on_turn: { actor: "unknown", reason: "pohunek:unavailable", rule: null } }) as const);
    const [down] = update(state, listDone(okOutcome(payload(unknown)), T0 + 1));
    const [up, effects] = update(down, listDone(okOutcome(payload(RULE_ROWS)), T0 + 2));
    expect(up.marked.size).toBe(0);
    expect(effects.some((effect) => effect.kind === "bell")).toBe(false);
  });

  test("an incompatible contract re-baselines: the next good load marks nothing", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS.slice(1))));
    const outcome = decodeListEnvelope(envelopeText(payload(RULE_ROWS), "2.0.0", { minimum: 2, maximum: 2 }));
    const [incompatible] = update(state, listDone(outcome, T0 + 1));
    const [next] = update(incompatible, listDone(okOutcome(payload(RULE_ROWS)), T0 + 2));
    expect(next.marked.size).toBe(0);
  });
});

test("a status message lasts until the next key", () => {
  const state = press(loaded(okOutcome(payload(RULE_ROWS))), ["r", "r"]).state;
  expect(state.status?.text).toBe("refresh already running");
  expect(press(state, ["j"]).state.status).toBeNull();
});
