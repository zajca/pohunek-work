import { expect, test } from "bun:test";
import { notificationArgv, runWatch, unknownProject, watchTick, type Baseline, type WatchDeps } from "../../src/commands/watch.ts";
import { loadConfig } from "../../src/config/index.ts";
import type { Logger } from "../../src/log.ts";
import type { PohunekClient } from "../../src/sources/pohunek.ts";
import type { LinearIssue, PohunekProject, PullRequest, SourceResult } from "../../src/types/sources.ts";
import { SpawnError, type ExecResult } from "../../src/util/exec.ts";
import { check, issue, pr } from "../rules/builders.ts";

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
  world: { prs: SourceResult<readonly PullRequest[]>; issues: SourceResult<readonly LinearIssue[]> };
  argvs: (readonly string[])[];
  logs: Recorded[];
  setExec(next: () => Promise<ExecResult>): void;
}

function githubOk(prs: readonly PullRequest[]): SourceResult<readonly PullRequest[]> {
  return { ok: true, source: "github", data: prs, durationMs: 1 };
}

function linearOk(issues: readonly LinearIssue[]): SourceResult<readonly LinearIssue[]> {
  return { ok: true, source: "linear", data: issues, durationMs: 1 };
}

function harness(prs: readonly PullRequest[], sleeps: number[] = []): Harness {
  const world = { prs: githubOk(prs), issues: linearOk([]) };
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
    listSessions: () => Promise.resolve({ ok: true, source: "pohunek", data: [], durationMs: 1 }),
    listNotifications: () => Promise.resolve({ ok: true, source: "pohunek", data: [], durationMs: 1 }),
    launchSession: () => Promise.reject(new Error("not used")),
    listWorktrees: () => Promise.reject(new Error("not used")),
    attach: () => Promise.reject(new Error("not used")),
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
      },
      linear: { fetchIssues: () => Promise.resolve(world.issues) },
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
  h.world.issues = linearOk([issue({ stateName: "On hold" })]);
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
  h.world.issues = linearOk([issue({ stateName: "On hold" })]);
  const paused = await tick(h, state);
  state = paused.baseline;
  expect(paused.notified).toEqual([]);
  expect(state?.has("widgets linear:ABC-1")).toBe(false);
  h.world.issues = linearOk([issue()]);
  const resumed = await tick(h, state);
  expect(resumed.notified).toEqual(["widgets linear:ABC-1"]);
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
    projects: config.projects.map((p) => ({ ...p, issueSource: { kind: "github" } }) as const),
  };
  const h = harness([mine]);
  h.deps = { ...h.deps, linear: null };
  const first = await watchTick(githubOnly, options, h.deps, null, new AbortController().signal);
  expect(first.baseline).not.toBeNull();
  expect(h.logs.some((l) => l.event === "watch_tick")).toBe(true);
  expect(h.logs.filter((l) => l.level === "error")).toEqual([]);
});
