import { describe, expect, test } from "bun:test";
import {
  buildErrorEnvelope,
  buildListEnvelope,
  buildListItem,
  filterMine,
  renderTable,
  rowActions,
} from "../../src/output/list.ts";
import { sanitizeCell } from "../../src/output/sanitize.ts";
import type { OnTurn, RuleNumber } from "../../src/types/item.ts";
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

const GLOBAL_PROFILES = { implement: "profile-a", babysit: "profile-b", "fix-ci": "profile-c", rebase: "profile-d", review: "profile-e" };
const context = { sources: allOk, identity, project: { ...project, profiles: null }, profiles: GLOBAL_PROFILES };

const GOLDEN = new URL("../fixtures/output/list-contract.json", import.meta.url);

function sampleEnvelope(): unknown {
  const rows = [
    buildListItem(
      item({
        key: "linear:ABC-1",
        issue: issue(),
        pullRequest: deliveredPr(),
        noIssue: false,
        issueKey: "ABC-1",
        joinedBy: "branch_pattern",
        sessions: [session({ metadata: { "work.role": "babysit" } })],
      }),
      context,
    ),
    buildListItem(
      item({ pullRequest: pr({ isDraft: true, checks: [check("build", "success")] }) }),
      context,
    ),
    buildListItem(item({ key: "linear:ABC-2", issue: issue({ id: "ABC-2" }), pullRequest: null, noIssue: false, issueKey: "ABC-2" }), context),
    buildListItem(
      item({
        key: "github:acme/widgets#14",
        pullRequest: pr({ id: "acme/widgets#14", number: 14 }),
        noIssue: false,
        issueKey: "ABC-1",
      }),
      context,
    ),
    buildListItem(
      item({
        key: "linear:ABC-3",
        issue: issue({ id: "ABC-3", state: "On hold", paused: true }),
        pullRequest: pr({ id: "acme/widgets#13", number: 13, isDraft: true, mergeable: "CONFLICTING" }),
        noIssue: false,
        issueKey: "ABC-3",
        joinedBy: "branch_pattern",
      }),
      context,
    ),
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
  const err = buildErrorEnvelope("0.1.0", { class: "configuration", code: "config_invalid", msg: "x" }, LIST_CONTRACT_VERSION);
  expect("ok" in err).toBe(false);
  expect("err" in err).toBe(true);
});

test("a row has exactly the contract keys", () => {
  const row = buildListItem(item(), context);
  expect(Object.keys(row).sort()).toEqual(
    ["actions", "issue", "issue_key", "key", "no_issue", "on_turn", "project", "pull_request", "sessions", "sources"].sort(),
  );
  expect(Object.keys(row.pull_request ?? {}).sort()).toEqual(
    ["checks", "draft", "fix_delivered", "id", "mergeable", "rerequested", "review_decision", "threads_answered", "title", "updated_at", "url"].sort(),
  );
  expect(row.on_turn.rule).toBe(9);
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

test("sanitizeCell turns control characters into spaces and keeps the rest", () => {
  expect(sanitizeCell("a\u001b[31mred\u0007\nb \u017e")).toBe("a [31mred  b \u017e");
});

test("the table is strict ASCII: escapes, bidi and zero-width characters become ?, diacritics are dropped", () => {
  const row = buildListItem(
    item({ pullRequest: pr({ title: "evil\u001b]0;pwn\u0007 \u202Ertl\u200B \u017dlu\u0165ou\u010dk\u00fd" }) }),
    context,
  );
  const text = renderTable(
    [row],
    [{ id: "s-9", name: "o\u001b[2J", linkId: "ABC-9" }],
    [{ id: "s-8", name: "\u202Ename", project: "widgets", state: "running", activity: "idle" }],
    new Set(),
  );
  expect(/^[\x20-\x7e\n]*$/.test(text)).toBe(true);
  expect(text).toContain("evil?]0;pwn? ?rtl? Zlutoucky");
  expect(text).toContain("orphaned session s-9 (o?[2J) links ABC-9");
  expect(text).toContain("unlinked session s-8 (?name)");
});

describe("actions per row (docs/tui-plan.md 4.5)", () => {
  const meTurns: readonly [OnTurn, readonly string[]][] = [
    [{ actor: "me", reason: "answer agent", rule: 1 }, []],
    [{ actor: "me", reason: "review", rule: 3 }, ["review"]],
    [{ actor: "me", reason: "respond", rule: 4 }, ["babysit"]],
    [{ actor: "me", reason: "fix CI", rule: 5 }, ["fix-ci"]],
    [{ actor: "me", reason: "rebase", rule: 5 }, ["rebase"]],
    [{ actor: "me", reason: "policy check: Require label", rule: 5 }, []],
    [{ actor: "me", reason: "leave draft", rule: 6 }, ["ready"]],
    [{ actor: "me", reason: "merge", rule: 7 }, []],
    [{ actor: "me", reason: "nothing runs", rule: 8 }, ["implement"]],
    [{ actor: "me", reason: "request review", rule: 9 }, []],
    [{ actor: "me", reason: "check agent", rule: 11 }, []],
    [{ actor: "agent", reason: "working", rule: 2 }, []],
    [{ actor: "reviewer", reason: "waiting", rule: 10 }, []],
    [{ actor: "unknown", reason: "github:rate_limited", rule: null }, []],
  ];

  /** Actions `do` starts in the worktree of a linked session. */
  const worktreeActions: readonly string[] = ["babysit", "fix-ci", "rebase"];
  const owner = session({ state: "stopped", activity: null, worktreePath: "/wt/a" });

  test.each(meTurns)("%p with a stopped linked session that owns a worktree: %p", (onTurn, names) => {
    expect(rowActions(item({ sessions: [owner] }), onTurn, context).map((action) => action.name)).toEqual([...names]);
  });

  test.each(meTurns)("%p without a linked session lists no worktree action", (onTurn, names) => {
    const expected = names.filter((name) => !worktreeActions.includes(name));
    expect(rowActions(item(), onTurn, context).map((action) => action.name)).toEqual(expected);
  });

  test.each(meTurns)("%p with a live linked session that owns a worktree adds attach last", (onTurn, names) => {
    const live = item({ sessions: [session({ worktreePath: "/wt/a" })] });
    expect(rowActions(live, onTurn, context).map((action) => action.name)).toEqual([...names, "attach"]);
  });

  test.each(meTurns)("%p with a live linked session without a worktree keeps attach only for worktree actions", (onTurn, names) => {
    const expected = names.filter((name) => !worktreeActions.includes(name));
    expect(rowActions(item({ sessions: [session()] }), onTurn, context).map((action) => action.name)).toEqual([...expected, "attach"]);
  });

  test("any linked session that owns a worktree is enough, not only the implementing one", () => {
    const onTurn: OnTurn = { actor: "me", reason: "respond", rule: 4 };
    const sessions = [session({ id: "s-2", state: "stopped", worktreePath: null }), session({ id: "s-3", state: "exited", worktreePath: "/wt/b", metadata: { "work.role": "babysit" } })];
    expect(rowActions(item({ sessions }), onTurn, context).map((action) => action.name)).toEqual(["babysit"]);
  });

  test("a session that is not live (exited or lost) gives no attach", () => {
    const onTurn: OnTurn = { actor: "me", reason: "answer agent", rule: 1 };
    expect(rowActions(item({ sessions: [session({ state: "exited" })] }), onTurn, context)).toEqual([]);
    expect(rowActions(item({ sessions: [session({ runtimeState: "lost" })] }), onTurn, context)).toEqual([]);
  });

  test("never delegable; launch actions carry the global profile, ready and attach none", () => {
    const actions = [
      ...rowActions(item({ sessions: [session({ worktreePath: "/wt/a" })] }), { actor: "me", reason: "fix CI", rule: 5 }, context),
      ...rowActions(item(), { actor: "me", reason: "leave draft", rule: 6 }, context),
    ];
    expect(actions).toEqual([
      { name: "fix-ci", delegable: false, profile: "profile-c" },
      { name: "attach", delegable: false },
      { name: "ready", delegable: false },
    ]);
  });

  test("a project [profiles] table replaces the global one whole; a missing profile is omitted", () => {
    const own = { ...context, project: { ...project, profiles: { implement: "project-x" } } };
    expect(rowActions(item(), { actor: "me", reason: "nothing runs", rule: 8 }, own)).toEqual([
      { name: "implement", delegable: false, profile: "project-x" },
    ]);
    expect(rowActions(item({ sessions: [owner] }), { actor: "me", reason: "respond", rule: 4 }, own)).toEqual([{ name: "babysit", delegable: false }]);
  });

  test("property: no rule, reason or session state ever lists merge", () => {
    const reasons = ["answer agent", "review", "respond", "fix CI", "rebase", "leave draft", "merge", "nothing runs", "check agent", "request review"] as const;
    const rules: RuleNumber[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    for (const rule of rules) {
      for (const reason of reasons) {
        for (const sessions of [[], [session()]]) {
          const names = rowActions(item({ sessions }), { actor: "me", reason, rule }, context).map((action) => action.name);
          expect(names).not.toContain("merge");
        }
      }
    }
  });

  test("end to end through the rules: a policy-only failure lists no action even with a worktree", () => {
    const policyOnly = pr({ checks: [check("Require label", "failure"), check("Require label", "failure")] });
    const row = buildListItem(item({ pullRequest: policyOnly, sessions: [owner] }), context);
    expect(row.on_turn).toEqual({ actor: "me", reason: "policy check: Require label", rule: 5 });
    expect(row.pull_request?.checks).toBe("failure");
    expect(row.actions).toEqual([]);
  });

  test("end to end through the rules: draft PR, started issue, idle agent, blocked agent", () => {
    expect(buildListItem(item({ pullRequest: pr({ isDraft: true }) }), context).actions).toEqual([{ name: "ready", delegable: false }]);
    const started = { key: "linear:ABC-1", issue: issue(), pullRequest: null, noIssue: false };
    expect(buildListItem(item(started), context).actions).toEqual([{ name: "implement", delegable: false, profile: "profile-a" }]);
    const idle = buildListItem(item({ ...started, sessions: [session()] }), context);
    expect(idle.on_turn.rule).toBe(11);
    expect(idle.actions).toEqual([{ name: "attach", delegable: false }]);
    const blocked = buildListItem(item({ sessions: [session()], notifications: [notification()] }), context);
    expect(blocked.on_turn.rule).toBe(1);
    expect(blocked.actions).toEqual([{ name: "attach", delegable: false }]);
  });

  test("a paused row lists no action, not even attach, while rules 1 and 2 keep theirs", () => {
    const conflicting = pr({ isDraft: true, mergeable: "CONFLICTING" });
    const pausedRow = { key: "linear:ABC-1", issue: issue({ state: "On hold", paused: true }), pullRequest: conflicting, joinedBy: "branch_pattern", noIssue: false } as const;
    const idleOwner = session({ worktreePath: "/wt/a" });
    const paused = buildListItem(item({ ...pausedRow, sessions: [idleOwner] }), context);
    expect(paused.on_turn).toEqual({ actor: "paused", reason: "paused", rule: 12 });
    expect(paused.issue?.state).toBe("On hold");
    expect(paused.actions).toEqual([]);
    expect(filterMine([paused])).toEqual([]);
    const working = buildListItem(item({ ...pausedRow, sessions: [session({ activity: "working", worktreePath: "/wt/a" })] }), context);
    expect(working.on_turn.rule).toBe(2);
    expect(working.actions).toEqual([{ name: "attach", delegable: false }]);
    const blocked = buildListItem(item({ ...pausedRow, sessions: [idleOwner], notifications: [notification()] }), context);
    expect(blocked.on_turn.rule).toBe(1);
    expect(blocked.actions).toEqual([{ name: "attach", delegable: false }]);
  });

  test("the table shows a paused row as paused with its rule", () => {
    const paused = buildListItem(item({ key: "linear:ABC-1", issue: issue({ state: "On hold", paused: true }), joinedBy: "branch_pattern", noIssue: false }), context);
    expect(renderTable([paused], [], [], new Set())).toContain("paused (r12)");
  });

  test("a rule 4 or 5 row without a worktree keeps its on_turn reason and lists no action", () => {
    const changesRequested = deliveredPr({ timeline: [] });
    const failing = pr({ checks: [check("build", "failure")] });
    const conflicting = pr({ mergeable: "CONFLICTING" });
    const cases: readonly [ReturnType<typeof pr>, OnTurn, string][] = [
      [changesRequested, { actor: "me", reason: "respond", rule: 4 }, "babysit"],
      [failing, { actor: "me", reason: "fix CI", rule: 5 }, "fix-ci"],
      [conflicting, { actor: "me", reason: "rebase", rule: 5 }, "rebase"],
    ];
    for (const [pullRequest, onTurn, action] of cases) {
      const bare = buildListItem(item({ pullRequest }), context);
      expect(bare.on_turn).toEqual(onTurn);
      expect(bare.actions).toEqual([]);
      const owned = buildListItem(item({ pullRequest, sessions: [owner] }), context);
      expect(owned.on_turn).toEqual(onTurn);
      expect(owned.actions.map((a) => a.name)).toEqual([action]);
    }
  });
});

test("the table names the issue of a secondary pull request row and of no other row", () => {
  const secondary = buildListItem(item({ key: "github:acme/widgets#14", pullRequest: pr({ id: "acme/widgets#14", number: 14 }), noIssue: false, issueKey: "ABC-1" }), context);
  const winner = buildListItem(item({ key: "linear:ABC-1", issue: issue(), noIssue: false, issueKey: "ABC-1" }), context);
  const plain = buildListItem(item(), context);
  expect(secondary.issue_key).toBe("ABC-1");
  expect(plain.issue_key).toBeNull();
  const lines = renderTable([secondary, winner, plain], [], [], new Set()).split("\n");
  expect(lines[1]).toStartWith("github:acme/widgets#14 (ABC-1)");
  expect(lines[2]).toStartWith("linear:ABC-1 ");
  expect(lines[3]).toStartWith("github:acme/widgets#12 (no issue)");
});

test("the table shows a github-issue row under its own key and names the issue on a secondary pull request row", () => {
  const issueRow = buildListItem(item({ key: "github-issue:acme/widgets#7", issue: issue({ id: "acme/widgets#7" }), noIssue: false, issueKey: "acme/widgets#7" }), context);
  const secondary = buildListItem(item({ key: "github:acme/widgets#14", pullRequest: pr({ id: "acme/widgets#14", number: 14 }), noIssue: false, issueKey: "acme/widgets#7" }), context);
  const lines = renderTable([issueRow, secondary], [], [], new Set()).split("\n");
  expect(lines[1]).toStartWith("github-issue:acme/widgets#7 ");
  expect(lines[1]).not.toContain("(acme/widgets#7)");
  expect(lines[2]).toStartWith("github:acme/widgets#14 (acme/widgets#7)");
});

test("implement is not listed on a github-issue row, while a linear row on rule 8 still lists it", () => {
  const github = buildListItem(item({ key: "github-issue:acme/widgets#7", issue: issue({ id: "acme/widgets#7" }), pullRequest: null, noIssue: false, issueKey: "acme/widgets#7" }), context);
  const linear = buildListItem(item({ key: "linear:ABC-1", issue: issue(), pullRequest: null, noIssue: false, issueKey: "ABC-1" }), context);
  expect(github.on_turn.rule).toBe(8);
  expect(github.actions).toEqual([]);
  expect(linear.actions.map((action) => action.name)).toEqual(["implement"]);
});
