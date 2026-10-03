// Reducer behavior of the write, preview, attach and open paths (T3, T4).
import { describe, expect, test } from "bun:test";
import { decodeDoEnvelope } from "../../src/tui/decode.ts";
import { INTERRUPTED, update, type Effect, type HandoverExit, type State } from "../../src/tui/model.ts";
import { rowId } from "../../src/tui/rows.ts";
import { detailLines, view } from "../../src/tui/view.ts";
import { loaded, NO_STDERR, okOutcome, payload, press, row, RULE_ROWS, T0, WIDE } from "./builders.ts";
import type { ListItem } from "../../src/types/item.ts";

const BIN = "/opt/bin/pohunek-work";

function at(key: string, items: readonly ListItem[] = RULE_ROWS): State {
  const state = loaded(okOutcome(payload(items)));
  const target = state.data?.payload.items.find((item) => item.key === key);
  if (target === undefined) throw new Error(`no row ${key}`);
  return { ...state, selected: rowId(target) };
}

function envelope(body: unknown): string {
  return JSON.stringify({ cli_version: "0.1.0", protocol: { minimum: 1, maximum: 1 }, ...(body as object) });
}

function done(state: State, mode: "write" | "attach", key: string, action: string, exit: Partial<HandoverExit>): readonly [State, readonly Effect[]] {
  const full: HandoverExit = { exitCode: 0, signal: null, stdout: "", spawnError: null, ...exit };
  return update({ ...state, overlay: "none" }, { kind: "handoverDone", mode, row: `connection ${key}`, key, action, exit: full, now: T0 + 1 });
}

describe("Enter: primary action as a handover to do", () => {
  test.each([
    ["github:keboola/connection#9003", "review"],
    ["linear:DMD-104", "babysit"],
    ["linear:DMD-105", "fix-ci"],
    ["linear:DMD-106", "rebase"],
    ["linear:DMD-107", "ready"],
    ["linear:DMD-109", "implement"],
  ])("%s runs `do %s` with --project and --json, no --yes", (key, action) => {
    const { effects } = press(at(key), ["<enter>"]);
    expect(effects).toEqual([
      { kind: "handover", mode: "write", row: `connection ${key}`, key, action, argv: [BIN, "do", key, action, "--project", "connection", "--json"] },
    ]);
  });

  test("a primary attach (rules 1 and 11) is an attach handover without --json", () => {
    for (const key of ["linear:DMD-101", "linear:DMD-112"]) {
      expect(press(at(key), ["<enter>"]).effects).toEqual([
        { kind: "handover", mode: "attach", row: `connection ${key}`, key, action: "attach", argv: [BIN, "do", key, "attach", "--project", "connection"] },
      ]);
    }
  });

  test("rows without an action (7, 9, 10, unknown) say the step is manual", () => {
    for (const key of ["linear:DMD-108", "linear:DMD-110", "linear:DMD-111", "linear:OPS-7"]) {
      const { state, effects } = press(at(key), ["<enter>"]);
      expect(effects).toEqual([]);
      expect(state.status?.text).toBe("no action for this row: the next step is manual (o opens it)");
    }
  });

  test("a contract row listing merge first is not executable", () => {
    const merge = row("linear:DMD-200", { on_turn: { actor: "me", reason: "merge", rule: 7 }, actions: [{ name: "merge", delegable: false }] });
    const { state, effects } = press(at("linear:DMD-200", [merge]), ["<enter>"]);
    expect(effects).toEqual([]);
    expect(state.status).toEqual({ text: "merge is not supported in the TUI", error: true });
  });

  test("a key of a bad shape is refused before any argv exists", () => {
    const evil = row("--yes", { on_turn: { actor: "me", reason: "nothing runs", rule: 8 }, actions: [{ name: "implement", delegable: false }] });
    const { state, effects } = press(at("--yes", [evil]), ["<enter>"]);
    expect(effects).toEqual([]);
    expect(state.status?.error).toBe(true);
  });
});

describe("a: choose among the row's actions", () => {
  const both = row("linear:DMD-300", {
    on_turn: { actor: "me", reason: "fix CI", rule: 5 },
    actions: [
      { name: "fix-ci", delegable: false, profile: "claude-otel" },
      { name: "merge", delegable: false },
      { name: "attach", delegable: false },
    ],
  });

  test("the chooser lists every action and marks the unsupported one", () => {
    const state = press(at("linear:DMD-300", [both]), ["a"]).state;
    expect(state.overlay).toBe("chooser");
    const frame = view(state).join("\n");
    expect(frame).toContain("> 1. fix-ci* (claude-otel)");
    expect(frame).toContain("  2. merge [not run by the TUI]");
    expect(frame).toContain("  3. attach");
  });

  test("j/k and Enter, or a digit, run the chosen action", () => {
    const base = at("linear:DMD-300", [both]);
    expect(press(base, ["a", "j", "j", "<enter>"]).effects).toEqual([
      { kind: "handover", mode: "attach", row: "connection linear:DMD-300", key: "linear:DMD-300", action: "attach", argv: [BIN, "do", "linear:DMD-300", "attach", "--project", "connection"] },
    ]);
    expect(press(base, ["a", "1"]).effects).toEqual([
      { kind: "handover", mode: "write", row: "connection linear:DMD-300", key: "linear:DMD-300", action: "fix-ci", argv: [BIN, "do", "linear:DMD-300", "fix-ci", "--project", "connection", "--json"] },
    ]);
  });

  test("choosing merge runs nothing; Esc closes", () => {
    const base = at("linear:DMD-300", [both]);
    const chosen = press(base, ["a", "2"]);
    expect(chosen.effects).toEqual([]);
    expect(chosen.state.status).toEqual({ text: "merge is not supported in the TUI", error: true });
    expect(press(base, ["a", "<esc>"]).state.overlay).toBe("none");
  });

  test("no chooser for a row without actions", () => {
    const { state } = press(at("linear:DMD-108"), ["a"]);
    expect(state.overlay).toBe("none");
  });
});

test("property: no key sequence on any row produces an argv containing merge", () => {
  const mergeRows = RULE_ROWS.map((item) => ({ ...item, actions: [{ name: "merge", delegable: false }, ...item.actions] }));
  const sequences = [["<enter>"], ["p"], ["t"], ["a", "<enter>"], ["a", "j", "<enter>"], ["a", "1"], ["a", "2"], ["a", "3"]];
  for (const items of [RULE_ROWS, mergeRows]) {
    for (const item of items) {
      for (const sequence of sequences) {
        const { effects } = press(at(item.key, items), sequence);
        for (const effect of effects as Effect[]) {
          if ("argv" in effect) expect(effect.argv.some((element) => element.includes("merge"))).toBe(false);
        }
      }
    }
  }
});

describe("p: preview", () => {
  test("runs do --dry-run --json for the primary action and shows the plan in the detail pane", () => {
    const { state, effects } = press(at("linear:DMD-109"), ["p"]);
    expect(effects).toEqual([
      { kind: "preview", row: "connection linear:DMD-109", action: "implement", argv: [BIN, "do", "linear:DMD-109", "implement", "--project", "connection", "--dry-run", "--json"] },
    ]);
    expect(state.previewing).toBe("connection linear:DMD-109");
    expect(press(state, ["p"]).state.status?.text).toBe("a preview is already running");
    const outcome = decodeDoEnvelope(envelope({ ok: { dry_run: true, plan: { action: "implement", key: "linear:DMD-109", profile: "claude-otel", argv: ["/bin/pohunek", "session", "new"], prompt: "do X\nthen Y" } } }));
    const [next] = update(state, { kind: "previewDone", row: "connection linear:DMD-109", action: "implement", run: { ...NO_STDERR, stderr: ["warning: x"] }, outcome });
    expect(next.previewing).toBeNull();
    const item = next.data?.payload.items.find((i) => i.key === "linear:DMD-109");
    if (item === undefined) throw new Error("fixture");
    expect(detailLines(next, item).slice(-9).map(String)).toEqual([
      "",
      "--- preview: implement (dry run, nothing executed)",
      "profile: claude-otel",
      "argv: /bin/pohunek session new",
      "prompt (stdin):",
      "  do X",
      "  then Y",
      "stderr:",
      "warning: x",
    ]);
  });

  test("a refusal, a timeout and a spawn failure land in the detail pane", () => {
    const base = press(at("linear:DMD-109"), ["p"]).state;
    const refusal = decodeDoEnvelope(envelope({ err: { class: "action", code: "no_profile", msg: "no agent profile for implement" } }));
    const cases = [
      [{ ...NO_STDERR, exitCode: 2 }, refusal, "--- refused: no_profile"],
      [{ ...NO_STDERR, exitCode: null, timedOut: true }, null, "--- preview of implement timed out"],
      [{ ...NO_STDERR, exitCode: null, spawnError: "cannot start /opt/bin/pohunek-work" }, null, "--- preview of implement failed"],
    ] as const;
    for (const [run, outcome, title] of cases) {
      const [next] = update(base, { kind: "previewDone", row: "connection linear:DMD-109", action: "implement", run, outcome });
      expect(next.notes.get("connection linear:DMD-109")?.title).toBe(title.slice(4));
    }
  });
});

describe("t: attach", () => {
  test("only when the row lists attach", () => {
    expect(press(at("linear:DMD-105"), ["t"]).state.status?.text).toBe("no live linked session to attach to");
    expect(press(at("linear:DMD-102"), ["t"]).effects).toEqual([
      { kind: "handover", mode: "attach", row: "connection linear:DMD-102", key: "linear:DMD-102", action: "attach", argv: [BIN, "do", "linear:DMD-102", "attach", "--project", "connection"] },
    ]);
  });
});

describe("handover results", () => {
  const key = "linear:DMD-109";
  const ok = envelope({ ok: { dry_run: false, plan: { action: "implement", key }, result: { session_id: "s-NEW", name: "DMD-109" } } });

  test("success: status, result in the detail pane, then a refresh", () => {
    const [state, effects] = done(at(key), "write", key, "implement", { stdout: ok });
    expect(state.status).toEqual({ text: `implement ${key}: done`, error: false });
    expect(state.notes.get(`connection ${key}`)).toEqual({ title: "done: implement", lines: ["session_id: s-NEW", "name: DMD-109"] });
    expect(effects).toEqual([{ kind: "list", argv: [BIN, "list", "--json"] }]);
  });

  test('"N" at do\'s prompt shows cancelled and nothing else', () => {
    const stdout = envelope({ err: { class: "action", code: "confirmation_required", msg: "not confirmed; nothing was executed" } });
    const [state] = done(at(key), "write", key, "implement", { exitCode: 2, stdout });
    expect(state.status).toEqual({ text: `implement ${key}: cancelled, nothing was executed`, error: false });
    expect(state.notes.size).toBe(0);
  });

  test("a typed refusal goes to the detail pane", () => {
    const stdout = envelope({ err: { class: "action", code: "already_running", msg: "a live session runs", recover: "attach to it" } });
    const [state] = done(at(key), "write", key, "implement", { exitCode: 2, stdout });
    expect(state.status).toEqual({ text: `implement ${key}: refused (already_running)`, error: true });
    expect(state.notes.get(`connection ${key}`)).toEqual({ title: "refused: already_running", lines: ["a live session runs", "attach to it"] });
  });

  test.each(["launch_unverified", "launch_timed_out", "command_timed_out", "verification_failed", "command_unverified"])(
    "%s after the write ran is never shown as refused",
    (code) => {
      const stdout = envelope({ err: { class: "action", code, msg: "the session started but its HEAD differs" } });
      const [state] = done(at(key), "write", key, "implement", { exitCode: 2, stdout });
      expect(state.status).toEqual({ text: `implement ${key}: executed, outcome unverified (${code})`, error: true });
      expect(state.notes.get(`connection ${key}`)?.title).toBe(`ran, unverified: ${code}`);
    },
  );

  test("an incompatible write envelope is an unknown outcome", () => {
    const stdout = JSON.stringify({ cli_version: "9", protocol: { minimum: 2, maximum: 2 }, ok: {} });
    const [state] = done(at(key), "write", key, "implement", { stdout });
    expect(state.status).toEqual({ text: `implement ${key}: ${INTERRUPTED}`, error: true });
  });

  test("killed by a signal or without a decodable envelope: interrupted, outcome unknown", () => {
    for (const exit of [{ exitCode: null, signal: "SIGINT" }, { exitCode: 1, stdout: "garbage" }, { exitCode: 0, stdout: "" }]) {
      const [state, effects] = done(at(key), "write", key, "implement", exit);
      expect(state.status).toEqual({ text: `implement ${key}: ${INTERRUPTED}`, error: true });
      expect(INTERRUPTED).toBe("interrupted, outcome unknown: check `pohunek session list`");
      expect(effects).toEqual([{ kind: "list", argv: [BIN, "list", "--json"] }]);
    }
  });

  test("attach: a clean detach, a refusal by exit code, a signal", () => {
    expect(done(at(key), "attach", key, "attach", { exitCode: 0 })[0].status).toEqual({ text: `detached from ${key}`, error: false });
    expect(done(at(key), "attach", key, "attach", { exitCode: 2 })[0].status?.text).toBe(
      `attach to ${key} failed (exit 2); do printed the reason before the return prompt`,
    );
    expect(done(at(key), "attach", key, "attach", { exitCode: null, signal: "SIGHUP" })[0].status?.text).toBe(`attach to ${key} ended by SIGHUP`);
  });

  test("a spawn failure is shown", () => {
    const [state] = done(at(key), "write", key, "implement", { exitCode: null, spawnError: "cannot start /opt/bin/pohunek-work" });
    expect(state.status).toEqual({ text: `implement ${key}: cannot start /opt/bin/pohunek-work`, error: true });
  });

  test("a refresh running during the handover is followed by a fresh one", () => {
    const busy = { ...at(key), refreshing: true };
    const [state, effects] = done(busy, "write", key, "implement", { stdout: ok });
    expect(effects).toEqual([]);
    expect(state.refreshQueued).toBe(true);
    const [after, next] = update(state, { kind: "listDone", run: NO_STDERR, outcome: okOutcome(payload(RULE_ROWS)), now: T0 + 2 });
    expect(next[0]).toEqual({ kind: "list", argv: [BIN, "list", "--json"] });
    expect(after.refreshing).toBe(true);
  });
});

describe("o: open the PR or issue URL", () => {
  test("the PR URL first, then the issue URL, only on allowed hosts", () => {
    expect(press(at("linear:DMD-105"), ["o"]).effects).toEqual([
      { kind: "open", key: "linear:DMD-105", host: "github.com", href: "https://github.com/keboola/connection/pull/9005" },
    ]);
    expect(press(at("linear:DMD-109"), ["o"]).effects).toEqual([
      { kind: "open", key: "linear:DMD-109", host: "linear.app", href: "https://linear.app/acme/issue/DMD-109" },
    ]);
  });

  test("anything else is refused and shown", () => {
    const evil = row("linear:EVIL-1", { issue: { id: "EVIL-1", title: "t", state: "s", url: "https://evil.example/\u001b[2J" } });
    const { state, effects } = press(at("linear:EVIL-1", [evil]), ["o"]);
    expect(effects).toEqual([]);
    expect(state.status).toEqual({ text: "not opened: host evil.example is not in open_url_hosts", error: true });
    expect(press(at("linear:EVIL-2", [row("linear:EVIL-2")]), ["o"]).state.status?.text).toBe("this row has no URL");
  });

  test("an opener that cannot start is reported", () => {
    const [state] = update(at("linear:DMD-105"), { kind: "openDone", error: "cannot start /usr/bin/xdg-open" });
    expect(state.status).toEqual({ text: "open failed: cannot start /usr/bin/xdg-open", error: true });
  });
});

test("the wide detail pane shows a refusal note, sanitized", () => {
  const stdout = envelope({ err: { class: "action", code: "precondition_failed", msg: "checks are green \u001b[31mnow" } });
  const [state] = done(loaded(okOutcome(payload(RULE_ROWS)), { size: WIDE }), "write", "github:keboola/connection#9003", "review", { exitCode: 2, stdout });
  const frame = view(state).join("\n");
  expect(frame).toContain("--- refused: precondition_failed");
  expect(frame).toContain("checks are green ?[31mnow");
});
