import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeListEnvelope } from "../../src/tui/decode.ts";
import { initialState, update, type State } from "../../src/tui/model.ts";
import { detailLines, formatAge, ruleLine, view, type Frame } from "../../src/tui/view.ts";
import {
  envelopeText,
  listDone,
  loaded,
  NARROW,
  okOutcome,
  payload,
  press,
  PROJECTS_PARTIAL,
  row,
  RULE_ROWS,
  SETTINGS,
  T0,
  WIDE,
} from "./builders.ts";

const GOLDEN_DIR = join(import.meta.dir, "..", "fixtures", "tui");
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";
const rendered: { name: string; state: State; frame: Frame }[] = [];

function render(name: string, state: State): Frame {
  const frame = view(state);
  rendered.push({ name, state, frame });
  return frame;
}

/** Compares with tests/fixtures/tui/<name>.txt; UPDATE_GOLDEN=1 rewrites the file. */
function golden(name: string, state: State): void {
  const text = `${render(name, state).join("\n")}\n`;
  const path = join(GOLDEN_DIR, `${name}.txt`);
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, text);
    return;
  }
  expect(text).toBe(readFileSync(path, "utf8"));
}

const SIZES = [
  ["80", NARROW],
  ["160", WIDE],
] as const;

describe.each(SIZES)("golden frames at width %s", (width, size) => {
  test("first load", () => {
    golden(`loading-${width}`, initialState(SETTINGS, size, T0));
  });

  test("all rows, first row selected", () => {
    golden(`all-${width}`, loaded(okOutcome(payload(RULE_ROWS)), { size }));
  });

  test("mine view with a partial banner and the hidden-unknown counter", () => {
    golden(`mine-partial-${width}`, loaded(okOutcome(payload(RULE_ROWS, PROJECTS_PARTIAL)), { size, settings: { initialView: "mine" } }));
  });

  test("ignored rows hidden: the count shows in the banner area at this width", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS, undefined, 3)), { size });
    const lines = view(state);
    expect(lines.filter((line) => line.includes("ignored hidden: 3"))).toHaveLength(1);
    expect(lines.every((line) => line.length <= size.columns)).toBe(true);
    golden(`ignored-hidden-${width}`, state);
  });

  test("no ignored indicator when nothing is hidden", () => {
    expect(view(loaded(okOutcome(payload(RULE_ROWS)), { size })).join("\n")).not.toContain("ignored hidden");
  });

  test("err envelope: full screen, r retries", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)), { size });
    const err = decodeListEnvelope(
      JSON.stringify({
        cli_version: "0.1.0",
        protocol: { minimum: 4, maximum: 4 },
        err: { class: "configuration", code: "config_invalid", msg: "config.toml: tui is required" },
      }),
    );
    const [next] = update(state, listDone(err, T0 + 120_000, { exitCode: 2 }));
    golden(`error-${width}`, next);
  });

  test("protocol excludes v4: incompatible, no rows", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)), { size });
    const outcome = decodeListEnvelope(envelopeText(payload(RULE_ROWS), "9.0.0", { minimum: 5, maximum: 6 }));
    const [next] = update(state, listDone(outcome, T0 + 60_000));
    golden(`incompatible-${width}`, next);
  });

  test("no open work items", () => {
    golden(`empty-${width}`, loaded(okOutcome(payload([])), { size }));
  });

  test("a filter hides every row", () => {
    const state = press(loaded(okOutcome(payload(RULE_ROWS)), { size }), ["/", "z", "z", "z", "<enter>"]).state;
    golden(`filtered-out-${width}`, state);
  });

  test("stale data from another build, list stderr kept", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS), "0.2.0"), {
      size,
      stderr: ["project gadgets: no pohunek project with this label; left out (run doctor)", "source unavailable: ops github: rate_limited"],
    });
    const [stale] = update(state, { kind: "tick", now: T0 + 16 * 60_000 });
    golden(`stale-${width}`, stale);
  });

  test("the list-contract.json fixture of list --json", () => {
    const text = readFileSync(join(import.meta.dir, "..", "fixtures", "output", "list-contract.json"), "utf8");
    golden(`contract-${width}`, loaded(decodeListEnvelope(text), { size }));
  });

  test("action chooser and a refusal note in the detail pane", () => {
    const withMerge = RULE_ROWS.map((item) =>
      item.key === "linear:DMD-105" ? { ...item, actions: [...item.actions, { name: "merge", delegable: false }, { name: "attach", delegable: false }] } : item,
    );
    const state = loaded(okOutcome(payload(withMerge)), { size });
    const onRow = press(state, ["/", "1", "0", "5", "<enter>"]).state;
    golden(`chooser-${width}`, press(onRow, ["a"]).state);
    const refusal = JSON.stringify({
      cli_version: "0.1.0",
      protocol: { minimum: 1, maximum: 1 },
      err: { class: "action", code: "precondition_failed", msg: "fix-ci refused: no check fails any more" },
    });
    const [refused] = update(onRow, {
      kind: "handoverDone",
      mode: "write",
      row: "connection linear:DMD-105",
      key: "linear:DMD-105",
      action: "fix-ci",
      exit: { exitCode: 2, signal: null, stdout: refusal, spawnError: null },
      now: T0 + 1,
    });
    golden(`refused-${width}`, refused);
  });

  test("help and sessions overlays", () => {
    const state = loaded(okOutcome(payload(RULE_ROWS)), { size, stderr: ["warning one"] });
    golden(`help-${width}`, press(state, ["?"]).state);
    golden(`sessions-${width}`, press(state, ["s"]).state);
  });
});

test("golden: full-screen detail on Tab below detail_min_width", () => {
  const state = press(loaded(okOutcome(payload(RULE_ROWS)), { size: NARROW }), ["j", "j", "j", "<tab>"]).state;
  expect(state.overlay).toBe("detail");
  golden("detail-full-80", state);
});

test("golden: terminal too small", () => {
  golden("too-small", loaded(okOutcome(payload(RULE_ROWS)), { size: { columns: 30, rows: 4 } }));
});

test("golden: detail pane text for every rule", () => {
  const state = loaded(okOutcome(payload(RULE_ROWS)), { size: WIDE });
  const text = `${RULE_ROWS.map((item) => detailLines(state, item).join("\n")).join("\n\n")}\n`;
  const path = join(GOLDEN_DIR, "detail-per-rule.txt");
  if (UPDATE) writeFileSync(path, text);
  else expect(text).toBe(readFileSync(path, "utf8"));
});

test("rule 5 has a line per reason, a policy check included", () => {
  const line = (reason: string): string => ruleLine(row("github:acme/x#1", { on_turn: { actor: "me", reason, rule: 5 } }));
  expect(line("fix CI")).toBe("a check failed on the pull request");
  expect(line("rebase")).toBe("the pull request conflicts with its base branch");
  expect(line("policy check: Require label")).toBe("a policy check failed: meet it on GitHub (manual)");
});

test("an external review row decodes, shows the agent actor and explains the reason", () => {
  const external = row("github:acme/x#1", { on_turn: { actor: "agent", reason: "external review", rule: 3 }, actions: [] });
  const decoded = decodeListEnvelope(envelopeText(payload([external])));
  expect(decoded.kind === "ok" ? decoded.payload.items : null).toEqual([external]);
  expect(ruleLine(external)).toBe("your review is requested; the project's external pipeline handles it");
  const frame = view(loaded(okOutcome(payload([external])), { size: WIDE }));
  expect(frame.some((line) => line.includes("agent (r3)"))).toBe(true);
});

test("a paused row decodes, sorts last, shows its rule and is counted in the header", () => {
  const paused = row("linear:DMD-140", { on_turn: { actor: "paused", reason: "paused", rule: 12 } });
  const decoded = decodeListEnvelope(envelopeText(payload([paused, ...RULE_ROWS])));
  expect(decoded.kind).toBe("ok");
  const state = loaded(okOutcome(payload([paused, ...RULE_ROWS])), { size: WIDE });
  const frame = view(state);
  expect(frame[0]).toContain("reviewer 1  paused 1  unknown 1");
  const rows = frame.filter((line) => line.includes("linear:DMD-1"));
  expect(rows.at(-1)).toContain("linear:DMD-140");
  expect(rows.at(-1)).toContain("paused (r12)");
  expect(ruleLine(paused)).toBe("the issue is in a paused state: nobody's turn until it leaves that state");
  expect(view(loaded(okOutcome(payload(RULE_ROWS)), { size: WIDE }))[0]).not.toContain("paused");
});

const ESC = "\u001b";
const HOSTILE_TITLES = [
  `${ESC}[2J${ESC}[31mred${ESC}[0m`,
  `${ESC}]8;;https://evil.example${ESC}\\link${ESC}]8;;${ESC}\\`,
  `${ESC}]52;c;cHduZWQ=\u0007clipboard`,
  "rtl \u202Eevil\u202C override",
  "zero\u200Bwidth\u200D joiner\uFEFF",
  "line\nbreak\r\nand\ttab",
  "x".repeat(10_000),
  "Příliš žluťoučký kůň úpěl ďábelské ódy",
  "emoji 😀 and CJK 漢字",
];

describe("hostile text through toSafe", () => {
  const rows = HOSTILE_TITLES.map((title, index) =>
    row(`linear:EVIL-${index.toString()}`, {
      issue: { id: `EVIL-${index.toString()}`, title, state: `${ESC}[1mstate`, url: `https://linear.app/x/${ESC}[0m` },
      sessions: [{ id: `s-${ESC}x`, name: title, role: `${ESC}]0;t\u0007`, state: "running", activity: null }],
    }),
  );
  const hostile = payload(rows);

  test.each(SIZES)("frames stay ASCII and within the width at %s", (_width, size) => {
    const state = loaded(okOutcome(hostile), { size, stderr: [`${ESC}[2Jcleared`, "\u202Ebidi stderr"] });
    for (const spec of [[], ["<tab>"], ["s"], ["j", "j", "j", "j", "j", "j", "j"]]) {
      const frame = render(`hostile-${spec.join("")}`, press(state, spec).state);
      expect(frame.join("")).not.toContain(ESC);
    }
  });

  test("Czech diacritics stay readable", () => {
    const state = loaded(okOutcome(hostile), { size: WIDE });
    const all = press(state, ["G", "k"]).state;
    expect(view(all).join("\n")).toContain("Prilis zlutoucky kun upel dabelske ody");
  });
});

test("formatAge", () => {
  expect(formatAge(0)).toBe("<1m");
  expect(formatAge(59_999)).toBe("<1m");
  expect(formatAge(60_000)).toBe("1m");
  expect(formatAge(61 * 60_000)).toBe("1h01m");
});

// Runs last: bun runs the tests of a file in order.
test("every frame rendered in this file is printable ASCII within the terminal size", () => {
  expect(rendered.length).toBeGreaterThan(30);
  for (const { name, state, frame } of rendered) {
    expect({ name, lines: frame.length <= state.size.rows }).toEqual({ name, lines: true });
    for (const line of frame) {
      expect({ name, width: line.length <= state.size.columns }).toEqual({ name, width: true });
      expect({ name, ascii: /^[\x20-\x7e]*$/.test(line) }).toEqual({ name, ascii: true });
    }
  }
});

describe("secondary pull request row", () => {
  const secondary = row("github:acme/widgets#1234567", { issue_key: "ABC-1" });

  test.each(SIZES)("keeps the issue key visible in the KEY column at width %s", (_width, size) => {
    const frame = render(`secondary-${_width}`, loaded(okOutcome(payload([secondary])), { size }));
    const tableRow = frame.map((line) => line.split("|")[0] ?? "").find((cells) => cells.includes("github:acme"));
    expect(tableRow).toContain("(ABC-1)");
  });
});
