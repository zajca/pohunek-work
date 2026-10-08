// A branch collision names the holder and offers attach, a release the cleanup checks accept, or nothing.
import { describe, expect, test } from "bun:test";
import { diagnoseBranchHolder } from "../../src/actions/branch-holder.ts";
import type { CollectedRow } from "../../src/commands/list.ts";
import { runDo } from "../../src/commands/do.ts";
import type { PohunekWorktree } from "../../src/sources/pohunek.ts";
import type { PohunekSession, SourceResult } from "../../src/types/sources.ts";
import { SpawnError, type ExecResult } from "../../src/util/exec.ts";
import { check, issue, pr, session } from "../rules/builders.ts";
import { baseConfig, expectRefusal, fail, ok, options, refusal, setup, type Harness, type World } from "./harness.ts";

const SHA = "a".repeat(40);
const BRANCH = "feature/x";
const PATH = "/wt/held";
const PULL_REQUEST = pr({ headRefName: BRANCH, headSha: SHA, checks: [check("build", "failure")] });
const KEY = `github:${PULL_REQUEST.id}`;
const CLEAN_STATUS = "!! node_modules/a.js\0!! target/debug/x\0";

type Answer = ExecResult | (() => ExecResult);

interface GitAnswers {
  prefix: Answer;
  status: Answer;
  symbolic: Answer;
  fetch: Answer;
  revList: Answer;
  staged: Answer;
  tagged: Answer;
}

function out(stdout: string, exitCode: number | null = 0, timedOut = false): ExecResult {
  return { exitCode, stdout, stderr: "", timedOut };
}

function defaultGit(): GitAnswers {
  return { prefix: out("\n"), status: out(CLEAN_STATUS), symbolic: out(`${BRANCH}\n`), fetch: out(""), revList: out("0\t0\n"), staged: out(""), tagged: out("") };
}

const HOLDER = session({ id: "s-held", state: "stopped", activity: null, branch: BRANCH, worktreePath: PATH, cwd: PATH, metadata: {} });

interface Scenario {
  holder?: Partial<PohunekSession>;
  git?: Partial<GitAnswers>;
  world?: Partial<World>;
  /** Overrides what `project show` lists; the default lists the holder's worktree owned by the holder. */
  worktrees?: () => SourceResult<readonly PohunekWorktree[]>;
}

interface Built {
  h: Harness;
  gitCalls: (readonly string[])[];
}

function build(scenario: Scenario = {}): Built {
  const git = { ...defaultGit(), ...scenario.git };
  const holder = { ...HOLDER, ...scenario.holder };
  const gitCalls: (readonly string[])[] = [];
  const answer = (value: Answer): ExecResult => (typeof value === "function" ? value() : value);
  const h = setup({
    prs: ok("github", [PULL_REQUEST]),
    sessions: [holder],
    worktrees: scenario.worktrees ?? (() => ok("pohunek", [{ path: PATH, branch: BRANCH, head: SHA, sessionId: holder.id }])),
    exec: (argv) => {
      gitCalls.push(argv);
      switch (argv[6]) {
        case "rev-parse":
          return answer(git.prefix);
        case "ls-files":
          return answer(argv[7] === "-v" ? git.tagged : git.staged);
        case "status":
          return answer(git.status);
        case "symbolic-ref":
          return answer(git.symbolic);
        case "fetch":
          return answer(git.fetch);
        case "rev-list":
          return answer(git.revList);
        default:
          throw new Error(`unexpected git command ${String(argv[6])}`);
      }
    },
    ...scenario.world,
  });
  return { h, gitCalls };
}

async function refused(built: Built, code: "precondition_failed" | "already_running" = "precondition_failed"): Promise<string> {
  const error = await refusal(runDo(baseConfig, options({ key: KEY, action: "fix-ci", profile: "profile-a" }), built.h.deps));
  expect(error.code).toBe(code);
  expect(built.h.launches).toHaveLength(0);
  expect(built.h.events.filter((e) => e.startsWith("stop:") || e.startsWith("rm:"))).toEqual([]);
  return error.message;
}

function expectNoRemovalCommand(message: string): void {
  expect(message).not.toContain("session rm");
  expect(message).not.toContain("cleanup`");
  expect(message).toContain("No removal command is offered");
}

describe("a finished holder (D1, D3)", () => {
  test("clean, in sync and unlinked: named with session, state and path, and safe to release with session rm", async () => {
    const built = build({ git: { status: out("!! a.log\0!! b.log\0!! c.log\0") } });
    const message = await refused(built);
    expect(message).toContain('"s-held"');
    expect(message).toContain('"stopped"');
    expect(message).toContain(`"${PATH}"`);
    expect(message).toContain(`"${BRANCH}" is already checked out`);
    expect(message).toContain("can be released with `pohunek session rm s-held`");
    expect(message).toContain("3 ignored entries are lost");
    expect(message).toContain("`do` itself removes nothing");
    expect(message).not.toContain("attach");
  });

  test("the diagnosis runs git read-only and removes nothing", async () => {
    const built = build();
    await refused(built);
    const verbs = built.gitCalls.map((argv) => argv[6]);
    expect(verbs).toEqual(["rev-parse", "status", "ls-files", "ls-files", "symbolic-ref", "fetch", "rev-list"]);
    expect(built.h.commands).toEqual(built.gitCalls);
  });
});

describe("a live holder (D2)", () => {
  test("an unlinked live holder is offered pohunek attach", async () => {
    const message = await refused(build({ holder: { state: "running", activity: "idle" } }));
    expect(message).toContain('"s-held"');
    expect(message).toContain('"running"');
    expect(message).toContain(`"${PATH}"`);
    expect(message).toContain("the session is live: attach with `pohunek attach s-held`");
    expect(message).not.toContain("session rm");
  });

  test("a live holder needs no git", async () => {
    const built = build({ holder: { state: "running", activity: "working" } });
    await refused(built);
    expect(built.gitCalls).toEqual([]);
  });

  test("a live holder reached through project show is offered attach too", async () => {
    const stranger = session({ id: "s-held", projectLabel: "gadgets", state: "running", activity: "idle", branch: BRANCH, worktreePath: PATH, metadata: {} });
    const message = await refused(build({ holder: stranger }));
    expect(message).toContain("`pohunek attach s-held`");
  });

  test("already_running names the attach command of the linked live session", async () => {
    const live = session({ id: "s-live", activity: "idle", metadata: { "work.link.id": "ABC-1", "work.link.provider": "linear", "work.role": "implement" }, worktreePath: "/wt/owner" });
    const waiting = pr({ headRefName: "alice/ABC-1/x", reviewRequests: [{ kind: "user", login: "someone" }] });
    const { deps } = setup({ issues: ok("linear", [issue()]), prs: ok("github", [waiting]), sessions: [live] });
    await expectRefusal(runDo(baseConfig, options({ key: "linear:ABC-1", action: "babysit", profile: "profile-a" }), deps), "already_running", "attach with `pohunek-work do linear:ABC-1 attach --project widgets`");
  });

  test("already_running names pohunek attach for a live session of someone else in the worktree", async () => {
    const owner = session({ id: "s-o", state: "stopped", activity: null, worktreePath: "/wt/o", metadata: { "work.link.id": PULL_REQUEST.id, "work.link.provider": "github" } });
    const stranger = session({ id: "s-stranger", activity: "idle", cwd: "/wt/o", metadata: {} });
    const { deps } = setup({ prs: ok("github", [PULL_REQUEST]), sessions: [owner, stranger] });
    await expectRefusal(runDo(baseConfig, options({ key: KEY, action: "fix-ci", profile: "profile-a" }), deps), "already_running", "attach with `pohunek attach s-stranger`");
  });
});

describe("a holder no pohunek session owns (D5)", () => {
  test("the primary checkout is refused with the switch instruction and never offered for release", async () => {
    const built = build({
      holder: { projectLabel: "gadgets" },
      worktrees: () => ok("pohunek", [{ path: "/repo/main", branch: BRANCH, head: SHA, sessionId: null }]),
      world: { sessions: [] },
    });
    const message = await refused(built);
    expect(message).toContain('"/repo/main"');
    expect(message).toContain("no pohunek session owns");
    expect(message).toContain("switch that checkout to another branch yourself");
    expect(message).not.toContain("session rm");
    expect(message).not.toContain("cleanup");
    expect(built.gitCalls).toEqual([]);
  });
});

describe("a holder that cannot be released safely (D4)", () => {
  test("tracked and untracked changes are named and no removal command is offered", async () => {
    const message = await refused(build({ git: { status: out(" M src/a.ts\0?? notes.txt\0!! build/x\0") } }));
    expect(message).toContain("worktree_clean");
    expect(message).toContain("2 uncommitted or untracked entries");
    expect(message).toContain('"src/a.ts", "notes.txt"');
    expect(message).not.toContain("build/x");
    expectNoRemovalCommand(message);
    expect(message).toContain('"s-held"');
    expect(message).toContain(`"${PATH}"`);
  });

  test("unpushed commits fail branch_in_sync", async () => {
    const message = await refused(build({ git: { revList: out("2\t0\n") } }));
    expect(message).toContain("branch_in_sync");
    expect(message).toContain("2 ahead, 0 behind origin");
    expectNoRemovalCommand(message);
  });

  test("a failing git command is uncertain evidence", async () => {
    for (const git of [{ status: out("", 128) }, { status: out("", null, true) }, { fetch: out("", 1) }, { revList: out("", 1) }, { symbolic: out("", 1) }]) {
      const message = await refused(build({ git }));
      expectNoRemovalCommand(message);
    }
  });

  test("git that cannot start is uncertain evidence", async () => {
    const message = await refused(build({ world: { exec: () => { throw new SpawnError("/usr/bin/git", new Error("ENOENT")); } } }));
    expect(message).toContain("git could not start");
    expectNoRemovalCommand(message);
  });

  test("an unexpected exec failure is reported without its message", async () => {
    const message = await refused(build({ world: { exec: () => { throw new Error("secret detail"); } } }));
    expect(message).toContain("evidence");
    expect(message).not.toContain("secret detail");
    expectNoRemovalCommand(message);
  });

  test("an unparsable status is uncertain evidence", async () => {
    const message = await refused(build({ git: { status: out("garbage without terminator") } }));
    expect(message).toContain("git status output could not be parsed");
    expectNoRemovalCommand(message);
  });

  test("a parsed rev-list that is not a count pair is uncertain evidence", async () => {
    const message = await refused(build({ git: { revList: out("nope\n") } }));
    expect(message).toContain("branch_in_sync");
    expectNoRemovalCommand(message);
  });

  test("unreadable project show fails the ownership check", async () => {
    const message = await refused(build({ worktrees: () => fail("pohunek", "unavailable") }));
    expect(message).toContain("worktree_owned");
    expectNoRemovalCommand(message);
  });

  test("unreadable notifications fail not_awaiting_owner", async () => {
    // The first read belongs to resolving the row; the diagnosis reads them again.
    let reads = 0;
    const message = await refused(build({ world: { notifications: () => (++reads === 1 ? ok("pohunek", []) : fail("pohunek", "timeout")) } }));
    expect(message).toContain("not_awaiting_owner");
    expectNoRemovalCommand(message);
  });

  test("a holder that is not finished is refused", async () => {
    const message = await refused(build({ holder: { state: "starting", activity: null } }));
    expect(message).toContain("session_finished");
    expect(message).toContain('"starting"');
    expectNoRemovalCommand(message);
  });

  test("a session pohunek does not list is refused", async () => {
    const built = build({
      worktrees: () => ok("pohunek", [{ path: PATH, branch: BRANCH, head: SHA, sessionId: "s-ghost" }]),
      holder: { projectLabel: "gadgets", id: "s-other" },
    });
    const message = await refused(built);
    expect(message).toContain('"s-ghost"');
    expect(message).toContain("holder_session");
    expectNoRemovalCommand(message);
    expect(built.gitCalls).toEqual([]);
  });

  test("a session whose own worktree is another path is refused before git runs", async () => {
    const built = build({
      holder: { projectLabel: "gadgets", worktreePath: "/wt/elsewhere" },
      worktrees: () => ok("pohunek", [{ path: PATH, branch: BRANCH, head: SHA, sessionId: "s-held" }]),
    });
    const message = await refused(built);
    expect(message).toContain("holder_session");
    expectNoRemovalCommand(message);
    expect(built.gitCalls).toEqual([]);
  });

  test("a session id that is not a plain id gets no command", async () => {
    const message = await refused(build({ holder: { id: "--force" } }));
    expect(message).toContain('"--force"');
    expect(message).not.toContain("session rm --force");
    expectNoRemovalCommand(message);
  });

  test("a long list of entries is bounded by holder_entries_listed", async () => {
    const files = Array.from({ length: 12 }, (_unused, index) => `file-${String(index).padStart(2, "0")}.txt`);
    const message = await refused(build({ git: { status: out(files.map((f) => `?? ${f}\0`).join("")) } }));
    expect(baseConfig.global.actions.holderEntriesListed).toBe(5);
    expect(message).toContain('"file-00.txt", "file-01.txt", "file-02.txt", "file-03.txt", "file-04.txt" and 7 more');
    expect(message).not.toContain("file-05.txt");
  });

  test("a path is JSON-quoted, ASCII-only and cut at holder_entry_max_length", async () => {
    const hostile = "evil\u001b[31m\nname ‮č😀.txt";
    const long = `${"x".repeat(200)}.txt`;
    const message = await refused(build({ git: { status: out(`?? ${hostile}\0?? ${long}\0`) } }));
    expect(message).toContain("evil\\u001b[31m\\nname ");
    expect(/[^\x20-\x7e]/.test(message)).toBe(false);
    expect(message).not.toContain("x".repeat(100));
    expect(message).toContain(`"${"x".repeat(baseConfig.global.actions.holderEntryMaxLength)}..."`);
  });

  test("quotes and backslashes in a path cannot close the quoted string", async () => {
    const message = await refused(build({ git: { status: out('?? a", "forged\\\0') } }));
    expect(message).toContain('"a\\", \\"forged\\\\"');
  });
});

describe("linked holders and the release command (D3)", () => {
  function fakeRow(sessions: readonly PohunekSession[]): CollectedRow {
    return { listItem: { key: "linear:ABC-1" }, item: { sessions }, project: { pohunekLabel: "widgets" } } as unknown as CollectedRow;
  }

  function context(sessionsOfRow: readonly PohunekSession[], all: readonly PohunekSession[]): Parameters<typeof diagnoseBranchHolder>[1] {
    const built = build({ world: { sessions: all } });
    return { row: fakeRow(sessionsOfRow), scope: { project: null, includeIgnored: false }, sessions: all, config: baseConfig, deps: { pohunek: built.h.deps.pohunek, exec: built.h.deps.exec } };
  }

  const holder = { path: PATH, branch: BRANCH, sessionId: "s-held" };

  test("the one linked session that owns a worktree is released with do cleanup", async () => {
    const text = await diagnoseBranchHolder(holder, context([HOLDER], [HOLDER]));
    expect(text).toContain("can be released with `pohunek-work do linear:ABC-1 cleanup`");
    expect(text).toContain("`cleanup` checks everything again");
  });

  test("several linked sessions that own a worktree make do cleanup ambiguous, so session rm is named", async () => {
    const second = session({ id: "s-second", state: "stopped", activity: null, worktreePath: "/wt/second", metadata: {} });
    const text = await diagnoseBranchHolder(holder, context([HOLDER, second], [HOLDER, second]));
    expect(text).toContain("can be released with `pohunek session rm s-held`");
  });

  test("a live linked holder is offered do attach", async () => {
    const live = { ...HOLDER, state: "running", activity: "idle" };
    const text = await diagnoseBranchHolder(holder, context([live], [live]));
    expect(text).toContain("attach with `pohunek-work do linear:ABC-1 attach`");
  });

  test("a live holder next to another live linked session is offered pohunek attach", async () => {
    const live = { ...HOLDER, state: "running", activity: "idle" };
    const other = session({ id: "s-other", activity: "idle", metadata: {} });
    const text = await diagnoseBranchHolder(holder, context([live, other], [live, other]));
    expect(text).toContain("attach with `pohunek attach s-held`");
  });
});

describe("the evidence is re-validated against a fresh session list (offer for an unlinked holder)", () => {
  /** After git has been read, `session list` answers with `later`. */
  function changing(later: () => SourceResult<readonly PohunekSession[]>): Built {
    const built: Built = build({
      world: { listSessions: () => (built.gitCalls.some((argv) => argv[6] === "rev-list") ? later() : ok("pohunek", [HOLDER])) },
    });
    return built;
  }

  test("an unchanged list keeps the offer and warns that session rm force-removes without a recheck", async () => {
    const message = await refused(changing(() => ok("pohunek", [HOLDER])));
    expect(message).toContain("can be released with `pohunek session rm s-held`");
    expect(message).toContain("when this was read");
    expect(message).toContain("force-removes the worktree and does not recheck");
    expect(message).toContain("`pohunek session list` immediately before");
  });

  test("a writer that started in the worktree meanwhile turns the offer into a refusal", async () => {
    const writer = session({ id: "s-writer", state: "running", activity: "working", cwd: PATH, worktreePath: PATH, branch: BRANCH, metadata: {} });
    const message = await refused(changing(() => ok("pohunek", [HOLDER, writer])));
    expect(message).toContain("evidence_stale");
    expectNoRemovalCommand(message);
  });

  test("the holder running again turns the offer into a refusal", async () => {
    const message = await refused(changing(() => ok("pohunek", [{ ...HOLDER, state: "running", activity: "working" }])));
    expect(message).toContain("evidence_stale");
    expect(message).toContain("running again");
    expectNoRemovalCommand(message);
  });

  test("the holder gone from the list turns the offer into a refusal", async () => {
    const message = await refused(changing(() => ok("pohunek", [])));
    expect(message).toContain("evidence_stale");
    expectNoRemovalCommand(message);
  });

  test("a session in another worktree turns the offer into a refusal", async () => {
    const message = await refused(changing(() => ok("pohunek", [{ ...HOLDER, worktreePath: "/wt/elsewhere" }])));
    expect(message).toContain("evidence_stale");
    expectNoRemovalCommand(message);
  });

  test("an unreadable re-read turns the offer into a refusal", async () => {
    const message = await refused(changing(() => fail("pohunek", "timeout")));
    expect(message).toContain("evidence_stale");
    expect(message).toContain("could not be re-read");
    expectNoRemovalCommand(message);
  });
});

describe("suggested commands carry the options of the launch", () => {
  const holder = { path: PATH, branch: BRANCH, sessionId: "s-held" };
  const linkedRow = { listItem: { key: "linear:ABC-1" }, item: { sessions: [HOLDER] }, project: { pohunekLabel: "widgets" } } as unknown as CollectedRow;

  function diagnose(row: CollectedRow, scope: { project: string | null; includeIgnored: boolean }, held: PohunekSession): Promise<string> {
    const built = build({ world: { sessions: [held] } });
    return diagnoseBranchHolder(holder, { row, scope, sessions: [held], config: baseConfig, deps: { pohunek: built.h.deps.pohunek, exec: built.h.deps.exec } });
  }

  test("--project and --include-ignored are repeated on the release command", async () => {
    const text = await diagnose(linkedRow, { project: "widgets", includeIgnored: true }, HOLDER);
    expect(text).toContain("`pohunek-work do linear:ABC-1 cleanup --project widgets --include-ignored`");
  });

  test("no options are added when the launch had none", async () => {
    const text = await diagnose(linkedRow, { project: null, includeIgnored: false }, HOLDER);
    expect(text).toContain("`pohunek-work do linear:ABC-1 cleanup`");
  });

  test("the attach command of a live linked holder repeats the options", async () => {
    const live = { ...HOLDER, state: "running", activity: "idle" };
    const row = { ...linkedRow, item: { sessions: [live] } } as unknown as CollectedRow;
    const text = await diagnose(row, { project: "widgets", includeIgnored: true }, live);
    expect(text).toContain("`pohunek-work do linear:ABC-1 attach --project widgets --include-ignored`");
  });

  test("a project label is shell-quoted, and one that cannot be shown falls back to pohunek", async () => {
    const live = { ...HOLDER, state: "running", activity: "idle" };
    const row = { ...linkedRow, item: { sessions: [live] } } as unknown as CollectedRow;
    expect(await diagnose(row, { project: "my project; rm -rf x", includeIgnored: false }, live)).toContain("attach --project 'my project; rm -rf x'`");
    expect(await diagnose(row, { project: "pro\u010Dekt", includeIgnored: false }, live)).toContain("`pohunek attach s-held`");
  });

  test("the already_running refusal repeats --include-ignored", async () => {
    const live = session({ id: "s-live", activity: "idle", metadata: { "work.link.id": "ABC-1", "work.link.provider": "linear", "work.role": "implement" }, worktreePath: "/wt/owner" });
    const waiting = pr({ headRefName: "alice/ABC-1/x", reviewRequests: [{ kind: "user", login: "someone" }] });
    const { deps } = setup({ issues: ok("linear", [issue()]), prs: ok("github", [waiting]), sessions: [live] });
    await expectRefusal(
      runDo(baseConfig, options({ key: "linear:ABC-1", action: "babysit", profile: "profile-a", includeIgnored: true }), deps),
      "already_running",
      "`pohunek-work do linear:ABC-1 attach --project widgets --include-ignored`",
    );
  });
});

describe("compatibility characters cannot forge a quoted field", () => {
  test("a fullwidth quote and backslash stay inside the quoted string", async () => {
    const message = await refused(build({ git: { status: out("?? a\uFF02, \uFF02forged\uFF3C\0") } }));
    expect(message).toContain('"a\\", \\"forged\\\\"');
    expect(message).not.toContain('"a", "forged');
  });
});
