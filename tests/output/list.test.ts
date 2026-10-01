import { expect, test } from "bun:test";
import {
  buildErrorEnvelope,
  buildListEnvelope,
  buildListItem,
  filterMine,
  renderTable,
  sanitizeCell,
} from "../../src/output/list.ts";
import { LIST_CONTRACT_VERSION } from "../../src/types/item.ts";
import {
  allOk,
  check,
  deliveredPr,
  identity,
  issue,
  item,
  notification,
  pr,
  project,
  session,
} from "../rules/builders.ts";

const context = { sources: allOk, identity, project };

const GOLDEN = new URL("../fixtures/output/list-contract.json", import.meta.url);

function sampleEnvelope(): unknown {
  const rows = [
    buildListItem(
      item({
        key: "linear:ABC-1",
        issue: issue(),
        pullRequest: deliveredPr(),
        noIssue: false,
        joinedBy: "branch_pattern",
        sessions: [session({ metadata: { "work.role": "babysit" } })],
      }),
      context,
    ),
    buildListItem(
      item({ pullRequest: pr({ isDraft: true, checks: [check("build", "success")] }) }),
      context,
    ),
    buildListItem(item({ key: "linear:ABC-2", issue: issue({ id: "ABC-2" }), pullRequest: null, noIssue: false }), context),
  ];
  return buildListEnvelope(
    "0.1.0",
    rows,
    [{ id: "s-9", name: null, linkId: "ABC-9" }],
    [{ id: "s-8", name: "scratch", project: "widgets", state: "running", activity: "idle" }],
    [{ project: "widgets", sources: allOk }],
  );
}

test("list --json contract is pinned by a golden file", async () => {
  const actual = JSON.parse(JSON.stringify(sampleEnvelope())) as unknown;
  if (process.env["UPDATE_GOLDEN"] === "1") {
    await Bun.write(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
  }
  expect(actual).toEqual(JSON.parse(await Bun.file(GOLDEN).text()) as unknown);
});

test("envelope carries the contract version and exactly one of ok or err", () => {
  const ok = buildListEnvelope("0.1.0", [], [], [], []);
  expect(ok).toEqual({
    cli_version: "0.1.0",
    protocol: { minimum: LIST_CONTRACT_VERSION, maximum: LIST_CONTRACT_VERSION },
    ok: { items: [], orphaned_sessions: [], unlinked_sessions: [], projects: [] },
  });
  const err = buildErrorEnvelope("0.1.0", { class: "configuration", code: "config_invalid", msg: "x" });
  expect("ok" in err).toBe(false);
  expect("err" in err).toBe(true);
});

test("a row has exactly the contract keys", () => {
  const row = buildListItem(item(), context);
  expect(Object.keys(row).sort()).toEqual(
    ["actions", "issue", "key", "no_issue", "on_turn", "project", "pull_request", "sessions", "sources"].sort(),
  );
  expect(Object.keys(row.pull_request ?? {}).sort()).toEqual(
    ["checks", "draft", "fix_delivered", "id", "mergeable", "rerequested", "review_decision", "threads_answered", "title", "url"].sort(),
  );
  expect(row.actions).toEqual([]);
});

test("--mine keeps only rows on the owner's turn", () => {
  const mine = buildListItem(item({ pullRequest: pr({ isDraft: true }) }), context);
  const other = buildListItem(item({ pullRequest: pr({ reviewDecision: "APPROVED", checks: [check("b", "pending")] }) }), context);
  expect(mine.on_turn.actor).toBe("me");
  expect(other.on_turn.actor).toBe("reviewer");
  expect(filterMine([mine, other])).toEqual([mine]);
});

test("unknown rows carry the failing source and are excluded by the --mine filter", () => {
  const row = buildListItem(item(), { ...context, sources: { ...allOk, github: "rate_limited" } });
  expect(row.on_turn).toEqual({ actor: "unknown", reason: "github:rate_limited", rule: null });
  expect(row.sources.github).toBe("rate_limited");
  expect(filterMine([row])).toEqual([]);
});

test("session role comes from work.role metadata", () => {
  const row = buildListItem(item({ sessions: [session({ metadata: { "work.role": "review" } }), session({ id: "s-2" })] }), context);
  expect(row.sessions.map((s) => s.role)).toEqual(["review", null]);
});

test("table renders rows, no-issue marker and orphans", () => {
  const rows = [
    buildListItem(item({ pullRequest: pr({ isDraft: true }), notifications: [notification()] }), context),
  ];
  const text = renderTable(
    rows,
    [{ id: "s-9", name: "x", linkId: "ABC-9" }],
    [{ id: "s-8", name: "scratch", project: "widgets", state: "running", activity: "idle" }],
    new Set(),
  );
  expect(text.split("\n")[0]).toMatch(/^KEY\s+ON TURN\s+PR\s+REVIEW\s+CHECKS\s+SESSIONS\s+TITLE$/);
  expect(text).toContain("github:acme/widgets#12 (no issue)");
  expect(text).toContain("me: leave draft (r6)");
  expect(text).toContain("orphaned session s-9 (x) links ABC-9");
  expect(text).toContain("unlinked session s-8 (scratch) in widgets: idle");
});

test("terminal control sequences in provider text are neutralized", () => {
  expect(sanitizeCell("a\u001b[31mred\u0007\nb")).toBe("a [31mred  b");
  const row = buildListItem(item({ pullRequest: pr({ title: "evil\u001b]0;pwn\u0007" }) }), context);
  expect(renderTable([row], [], [], new Set())).not.toContain("\u001b");
});
