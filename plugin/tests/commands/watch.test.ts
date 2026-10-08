import { expect, test } from "bun:test";
import { notificationArgv, runWatch, unknownProject, watchTick, type Baseline, type WatchDeps } from "../../src/commands/watch.ts";
import { loadConfig } from "../../src/config/index.ts";
import type { Logger } from "../../src/log.ts";
import type { PohunekClient } from "../../src/sources/pohunek.ts";
import type { Issue, PohunekNotification, PohunekProject, PohunekSession, PullRequest, SourceResult } from "../../src/types/sources.ts";
import { SpawnError, type ExecResult } from "../../src/util/exec.ts";
import { check, githubIssueSource, issue, notification, pr, session } from "../rules/builders.ts";

const config = await loadConfig(new URL("../fixtures/config", import.meta.url).pathname);

const registry: PohunekProject[] = [
  { id: "p-1", label: "widgets", originUrl: "git@github.com:acme/widgets.git", defaultBaseBranch: "main" },
];

/** Owner's turn (draft pull request) and the reviewer's turn (approved, checks pending) for the same key. */
const mineTitle = "<b>secret title</b>";
const mine = pr({ headRefName: "feature/abc-1", isDraft: true, title: mineTitle });
const waiting = pr({ headRefName: "feature/abc-1", reviewDecision: "APPROVED", checks: [check("b", "pending")] });

interface Recorded {
  readonly level: "info" | "error";
  readonly event: string;
}

interface Harness {
  deps: WatchDeps;
  world: {
    prs: SourceResult<readonly PullRequest[]>;
    issues: SourceResult<readonly Issue[]>;
    githubIssues: SourceResult<readonly Issue[]>;
    sessions: readonly PohunekSession[];
    notifications: readonly PohunekNotification[];
    /** Answer of the ignore-label lookup of unlisted issues; a lookup fails the test when absent. */
    ignoredKeys: SourceResult<ReadonlySet<string>> | null;
  };
  argvs: (readonly string[])[];
  logs: Recorded[];
  setExec(next: () => Promise<ExecResult>): void;
}

function githubOk(prs: readonly PullRequest[]): SourceResult<readonly PullRequest[]> {
  return { ok: true, source: "github", data: prs, durationMs: 1 };
}

function linearOk(issues: readonly Issue[]): SourceResult<readonly Issue[]> {
  return { ok: true, source: "linear", data: issues, durationMs: 1 };
}

function githubIssuesOk(issues: readonly Issue[]): SourceResult<readonly Issue[]> {
  return { ok: true, source: "github_issues", data: issues, durationMs: 1 };
}

function harness(prs: readonly PullRequest[], sleeps: number[] = []): Harness {
  const world: Harness["world"] = { prs: githubOk(prs), issues: linearOk([]), githubIssues: githubIssuesOk([]), sessions: [], notifications: [], ignoredKeys: null };
  const argvs: (readonly string[])[] = [];
  const logs: Recorded[] = [];
  let execNext: () => Promise<ExecResult> = () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  const logger: Logger = {
    info: (event) => void logs.push({ level: "info", event }),
    error: (event) => void logs.push({ level: "error", event }),
    sourceResult: () => undefined,
    failure: () => null,
    close: () => Promise.resolve(),
  };
  const pohunek: PohunekClient = {
    listProjects: () => Promise.resolve({ ok: true, source: "pohunek", data: registry, durationMs: 1 }),
    listSessions: () => Promise.resolve({ ok: true, source: "pohunek", data: world.sessions, durationMs: 1 }),
    listNotifications: () => Promise.resolve({ ok: true, source: "pohunek", data: world.notifications, durationMs: 1 }),
    launchSession: () => Promise.reject(new Error("not used")),
    waitSession: () => Promise.reject(new Error("not used")),
    listWorktrees: () => Promise.reject(new Error("not used")),
    attach: () => Promise.reject(new Error("not used")),
    stopSession: () => Promise.reject(new Error("not used")),
    removeSession: () => Promise.reject(new Error("not used")),
    diffSession: () => Promise.reject(new Error("not used")),
  };
  const self: Harness = {
    world,
    argvs,
    logs,
    setExec: (next) => {
      execNext = next;
    },
    deps: {
      pohunek,
      github: {
        fetchPullRequests: () => Promise.resolve(world.prs),
        fetchMergedPullRequests: () => Promise.resolve({ ok: true, source: "github", data: [], durationMs: 0 }),
        fetchIssues: () => Promise.resolve(world.githubIssues),
        fetchIgnoredKeys: (): Promise<SourceResult<ReadonlySet<string>>> =>
          world.ignoredKeys === null ? Promise.reject(new Error("the test did not expect an ignore-label lookup")) : Promise.resolve(world.ignoredKeys),
        fetchIssueDetail: () => Promise.reject(new Error("an issue body is read only when implement is planned")),
      },
      linear: {
        fetchIssues: () => Promise.resolve(world.issues),
        fetchIgnoredKeys: (): Promise<SourceResult<ReadonlySet<string>>> =>
          world.ignoredKeys === null ? Promise.reject(new Error("the test did not expect an ignore-label lookup")) : Promise.resolve(world.ignoredKeys),
      },
      logger,
      exec: (argv) => {
        argvs.push(argv);
        return execNext();
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
  return self;
}

const options = { project: "widgets" };

async function tick(h: Harness, baseline: Baseline): Promise<{ baseline: Baseline; notified: readonly string[] }> {
  return watchTick(config, options, h.deps, baseline, new AbortController().signal);
}

test("the first poll sets the baseline and notifies nobody, even for rows already on the owner's turn", async () => {
  const h = harness([mine]);
  const first = await tick(h, null);
  expect(first.notified).toEqual([]);
  expect(first.baseline).not.toBeNull();
  expect(h.argvs).toEqual([]);
});

test("a transition to the owner notifies once with key and reason and without the title", async () => {
  const h = harness([waiting]);
  let state = (await tick(h, null)).baseline;
  h.world.prs = githubOk([mine]);
  const second = await tick(h, state);
  state = second.baseline;
  expect(second.notified).toEqual(["widgets github:acme/widgets#12"]);
  expect(h.argvs).toHaveLength(1);
  const argv = h.argvs[0] ?? [];
  expect(argv[0]).toBe("/usr/bin/notify-send");
  expect(argv).toContain("--");
  expect(argv.join(" ")).toContain("github:acme/widgets#12");
  expect(argv.join(" ")).not.toContain("secret title");
  const third = await tick(h, state);
  expect(third.notified).toEqual([]);
  expect(h.argvs).toHaveLength(1);
});

test("pausing an issue notifies nobody and resuming it notifies once", async () => {
  const conflicting = pr({ headRefName: "alice/ABC-1/work", mergeable: "CONFLICTING" });
  const h = harness([conflicting]);
  h.world.issues = linearOk([issue()]);
  let state = (await tick(h, null)).baseline;
  h.world.issues = linearOk([issue({ state: "On hold", paused: true })]);
  const paused = await tick(h, state);
  state = paused.baseline;
  expect(paused.notified).toEqual([]);
  expect(state?.get("widgets linear:ABC-1")).toBe("paused");
  h.world.issues = linearOk([issue()]);
  const resumed = await tick(h, state);
  expect(resumed.notified).toEqual(["widgets linear:ABC-1"]);
});

test("a paused issue without a pull request disappears and notifies once when it returns on the owner's turn", async () => {
  const h = harness([]);
  h.world.issues = linearOk([issue()]);
  let state = (await tick(h, null)).baseline;
  expect(state?.get("widgets linear:ABC-1")).toBe("me");
  h.world.issues = linearOk([issue({ state: "On hold", paused: true })]);
  const paused = await tick(h, state);
  state = paused.baseline;
  expect(paused.notified).toEqual([]);
  expect(state?.has("widgets linear:ABC-1")).toBe(false);
  h.world.issues = linearOk([issue()]);
  const resumed = await tick(h, state);
  expect(resumed.notified).toEqual(["widgets linear:ABC-1"]);
});

test("an ignored row on the owner's turn never notifies, and losing the label notifies once", async () => {
  const parked = pr({ headRefName: "feature/abc-1", isDraft: true, ignored: true });
  const h = harness([waiting]);
  let state = (await tick(h, null)).baseline;
  h.world.prs = githubOk([parked]);
  const ignoredTick = await tick(h, state);
  state = ignoredTick.baseline;
  expect(ignoredTick.notified).toEqual([]);
  expect(state?.has("widgets github:acme/widgets#12")).toBe(false);
  expect(h.argvs).toEqual([]);
  const stillParked = await tick(h, state);
  expect(stillParked.notified).toEqual([]);
  h.world.prs = githubOk([mine]);
  const unparked = await tick(h, stillParked.baseline);
  expect(unparked.notified).toEqual(["widgets github:acme/widgets#12"]);
  expect(h.argvs).toHaveLength(1);
  expect((await tick(h, unparked.baseline)).notified).toEqual([]);
});

test("a row parked during a partial poll leaves the baseline and notifies once when it returns", async () => {
  const other = pr({ id: "acme/widgets#13", number: 13, url: "https://example.invalid/acme/widgets/pull/13", headRefName: "feature/abc-2" });
  const h = harness([mine, other]);
  let state = (await tick(h, null)).baseline;
  expect(state?.get("widgets github:acme/widgets#12")).toBe("me");
  expect(state?.get("widgets github:acme/widgets#13")).toBe("me");
  h.world.prs = githubOk([pr({ headRefName: "feature/abc-1", ignored: true })]);
  h.world.issues = { ok: false, source: "linear", code: "truncated", message: "failed", durationMs: 1 };
  const partial = await tick(h, state);
  state = partial.baseline;
  expect(partial.notified).toEqual([]);
  expect(state?.has("widgets github:acme/widgets#12")).toBe(false);
  expect(state?.get("widgets github:acme/widgets#13")).toBe("me");
  h.world.prs = githubOk([mine, other]);
  h.world.issues = linearOk([]);
  const unparked = await tick(h, state);
  expect(unparked.notified).toEqual(["widgets github:acme/widgets#12"]);
  expect(h.argvs).toHaveLength(1);
});

const guarded = {
  ...config,
  projects: config.projects.map((p) =>
    p.name === "widgets" && p.issueSource.kind === "linear" ? { ...p, issueSource: { ...p.issueSource, pausedStates: [] }, ignoreLabel: "Pohunek:Ignore" } : p,
  ),
};
const truncated: SourceResult<never> = { ok: false, source: "linear", code: "truncated", message: "failed", durationMs: 1 };

async function guardedTick(h: Harness, baseline: Baseline): Promise<{ baseline: Baseline; notified: readonly string[] }> {
  return watchTick(guarded, options, h.deps, baseline, new AbortController().signal);
}

test("a pull request whose issue may carry the ignore label never notifies while the issue source is down", async () => {
  const spike = { headRefName: "alice/ABC-1/spike" } as const;
  const h = harness([pr({ ...spike, reviewDecision: "APPROVED", checks: [check("b", "pending")] })]);
  h.world.issues = linearOk([issue({ ignored: true })]);
  const first = await guardedTick(h, null);
  expect(first.baseline?.size).toBe(0);
  h.world.prs = githubOk([pr({ ...spike, checks: [check("build", "failure")] })]);
  h.world.issues = truncated;
  const down = await guardedTick(h, first.baseline);
  expect(down.notified).toEqual([]);
  expect(h.argvs).toEqual([]);
});

test("a blocked session does not notify a row whose issue may carry the ignore label while the issue source is down", async () => {
  const spike = pr({ headRefName: "alice/ABC-1/spike", reviewDecision: "APPROVED", checks: [check("b", "pending")] });
  const h = harness([spike]);
  h.world.sessions = [session({ id: "s-1", metadata: { "work.link.provider": "linear", "work.link.id": "ABC-1", "work.link.branch": spike.headRefName } })];
  h.world.issues = linearOk([issue({ ignored: true })]);
  const first = await guardedTick(h, null);
  h.world.notifications = [notification({ sessionId: "s-1" })];
  h.world.issues = truncated;
  const down = await guardedTick(h, first.baseline);
  expect(down.notified).toEqual([]);
  expect(h.argvs).toEqual([]);
});

test("an issue row never notifies while github is down, even with a blocked session, and keeps its baseline", async () => {
  const h = harness([]);
  h.world.sessions = [session({ id: "s-1", metadata: { "work.link.provider": "linear", "work.link.id": "ABC-1" } })];
  h.world.issues = linearOk([issue()]);
  h.world.notifications = [notification({ sessionId: "s-1" })];
  for (const code of ["truncated", "rate_limited"] as const) {
    h.world.prs = { ok: false, source: "github", code, message: "failed", durationMs: 1 };
    const down = await guardedTick(h, new Map([["widgets linear:ABC-1", "agent"]]));
    expect(down.notified).toEqual([]);
    expect(down.baseline?.get("widgets linear:ABC-1")).toBe("agent");
  }
  expect(h.argvs).toEqual([]);
});

test("a pull request linked to its issue only by a Linear attachment never notifies while Linear is down", async () => {
  const attached = pr({ headRefName: "feature/x", reviewDecision: "APPROVED", checks: [check("b", "pending")] });
  const h = harness([attached]);
  h.world.issues = linearOk([issue({ ignored: true, attachmentUrls: [attached.url] })]);
  const first = await guardedTick(h, null);
  expect(first.baseline?.size).toBe(0);
  h.world.prs = githubOk([pr({ headRefName: "feature/x", checks: [check("build", "failure")] })]);
  h.world.issues = truncated;
  const down = await guardedTick(h, first.baseline);
  expect(down.notified).toEqual([]);
  expect(h.argvs).toEqual([]);
});

test("a pull request of a parked issue the issue source did not list never notifies, and losing the label notifies once", async () => {
  const spike = { headRefName: "alice/ABC-1/spike" } as const;
  const h = harness([pr({ ...spike, reviewDecision: "APPROVED", checks: [check("b", "pending")] })]);
  h.world.ignoredKeys = { ok: true, source: "linear", data: new Set(), durationMs: 1 };
  const first = await guardedTick(h, null);
  expect(first.baseline?.size).toBe(1);
  h.world.prs = githubOk([pr({ ...spike, checks: [check("build", "failure")] })]);
  h.world.ignoredKeys = { ok: true, source: "linear", data: new Set(["ABC-1"]), durationMs: 1 };
  const parked = await guardedTick(h, first.baseline);
  expect(parked.notified).toEqual([]);
  expect(parked.baseline?.size).toBe(0);
  h.world.ignoredKeys = { ok: true, source: "linear", data: new Set(), durationMs: 1 };
  const unparked = await guardedTick(h, parked.baseline);
  expect(unparked.notified).toEqual(["widgets linear:ABC-1"]);
  expect(h.argvs).toHaveLength(1);
});

test("a failed ignore-label lookup keeps the baseline and notifies nobody", async () => {
  const spike = { headRefName: "alice/ABC-1/spike" } as const;
  const h = harness([pr({ ...spike, reviewDecision: "APPROVED", checks: [check("b", "pending")] })]);
  h.world.ignoredKeys = { ok: true, source: "linear", data: new Set(), durationMs: 1 };
  const first = await guardedTick(h, null);
  h.world.prs = githubOk([pr({ ...spike, checks: [check("build", "failure")] })]);
  h.world.ignoredKeys = { ok: false, source: "linear", code: "truncated", message: "failed", durationMs: 1 };
  const down = await guardedTick(h, first.baseline);
  expect(down.notified).toEqual([]);
  expect(down.baseline?.get("widgets linear:ABC-1")).toBe("reviewer");
  expect(h.logs).toContainEqual({ level: "error", event: "source_failed" });
  expect(h.argvs).toEqual([]);
});

test("a pull request of a GitHub issue the issue source did not list stays silent when the issue is labelled or the lookup fails", async () => {
  const githubParked = {
    ...config,
    projects: config.projects.map((p) =>
      p.name === "widgets"
        ? { ...p, issueSource: githubIssueSource, branchPattern: /^alice\/(?<key>[0-9]+)\//, branchPatternSource: "^alice/(?P<key>[0-9]+)/", ignoreLabel: "Pohunek:Ignore" }
        : p,
    ),
  };
  const tickGithub = (h: Harness, baseline: Baseline): Promise<{ baseline: Baseline; notified: readonly string[] }> =>
    watchTick(githubParked, options, h.deps, baseline, new AbortController().signal);
  const spike = { headRefName: "alice/5/spike", closingIssueNumbers: [5] } as const;
  const h = harness([pr({ ...spike, reviewDecision: "APPROVED", checks: [check("b", "pending")] })]);
  h.world.ignoredKeys = { ok: true, source: "github_issues", data: new Set(), durationMs: 1 };
  const first = await tickGithub(h, null);
  h.world.prs = githubOk([pr({ ...spike, checks: [check("build", "failure")] })]);
  h.world.ignoredKeys = { ok: true, source: "github_issues", data: new Set(["acme/widgets#5"]), durationMs: 1 };
  const parked = await tickGithub(h, first.baseline);
  expect(parked.notified).toEqual([]);
  h.world.ignoredKeys = { ok: false, source: "github_issues", code: "truncated", message: "failed", durationMs: 1 };
  const down = await tickGithub(h, first.baseline);
  expect(down.notified).toEqual([]);
  expect(h.argvs).toEqual([]);
});

test("a keyless pull request attached to a parked Linear issue never notifies, and a failed lookup keeps the baseline", async () => {
  const keyless = { headRefName: "feature/x" } as const;
  const h = harness([pr({ ...keyless, reviewDecision: "APPROVED", checks: [check("b", "pending")] })]);
  h.world.ignoredKeys = { ok: true, source: "linear", data: new Set(), durationMs: 1 };
  const first = await guardedTick(h, null);
  expect(first.baseline?.get("widgets github:acme/widgets#12")).toBe("reviewer");
  const failing = pr({ ...keyless, checks: [check("build", "failure")] });
  h.world.prs = githubOk([failing]);
  h.world.ignoredKeys = { ok: true, source: "linear", data: new Set([failing.url]), durationMs: 1 };
  const parked = await guardedTick(h, first.baseline);
  expect(parked.notified).toEqual([]);
  expect(parked.baseline?.size).toBe(0);
  h.world.ignoredKeys = { ok: false, source: "linear", code: "truncated", message: "failed", durationMs: 1 };
  const down = await guardedTick(h, first.baseline);
  expect(down.notified).toEqual([]);
  expect(down.baseline?.get("widgets github:acme/widgets#12")).toBe("reviewer");
  expect(h.argvs).toEqual([]);
});

test("an unavailable source keeps the baseline null, so the recovery poll does not notify", async () => {
  const h = harness([mine]);
  h.world.prs = { ok: false, source: "github", code: "rate_limited", message: "failed", durationMs: 1 };
  const outage = await tick(h, null);
  expect(outage.baseline).toBeNull();
  h.world.prs = githubOk([mine]);
  const recovered = await tick(h, outage.baseline);
  expect(recovered.notified).toEqual([]);
  expect(recovered.baseline).not.toBeNull();
  h.world.prs = githubOk([waiting]);
  const waitingTick = await tick(h, recovered.baseline);
  h.world.prs = githubOk([mine]);
  const transition = await tick(h, waitingTick.baseline);
  expect(transition.notified).toHaveLength(1);
});

test("an outage after the baseline neither notifies nor marks the recovered row", async () => {
  const h = harness([mine]);
  const baseline = (await tick(h, null)).baseline;
  h.world.prs = { ok: false, source: "github", code: "timeout", message: "failed", durationMs: 1 };
  const outage = await tick(h, baseline);
  expect(outage.notified).toEqual([]);
  h.world.prs = githubOk([mine]);
  const recovered = await tick(h, outage.baseline);
  expect(recovered.notified).toEqual([]);
});

test("a failing notification command is logged and does not repeat on the next poll", async () => {
  const h = harness([waiting]);
  let state = (await tick(h, null)).baseline;
  h.setExec(() => Promise.resolve({ exitCode: 1, stdout: "", stderr: "no display", timedOut: false }));
  h.world.prs = githubOk([mine]);
  state = (await tick(h, state)).baseline;
  expect(h.logs).toContainEqual({ level: "error", event: "watch_notify_failed" });
  const again = await tick(h, state);
  expect(again.notified).toEqual([]);
  expect(h.argvs).toHaveLength(1);
});

test("a missing notification binary is logged, not thrown", async () => {
  const h = harness([waiting]);
  const state = (await tick(h, null)).baseline;
  h.setExec(() => Promise.reject(new SpawnError("/usr/bin/notify-send", new Error("ENOENT"))));
  h.world.prs = githubOk([mine]);
  await tick(h, state);
  expect(h.logs).toContainEqual({ level: "error", event: "watch_notify_failed" });
});

test("runWatch sleeps the configured interval between polls and stops when the signal aborts", async () => {
  const sleeps: number[] = [];
  const h = harness([waiting], sleeps);
  const controller = new AbortController();
  const baseSleep = h.deps.sleep;
  h.deps = {
    ...h.deps,
    sleep: async (ms, signal) => {
      await baseSleep(ms, signal);
      if (sleeps.length === 3) controller.abort();
    },
  };
  await runWatch(config, options, h.deps, controller.signal);
  expect(sleeps).toEqual([300_000, 300_000, 300_000]);
  expect(h.logs.filter((l) => l.event === "watch_tick")).toHaveLength(3);
});

test("a failing poll is logged and the loop continues with the next one", async () => {
  const sleeps: number[] = [];
  const h = harness([waiting], sleeps);
  const controller = new AbortController();
  let calls = 0;
  h.deps = {
    ...h.deps,
    github: {
      fetchMergedPullRequests: () => Promise.resolve({ ok: true, source: "github", data: [], durationMs: 0 }),
      fetchIssues: () => Promise.resolve({ ok: true, source: "github_issues", data: [], durationMs: 0 }),
      fetchIgnoredKeys: () => Promise.reject(new Error("not used")),
      fetchIssueDetail: () => Promise.reject(new Error("an issue body is read only when implement is planned")),
      fetchPullRequests: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(githubOk([waiting]));
      },
    },
    sleep: (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 2) controller.abort();
      return Promise.resolve();
    },
  };
  await runWatch(config, options, h.deps, controller.signal);
  expect(h.logs).toContainEqual({ level: "error", event: "watch_tick_failed" });
  expect(h.logs.filter((l) => l.event === "watch_tick")).toHaveLength(1);
});

test("notificationArgv reduces provider text to ASCII", () => {
  const item = {
    key: "github:acme/widgets#12",
    project: "widšgets",
    on_turn: { actor: "me", reason: "needs‮evil", rule: 1 },
  };
  const argv = notificationArgv(config.global.notify, item as never);
  expect(argv.slice(3).join("|")).toBe("your turn: github:acme/widgets#12|widsgets: needs?evil");
});

test("an abort during a notification batch stops before the next notification", async () => {
  const second = pr({ id: "acme/widgets#13", number: 13, url: "https://example.invalid/13", headRefName: "feature/abc-2", isDraft: true });
  const secondWaiting = pr({ id: "acme/widgets#13", number: 13, url: "https://example.invalid/13", headRefName: "feature/abc-2", reviewDecision: "APPROVED", checks: [check("b", "pending")] });
  const h = harness([waiting, secondWaiting]);
  const state = (await tick(h, null)).baseline;
  h.world.prs = githubOk([mine, second]);
  const controller = new AbortController();
  h.setExec(() => {
    controller.abort();
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
  });
  const result = await watchTick(config, options, h.deps, state, controller.signal);
  expect(h.argvs).toHaveLength(1);
  expect(result.notified).toHaveLength(1);
});

test("an abort before the notifications sends none", async () => {
  const h = harness([waiting]);
  const state = (await tick(h, null)).baseline;
  h.world.prs = githubOk([mine]);
  const controller = new AbortController();
  controller.abort();
  const result = await watchTick(config, options, h.deps, state, controller.signal);
  expect(result.notified).toEqual([]);
  expect(h.argvs).toEqual([]);
});

test("collector warnings are logged as errors", async () => {
  const h = harness([mine]);
  await watchTick(config, { project: "no-such-project" }, h.deps, null, new AbortController().signal);
  expect(h.logs).toContainEqual({ level: "error", event: "watch_warning" });
});

test("unknownProject accepts null and configured labels and returns an unknown label", () => {
  expect(unknownProject(config, null)).toBeNull();
  expect(unknownProject(config, "widgets")).toBeNull();
  expect(unknownProject(config, "typo")).toBe("typo");
});

test("a github-only configuration counts every poll complete and baselines at once", async () => {
  const githubOnly = {
    ...config,
    global: { ...config.global, linear: null },
    projects: config.projects.map((p) => ({ ...p, issueSource: githubIssueSource })),
  };
  const h = harness([mine]);
  h.deps = { ...h.deps, linear: null };
  const first = await watchTick(githubOnly, options, h.deps, null, new AbortController().signal);
  expect(first.baseline).not.toBeNull();
  expect(h.logs.some((l) => l.event === "watch_tick")).toBe(true);
  expect(h.logs.filter((l) => l.level === "error")).toEqual([]);
});

test("a github issue becomes the owner's turn, notifies once under its github-issue key and pausing it clears the row", async () => {
  const githubConfig = {
    ...config,
    global: { ...config.global, linear: null },
    projects: config.projects.map((p) => ({ ...p, issueSource: githubIssueSource })),
  };
  const started = issue({ id: "acme/widgets#7", state: "in-progress" });
  const h = harness([]);
  h.deps = { ...h.deps, linear: null };
  const watch = (baseline: Parameters<typeof watchTick>[3]): ReturnType<typeof watchTick> =>
    watchTick(githubConfig, options, h.deps, baseline, new AbortController().signal);
  let state = (await watch(null)).baseline;
  expect(state?.size).toBe(0);
  h.world.githubIssues = githubIssuesOk([started]);
  const appeared = await watch(state);
  state = appeared.baseline;
  expect(appeared.notified).toEqual(["widgets github-issue:acme/widgets#7"]);
  expect(h.argvs.join(" ")).toContain("github-issue:acme/widgets#7");
  h.world.githubIssues = githubIssuesOk([{ ...started, started: false, paused: true, state: "on-hold" }]);
  const paused = await watch(state);
  expect(paused.notified).toEqual([]);
  expect(paused.baseline?.has("widgets github-issue:acme/widgets#7")).toBe(false);
});

test("a review request notifies under session reviews and stays silent under external reviews", async () => {
  const requested = pr({ relation: "review_requested", headRefName: "feature/theirs" });
  const external = { ...config, projects: config.projects.map((p) => (p.name === "widgets" ? { ...p, reviews: "external" as const } : p)) };
  const session = harness([waiting]);
  const base = (await tick(session, null)).baseline;
  session.world.prs = githubOk([requested]);
  expect((await tick(session, base)).notified).toEqual(["widgets github:acme/widgets#12"]);

  const pipeline = harness([waiting]);
  const pipelineBase = (await watchTick(external, options, pipeline.deps, null, new AbortController().signal)).baseline;
  pipeline.world.prs = githubOk([requested]);
  const result = await watchTick(external, options, pipeline.deps, pipelineBase, new AbortController().signal);
  expect(result.notified).toEqual([]);
  expect(pipeline.argvs).toEqual([]);
  expect(result.baseline?.get("widgets github:acme/widgets#12")).toBe("agent");
});
