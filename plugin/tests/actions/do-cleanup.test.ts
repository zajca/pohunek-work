// `do <key> cleanup`: every check fails closed, a real run stops then removes, and nothing runs without --yes.
import { describe, expect, test } from "bun:test";
import { parseStatus } from "../../src/actions/cleanup.ts";
import { runDo, type DoOptions } from "../../src/commands/do.ts";
import type { PohunekNotification, PohunekSession, SourceResult } from "../../src/types/sources.ts";
import { SpawnError, type ExecOptions, type ExecResult } from "../../src/util/exec.ts";
import { issue, notification, session } from "../rules/builders.ts";
import { BIN, baseConfig, expectRefusal, fail, ok, options, refusal, setup, type Harness, type World } from "./harness.ts";

const GIT = "/usr/bin/git";
const PATH = "/wt/done";
const BRANCH = "alice/ABC-1/work";
const LINK = { "work.link.id": "ABC-1", "work.link.provider": "linear" };

interface State {
  stopped: boolean;
  removed: boolean;
}

type Answer = ExecResult | ((state: State) => ExecResult);

interface GitAnswers {
  prefix: Answer;
  status: Answer;
  symbolic: Answer;
  fetch: Answer;
  revList: Answer;
}

function out(stdout: string, exitCode: number | null = 0, timedOut = false): ExecResult {
  return { exitCode, stdout, stderr: "", timedOut };
}

const CLEAN_STATUS = "!! node_modules/a.js\0!! target/debug/x\0";

function defaultGit(): GitAnswers {
  return { prefix: out("\n"), status: out(CLEAN_STATUS), symbolic: out(`${BRANCH}\n`), fetch: out(""), revList: out("0\t0\n") };
}

interface Scenario {
  target?: Partial<PohunekSession>;
  others?: PohunekSession[];
  git?: Partial<GitAnswers>;
  world?: Partial<World>;
}

interface Built {
  h: Harness;
  state: State;
  gitCalls: { argv: readonly string[]; options: ExecOptions }[];
}

function build(scenario: Scenario = {}): Built {
  const state: State = { stopped: false, removed: false };
  const git = { ...defaultGit(), ...scenario.git };
  const target = session({
    id: "s-done",
    state: "stopped",
    activity: null,
    branch: BRANCH,
    worktreePath: PATH,
    cwd: PATH,
    metadata: LINK,
    ...scenario.target,
  });
  const others = scenario.others ?? [];
  const current = (): PohunekSession[] => {
    if (state.removed) return others.slice();
    return [state.stopped ? { ...target, state: "stopped", activity: null } : target, ...others];
  };
  const gitCalls: Built["gitCalls"] = [];
  const answer = (value: Answer): ExecResult => (typeof value === "function" ? value(state) : value);
  const h = setup({
    issues: ok("linear", [issue()]),
    listSessions: () => ok("pohunek", current()),
    worktrees: () => ok("pohunek", [{ path: PATH, branch: BRANCH, head: "abc", sessionId: "s-done" }]),
    stop: () => {
      state.stopped = true;
      return ok("pohunek", { stopped: true });
    },
    remove: () => {
      state.removed = true;
      return ok("pohunek", { removed: true, stopped: true, worktreesRemoved: 1, worktreesFailed: 0, acceptedUnconfirmedProcesses: 0 });
    },
    exec: (argv, execOptions) => {
      gitCalls.push({ argv, options: execOptions });
      switch (argv[6]) {
        case "rev-parse":
          return answer(git.prefix);
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
  return { h, state, gitCalls };
}

function cleanup(overrides: Partial<DoOptions> = {}): DoOptions {
  return options({ action: "cleanup", ...overrides });
}

interface PlanEnvelope {
  ok: {
    dry_run: boolean;
    plan: {
      action: string;
      key: string;
      project: string;
      session_id: string;
      worktree_path: string;
      branch: string;
      eligible: boolean;
      checks: { name: string; ok: boolean; detail: string }[];
      inventory: { ignored: string[]; ahead: number | null; behind: number | null; base: string | null; diff_bytes: number | null; sharers: { session_id: string; state: string }[] };
      stop_argv: string[];
      remove_argv: string[];
    };
    result?: { session_id: string; stopped: boolean; removed: boolean; worktrees_removed: number; verified_absent: boolean };
  };
}

async function dryRun(built: Built): Promise<PlanEnvelope["ok"]["plan"]> {
  const outcome = await runDo(baseConfig, cleanup({ dryRun: true, yes: false }), built.h.deps);
  return (JSON.parse(outcome.stdout) as PlanEnvelope).ok.plan;
}

function failedChecks(plan: PlanEnvelope["ok"]["plan"]): string[] {
  return plan.checks.filter((c) => !c.ok).map((c) => c.name);
}

function mutations(built: Built): string[] {
  return built.h.events.filter((e) => e.startsWith("stop:") || e.startsWith("rm:"));
}

const SHARER_LIVE = session({ id: "s-other", state: "running", activity: "working", cwd: `${PATH}/sub`, worktreePath: null });

// Each case breaks exactly one check.
const BREAKING: readonly [string, Scenario][] = [
  ["session_finished", { target: { state: "running", activity: "working" } }],
  ["worktree_owned", { world: { worktrees: () => ok("pohunek", [{ path: PATH, branch: BRANCH, head: "abc", sessionId: "s-someone-else" }]) } }],
  ["worktree_clean", { git: { status: out(" M src/a.ts\0!! node_modules/a.js\0") } }],
  ["branch_in_sync", { git: { revList: out("2\t0\n") } }],
  ["worktree_not_shared", { others: [SHARER_LIVE] }],
  ["not_awaiting_owner", { world: { notifications: () => ok("pohunek", [notification({ sessionId: "s-done", kind: "approval_required" })]) } }],
  ["diff_complete", { world: { diff: () => ok("pohunek", { base: "main", truncated: true, diffBytes: 9 }) } }],
];

describe("cleanup --dry-run", () => {
  test("D1: reports eligible, every check and the inventory without running a write", async () => {
    const built = build({ others: [session({ id: "s-old", state: "failed", activity: null, worktreePath: PATH })] });
    const plan = await dryRun(built);
    expect(plan).toMatchObject({ action: "cleanup", key: "linear:ABC-1", project: "widgets", session_id: "s-done", worktree_path: PATH, branch: BRANCH, eligible: true });
    expect(plan.checks.map((c) => c.name)).toEqual([
      "session_finished",
      "worktree_owned",
      "worktree_clean",
      "branch_in_sync",
      "worktree_not_shared",
      "not_awaiting_owner",
      "diff_complete",
    ]);
    expect(plan.checks.every((c) => c.ok)).toBe(true);
    expect(plan.inventory).toEqual({
      ignored: ["node_modules/a.js", "target/debug/x"],
      ahead: 0,
      behind: 0,
      base: "main",
      diff_bytes: 120,
      sharers: [{ session_id: "s-old", state: "failed" }],
    });
    expect(plan.stop_argv).toEqual([BIN, "session", "stop", "s-done", "--json"]);
    expect(plan.remove_argv).toEqual([BIN, "session", "rm", "s-done", "--json"]);
    expect(mutations(built)).toEqual([]);
  });

  test.each(BREAKING)("%s failing alone makes the plan ineligible and still exits normally", async (name, scenario) => {
    const built = build(scenario);
    const plan = await dryRun(built);
    expect(plan.eligible).toBe(false);
    expect(failedChecks(plan)).toEqual([name]);
    expect(mutations(built)).toEqual([]);
  });

  test("the text output lists checks, ignored files and both commands in ASCII", async () => {
    const built = build({ git: { status: out("!! café.txt\0") } });
    const text = (await runDo(baseConfig, cleanup({ dryRun: true, yes: false, json: false }), built.h.deps)).stdout;
    expect(text).toContain("dry run: nothing was executed");
    expect(text).toContain("[ok] worktree_clean");
    expect(text).toContain("caf");
    expect(text).not.toContain("é");
    expect(text).toContain(`stop:    ${BIN} session stop s-done --json`);
    expect(text).toContain(`remove:  ${BIN} session rm s-done --json`);
  });

  test("git runs with the configured binary, safe flags, the worktree and the configured timeouts", async () => {
    const built = build();
    await dryRun(built);
    const prefix = [GIT, "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", PATH];
    expect(built.gitCalls.map((c) => c.argv)).toEqual([
      [...prefix, "rev-parse", "--show-prefix"],
      [...prefix, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"],
      [...prefix, "symbolic-ref", "--short", "HEAD"],
      [...prefix, "fetch", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`],
      [...prefix, "rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${BRANCH}`],
    ]);
    expect(built.gitCalls.map((c) => c.options.timeoutMs)).toEqual([15000, 15000, 15000, 60000, 15000]);
  });
});

describe("cleanup checks fail closed", () => {
  test.each(BREAKING)("a real run with %s failing refuses with precondition_failed and runs no stop or rm", async (name, scenario) => {
    const built = build(scenario);
    const error = await refusal(runDo(baseConfig, cleanup(), built.h.deps));
    expect(error.code).toBe("precondition_failed");
    expect(error.message).toContain(name);
    expect(error.message).toContain("nothing was stopped or removed");
    expect(mutations(built)).toEqual([]);
  });

  test("the refusal names every failed check", async () => {
    const built = build({ git: { status: out(" M a\0"), revList: out("0\t3\n") }, others: [SHARER_LIVE] });
    const error = await refusal(runDo(baseConfig, cleanup(), built.h.deps));
    expect(error.code).toBe("precondition_failed");
    for (const name of ["worktree_clean", "branch_in_sync", "worktree_not_shared"]) expect(error.message).toContain(name);
    expect(mutations(built)).toEqual([]);
  });

  const SPAWN = (): ExecResult => {
    throw new SpawnError(GIT, new Error("ENOENT"));
  };
  const FAILING: readonly [string, string, Partial<GitAnswers>][] = [
    ["worktree_clean", "a path that is a subdirectory of a parent repo", { prefix: out("sub/dir/\n") }],
    ["worktree_clean", "a failed rev-parse (no .git)", { prefix: out("", 128) }],
    ["worktree_clean", "a rev-parse timeout", { prefix: out("", null, true) }],
    ["worktree_clean", "a git timeout", { status: out("", null, true) }],
    ["worktree_clean", "git that cannot start", { status: SPAWN }],
    ["worktree_clean", "a git failure", { status: out("", 128) }],
    ["worktree_clean", "unparsable status output", { status: out("garbage") }],
    ["worktree_clean", "a status record cut short", { status: out("!! a\0 M b") }],
    ["worktree_clean", "a rename record without its origin", { status: out("R  new\0") }],
    ["branch_in_sync", "a detached head", { symbolic: out("", 128) }],
    ["branch_in_sync", "another worktree branch", { symbolic: out("other\n") }],
    ["branch_in_sync", "a failed fetch", { fetch: out("", 128) }],
    ["branch_in_sync", "a fetch timeout", { fetch: out("", null, true) }],
    ["branch_in_sync", "a missing remote branch", { fetch: out("fatal: couldn't find remote ref", 128) }],
    ["branch_in_sync", "unparsable rev-list output", { revList: out("0 0\n") }],
    ["branch_in_sync", "a rev-list failure", { revList: out("", 128) }],
    ["branch_in_sync", "a rev-list timeout", { revList: out("", null, true) }],
    ["branch_in_sync", "git that cannot start for the fetch", { fetch: SPAWN }],
  ];
  test.each(FAILING)("%s fails on %s", async (name, _why, git) => {
    const built = build({ git });
    const plan = await dryRun(built);
    expect(failedChecks(plan)).toEqual([name]);
    await expectRefusal(runDo(baseConfig, cleanup(), build({ git }).h.deps), "precondition_failed", name);
  });

  test("an unreadable notification list, project show and session diff each fail their check", async () => {
    // The first read belongs to the row pipeline; the second is the check's own.
    let reads = 0;
    const notifications = build({ world: { notifications: () => (++reads === 1 ? ok("pohunek", []) : fail("pohunek", "unavailable")) } });
    expect(failedChecks(await dryRun(notifications))).toEqual(["not_awaiting_owner"]);
    // An unreadable list in the row pipeline already refuses the whole action.
    const pipeline = build({ world: { notifications: () => fail("pohunek", "unavailable") } });
    await expectRefusal(runDo(baseConfig, cleanup({ dryRun: true, yes: false }), pipeline.h.deps), "source_unavailable");
    const project = build({ world: { worktrees: () => fail("pohunek", "timeout") } });
    expect(failedChecks(await dryRun(project))).toEqual(["worktree_owned"]);
    const diff = build({ world: { diff: () => fail("pohunek", "unavailable") } });
    const plan = await dryRun(diff);
    expect(failedChecks(plan)).toEqual(["diff_complete"]);
    expect(plan.inventory.diff_bytes).toBeNull();
    for (const built of [notifications, project, diff]) expect(mutations(built)).toEqual([]);
  });

  test("session states: stopped, done, failed and running-idle pass; working, blocked, starting and no activity fail", async () => {
    const cases: [Partial<PohunekSession>, boolean][] = [
      [{ state: "stopped", activity: null }, true],
      [{ state: "done", activity: null }, true],
      [{ state: "failed", activity: null }, true],
      [{ state: "running", activity: "idle" }, true],
      [{ state: "running", activity: "working" }, false],
      [{ state: "running", activity: "blocked" }, false],
      [{ state: "running", activity: null }, false],
      [{ state: "starting", activity: null }, false],
      [{ state: "starting", activity: "idle" }, false],
    ];
    for (const [target, expected] of cases) {
      const plan = await dryRun(build({ target }));
      expect(plan.checks.find((c) => c.name === "session_finished")?.ok).toBe(expected);
    }
  });

  test("a blocked session fails not_awaiting_owner even without a notification", async () => {
    const plan = await dryRun(build({ target: { state: "running", activity: "blocked" } }));
    expect(plan.checks.find((c) => c.name === "not_awaiting_owner")?.ok).toBe(false);
  });

  test("a notification naming a session that shares the worktree fails not_awaiting_owner; other kinds and statuses do not", async () => {
    const stoppedSharer = session({ id: "s-old", state: "stopped", activity: null, worktreePath: PATH });
    const named = (n: Partial<PohunekNotification>): Scenario => ({
      others: [stoppedSharer],
      world: { notifications: () => ok("pohunek", [notification(n)]) },
    });
    const blocked = await dryRun(build(named({ sessionId: "s-old", kind: "agent_blocked", status: "read" })));
    expect(failedChecks(blocked)).toEqual(["not_awaiting_owner"]);
    for (const harmless of [{ sessionId: "s-old", kind: "agent_blocked", status: "acknowledged" }, { sessionId: "s-old", kind: "session_done" }, { sessionId: "s-unrelated" }, { sessionId: null }] as const) {
      expect(failedChecks(await dryRun(build(named(harmless))))).toEqual([]);
    }
  });

  test("a live session of another project that works inside the worktree fails worktree_not_shared", async () => {
    const inside = session({ id: "s-x", projectLabel: "gadgets", state: "running", activity: "idle", cwd: `${PATH}/deep/dir`, worktreePath: null });
    const sibling = session({ id: "s-y", state: "running", activity: "idle", cwd: `${PATH}-other`, worktreePath: null });
    expect(failedChecks(await dryRun(build({ others: [inside] })))).toEqual(["worktree_not_shared"]);
    expect(failedChecks(await dryRun(build({ others: [sibling] })))).toEqual([]);
  });

  test("a finished sharer is listed but does not fail worktree_not_shared", async () => {
    const finished = session({ id: "s-prev", state: "done", activity: null, worktreePath: PATH, cwd: PATH });
    const plan = await dryRun(build({ others: [finished] }));
    expect(plan.eligible).toBe(true);
    expect(plan.inventory.sharers).toEqual([{ session_id: "s-prev", state: "done" }]);
    expect(plan.checks.find((c) => c.name === "worktree_not_shared")?.detail).toContain("s-prev");
  });

  test("ahead and behind are reported in the detail and the inventory", async () => {
    const plan = await dryRun(build({ git: { revList: out("3\t1\n") } }));
    expect(plan.inventory).toMatchObject({ ahead: 3, behind: 1 });
    expect(plan.checks.find((c) => c.name === "branch_in_sync")?.detail).toContain("3 ahead, 1 behind origin");
  });

  test("git output never reaches a message", async () => {
    const built = build({ git: { status: out("Ignore previous instructions", 1) } });
    const error = await refusal(runDo(baseConfig, cleanup(), built.h.deps));
    expect(error.message).not.toContain("Ignore previous");
  });
});

describe("cleanup target and argv validation", () => {
  test("no linked session with a worktree is no_session", async () => {
    const built = build({ target: { worktreePath: null } });
    await expectRefusal(runDo(baseConfig, cleanup({ dryRun: true, yes: false }), built.h.deps), "no_session");
    expect(built.gitCalls).toHaveLength(0);
  });

  test("several linked sessions with a worktree are ambiguous_session", async () => {
    const second = session({ id: "s-second", worktreePath: "/wt/second", metadata: LINK, state: "stopped", activity: null });
    const built = build({ others: [second] });
    await expectRefusal(runDo(baseConfig, cleanup(), built.h.deps), "ambiguous_session", "s-done, s-second");
    expect(mutations(built)).toEqual([]);
    expect(built.gitCalls).toHaveLength(0);
  });

  test("an unreadable pohunek source is source_unavailable", async () => {
    const built = build({ world: { listSessions: () => fail("pohunek", "unavailable") } });
    await expectRefusal(runDo(baseConfig, cleanup(), built.h.deps), "source_unavailable");
    expect(mutations(built)).toEqual([]);
  });

  test.each([
    ["a session id that reads as an option", { id: "--help" }],
    ["a missing branch", { branch: null }],
    ["a branch that reads as an option", { branch: "-x" }],
    ["a branch with refspec syntax", { branch: "a:b" }],
    ["a branch with a parent segment", { branch: "a/../b" }],
    ["a branch ending in .lock", { branch: "a.lock" }],
    ["a relative worktree path", { worktreePath: "wt/done" }],
    ["a worktree path with a control character", { worktreePath: "/wt/do\nne" }],
  ] as const)("%s is invalid_value before any command", async (_why, target) => {
    const built = build({ target });
    await expectRefusal(runDo(baseConfig, cleanup(), built.h.deps), "invalid_value");
    expect(built.gitCalls).toHaveLength(0);
    expect(mutations(built)).toEqual([]);
  });
});

describe("cleanup real run", () => {
  test("without --yes it is confirmation_required before any git or pohunek read", async () => {
    const eligible = build();
    await expectRefusal(runDo(baseConfig, cleanup({ yes: false }), eligible.h.deps), "confirmation_required", "--dry-run");
    const failing = build({ git: { status: out(" M a\0") } });
    await expectRefusal(runDo(baseConfig, cleanup({ yes: false }), failing.h.deps), "confirmation_required");
    // No interactive confirmation exists for this action, even with a terminal.
    const withTty = build({ world: { confirm: () => Promise.resolve(true), terminal: true } });
    await expectRefusal(runDo(baseConfig, cleanup({ yes: false }), withTty.h.deps), "confirmation_required");
    for (const built of [eligible, failing, withTty]) {
      expect(built.gitCalls).toHaveLength(0);
      expect(built.h.events).toEqual([]);
      expect(built.h.sourceCalls()).toBe(0);
    }
  });

  test("a finished session is removed without a stop, and its absence is re-read", async () => {
    const built = build();
    const outcome = await runDo(baseConfig, cleanup(), built.h.deps);
    const envelope = JSON.parse(outcome.stdout) as PlanEnvelope;
    expect(envelope.ok.dry_run).toBe(false);
    expect(envelope.ok.plan.eligible).toBe(true);
    expect(envelope.ok.result).toEqual({ session_id: "s-done", stopped: false, removed: true, worktrees_removed: 1, verified_absent: true });
    expect(mutations(built)).toEqual(["rm:s-done"]);
    expect(built.h.events.at(-1)).toBe("list");
    expect(built.h.events.indexOf("rm:s-done")).toBeLessThan(built.h.events.length - 1);
  });

  test("a running idle session is stopped, re-checked, removed in that order and re-read from session list", async () => {
    const built = build({ target: { state: "running", activity: "idle" } });
    const outcome = await runDo(baseConfig, cleanup(), built.h.deps);
    const envelope = JSON.parse(outcome.stdout) as PlanEnvelope;
    expect(envelope.ok.result?.stopped).toBe(true);
    const events = built.h.events;
    const stop = events.indexOf("stop:s-done");
    const rm = events.indexOf("rm:s-done");
    expect(stop).toBeGreaterThan(-1);
    expect(rm).toBeGreaterThan(stop);
    // session list between stop and rm (state read) and after rm (absence read).
    expect(events.slice(stop + 1, rm)).toContain("list");
    expect(events.slice(rm + 1)).toEqual(["list"]);
    // The git evidence and the diff were gathered a second time after the stop.
    expect(built.gitCalls.filter((c) => c.argv[6] === "status")).toHaveLength(2);
    expect(events.filter((e) => e === "diff:s-done")).toHaveLength(2);
  });

  test("pohunek calls get the cleanup timeout and --accept-unconfirmed-cleanup is never passed", async () => {
    const timeouts: number[] = [];
    const built = build({
      target: { state: "running", activity: "idle" },
      world: {
        stop: (_id, t) => {
          timeouts.push(t);
          built.state.stopped = true;
          return ok("pohunek", { stopped: true });
        },
        remove: (_id, t) => {
          timeouts.push(t);
          built.state.removed = true;
          return ok("pohunek", { removed: true, stopped: true, worktreesRemoved: 1, worktreesFailed: 0, acceptedUnconfirmedProcesses: 0 });
        },
        diff: (_id, t) => {
          timeouts.push(t);
          return ok("pohunek", { base: "main", truncated: false, diffBytes: 1 });
        },
      },
    });
    const outcome = await runDo(baseConfig, cleanup(), built.h.deps);
    expect(timeouts).toEqual([60000, 60000, 60000, 60000]);
    expect(outcome.stdout).not.toContain("--accept-unconfirmed-cleanup");
    for (const call of built.gitCalls) expect(call.argv).not.toContain("--accept-unconfirmed-cleanup");
  });

  test("the text output of a real run reports the removal", async () => {
    const built = build();
    const outcome = await runDo(baseConfig, cleanup({ json: false }), built.h.deps);
    expect(outcome.stdout).toContain("removed session s-done");
  });

  test("a check that fails after the stop leaves the session stopped and removes nothing", async () => {
    const built = build({
      target: { state: "running", activity: "idle" },
      git: { status: (state) => out(state.stopped ? " M late.ts\0" : CLEAN_STATUS) },
    });
    const error = await refusal(runDo(baseConfig, cleanup(), built.h.deps));
    expect(error.code).toBe("precondition_failed");
    expect(error.message).toContain("worktree_clean");
    expect(error.message).toContain("stays stopped");
    expect(mutations(built)).toEqual(["stop:s-done"]);
  });

  test("each check is run again after the stop", async () => {
    const finished = (): PohunekSession => session({ id: "s-done", state: "stopped", activity: null, branch: BRANCH, worktreePath: PATH, cwd: PATH, metadata: LINK });
    const running = (): PohunekSession => ({ ...finished(), state: "running", activity: "idle" });
    // The broken evidence appears only once the session is stopped.
    const afterStop: readonly [string, (flag: () => boolean) => Scenario][] = [
      ["worktree_owned", (stopped) => ({ world: { worktrees: () => ok("pohunek", stopped() ? [] : [{ path: PATH, branch: BRANCH, head: "a", sessionId: "s-done" }]) } })],
      ["worktree_clean", (stopped) => ({ git: { status: () => out(stopped() ? " M late.ts\0" : CLEAN_STATUS) } })],
      ["branch_in_sync", (stopped) => ({ git: { revList: () => out(stopped() ? "1\t0\n" : "0\t0\n") } })],
      ["worktree_not_shared", (stopped) => ({ world: { listSessions: () => ok("pohunek", stopped() ? [finished(), SHARER_LIVE] : [running()]) } })],
      ["not_awaiting_owner", (stopped) => ({ world: { notifications: () => ok("pohunek", stopped() ? [notification({ sessionId: "s-done" })] : []) } })],
      ["diff_complete", (stopped) => ({ world: { diff: () => ok("pohunek", { base: "main", truncated: stopped(), diffBytes: 1 }) } })],
    ];
    for (const [name, make] of afterStop) {
      const flag = { stopped: false };
      const scenario = make(() => flag.stopped);
      const built = build({
        target: { state: "running", activity: "idle" },
        ...scenario,
        world: {
          stop: () => {
            flag.stopped = true;
            return ok("pohunek", { stopped: true });
          },
          // `listSessions` of the scenario, when present, decides the state itself.
          ...(scenario.world?.listSessions === undefined
            ? { listSessions: () => ok("pohunek", [flag.stopped ? finished() : running()]) }
            : {}),
          ...scenario.world,
        },
      });
      const error = await refusal(runDo(baseConfig, cleanup(), built.h.deps));
      expect(error.code).toBe("precondition_failed");
      expect(error.message).toContain(name);
      expect(mutations(built)).toEqual(["stop:s-done"]);
    }
  });

  test("a truncated diff after the stop leaves the session stopped and removes nothing", async () => {
    const calls = { diff: 0 };
    const built = build({
      target: { state: "running", activity: "idle" },
      world: {
        diff: () => {
          calls.diff += 1;
          return ok("pohunek", { base: "main", truncated: calls.diff > 1, diffBytes: 5 });
        },
      },
    });
    await expectRefusal(runDo(baseConfig, cleanup(), built.h.deps), "precondition_failed", "diff_complete");
    expect(mutations(built)).toEqual(["stop:s-done"]);
  });

  test("a session that still runs after the stop is verification_failed and nothing is removed", async () => {
    const built = build({
      target: { state: "running", activity: "idle" },
      world: { stop: () => ok("pohunek", { stopped: false }) },
    });
    await expectRefusal(runDo(baseConfig, cleanup(), built.h.deps), "verification_failed", "after the stop");
    expect(mutations(built)).toEqual(["stop:s-done"]);
  });

  test("a failed or timed out stop is reported and removes nothing", async () => {
    const failed = build({ target: { state: "running", activity: "idle" }, world: { stop: () => fail("pohunek", "unavailable") } });
    await expectRefusal(runDo(baseConfig, cleanup(), failed.h.deps), "command_failed", "session stop");
    const slow = build({ target: { state: "running", activity: "idle" }, world: { stop: () => fail("pohunek", "timeout") } });
    await expectRefusal(runDo(baseConfig, cleanup(), slow.h.deps), "command_timed_out");
    for (const built of [failed, slow]) expect(mutations(built)).toEqual(["stop:s-done"]);
  });

  test("a changed worktree or a vanished session after the stop is verification_failed", async () => {
    let reads = 0;
    const moved = build({
      target: { state: "running", activity: "idle" },
      world: {
        listSessions: () => {
          reads += 1;
          // The first read is the plan's; later reads show another worktree.
          const s = session({ id: "s-done", state: reads === 1 ? "running" : "stopped", activity: reads === 1 ? "idle" : null, branch: BRANCH, worktreePath: reads === 1 ? PATH : "/wt/elsewhere", metadata: LINK });
          return ok("pohunek", [s]);
        },
      },
    });
    await expectRefusal(runDo(baseConfig, cleanup(), moved.h.deps), "verification_failed", "changed");
    expect(mutations(moved)).toEqual(["stop:s-done"]);
    let seen = 0;
    const gone = build({
      target: { state: "running", activity: "idle" },
      world: {
        listSessions: () => {
          seen += 1;
          return ok("pohunek", seen === 1 ? [session({ id: "s-done", state: "running", activity: "idle", branch: BRANCH, worktreePath: PATH, metadata: LINK })] : []);
        },
      },
    });
    await expectRefusal(runDo(baseConfig, cleanup(), gone.h.deps), "verification_failed", "no longer listed");
    expect(mutations(gone)).toEqual(["stop:s-done"]);
  });

  test("an unreadable session list after the stop is verification_failed", async () => {
    let reads = 0;
    const built = build({
      target: { state: "running", activity: "idle" },
      world: {
        listSessions: () => {
          reads += 1;
          return reads === 1
            ? ok("pohunek", [session({ id: "s-done", state: "running", activity: "idle", branch: BRANCH, worktreePath: PATH, metadata: LINK })])
            : fail("pohunek", "timeout");
        },
      },
    });
    await expectRefusal(runDo(baseConfig, cleanup(), built.h.deps), "verification_failed", "re-read");
    expect(mutations(built)).toEqual(["stop:s-done"]);
  });

  test("rm results that are not a clean removal are command_failed", async () => {
    const notRemoved = build({ world: { remove: () => ok("pohunek", { removed: false, stopped: true, worktreesRemoved: 0, worktreesFailed: 0, acceptedUnconfirmedProcesses: 0 }) } });
    await expectRefusal(runDo(baseConfig, cleanup(), notRemoved.h.deps), "command_failed", "removed=false");
    const worktreeFailed = build({ world: { remove: () => ok("pohunek", { removed: true, stopped: true, worktreesRemoved: 0, worktreesFailed: 1, acceptedUnconfirmedProcesses: 0 }) } });
    await expectRefusal(runDo(baseConfig, cleanup(), worktreeFailed.h.deps), "command_failed", "1 worktree");
    const errored = build({ world: { remove: () => fail("pohunek", "unavailable") } });
    await expectRefusal(runDo(baseConfig, cleanup(), errored.h.deps), "command_failed", "session rm");
    const slow = build({ world: { remove: () => fail("pohunek", "timeout") } });
    await expectRefusal(runDo(baseConfig, cleanup(), slow.h.deps), "command_timed_out");
  });

  test("unconfirmed processes reported by rm are command_unverified", async () => {
    const built = build({ world: { remove: () => ok("pohunek", { removed: true, stopped: true, worktreesRemoved: 1, worktreesFailed: 0, acceptedUnconfirmedProcesses: 2 }) } });
    await expectRefusal(runDo(baseConfig, cleanup(), built.h.deps), "command_unverified", "unconfirmed");
  });

  test("a session that is still listed after rm is command_unverified", async () => {
    const still = build({ world: { remove: () => ok("pohunek", { removed: true, stopped: true, worktreesRemoved: 1, worktreesFailed: 0, acceptedUnconfirmedProcesses: 0 }) } });
    await expectRefusal(runDo(baseConfig, cleanup(), still.h.deps), "command_unverified", "still listed");
    let reads = 0;
    const unreadable = build({
      world: {
        listSessions: (): SourceResult<readonly PohunekSession[]> => {
          reads += 1;
          // Reads 1 and 2 are the plan's and the post-stop one; the third is the verification of the removal.
          return reads <= 2
            ? ok("pohunek", [session({ id: "s-done", state: "stopped", activity: null, branch: BRANCH, worktreePath: PATH, cwd: PATH, metadata: LINK })])
            : fail("pohunek", "unavailable");
        },
      },
    });
    await expectRefusal(runDo(baseConfig, cleanup(), unreadable.h.deps), "command_unverified");
  });
});

describe("parseStatus", () => {
  test("an empty status is clean", () => {
    expect(parseStatus("")).toEqual({ dirty: 0, ignored: [] });
  });

  test("ignored records are inventory and every other record is dirty", () => {
    expect(parseStatus("!! a/b\0?? c\0 M d\0A  e\0")).toEqual({ dirty: 3, ignored: ["a/b"] });
  });

  test("a rename or copy record consumes its origin field", () => {
    expect(parseStatus("R  new name\0old name\0!! x\0")).toEqual({ dirty: 1, ignored: ["x"] });
    expect(parseStatus("C  copy\0orig\0")).toEqual({ dirty: 1, ignored: [] });
    // An origin that looks like an ignored record is not one.
    expect(parseStatus("R  new\0!! old\0")).toEqual({ dirty: 1, ignored: [] });
  });

  test("a path with spaces or a newline is kept whole", () => {
    expect(parseStatus("!! a b\nc\0")).toEqual({ dirty: 0, ignored: ["a b\nc"] });
  });

  test("output that is not exactly the format is null", () => {
    for (const bad of ["x", "!! a", "!!a\0", "!\0", "R  only\0", "!! a\0junk"]) expect(parseStatus(bad)).toBeNull();
  });
});
