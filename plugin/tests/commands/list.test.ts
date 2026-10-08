import { describe, expect, test } from "bun:test";
import { runList, selectProjects } from "../../src/commands/list.ts";
import { loadConfig } from "../../src/config/index.ts";
import type { Logger } from "../../src/log.ts";
import type { PohunekClient } from "../../src/sources/pohunek.ts";
import type {
  Issue,
  MergedPullRequest,
  PohunekProject,
  PohunekSession,
  PullRequest,
  SourceResult,
} from "../../src/types/sources.ts";
import { check, githubIssueSource, issue, mergedPr, pr, session } from "../rules/builders.ts";

const config = await loadConfig(new URL("../fixtures/config", import.meta.url).pathname);
const widgets = config.projects.find((p) => p.pohunekLabel === "widgets");
if (widgets === undefined) throw new Error("fixture project widgets missing");

function ok<T>(source: "github" | "github_issues" | "linear" | "pohunek", data: T): SourceResult<T> {
  return { ok: true, source, data, durationMs: 1 };
}
function fail(source: "github" | "github_issues" | "linear" | "pohunek", code: "rate_limited" | "timeout"): SourceResult<never> {
  return { ok: false, source, code, message: "failed", durationMs: 1 };
}

const silentLogger: Logger = {
  info: () => undefined,
  error: () => undefined,
  sourceResult: () => undefined,
  failure: () => null,
  close: () => Promise.resolve(),
};

const registry: PohunekProject[] = [
  { id: "p-1", label: "widgets", originUrl: "git@github.com:acme/widgets.git", defaultBaseBranch: "main" },
  { id: "p-2", label: "gadgets", originUrl: "git@github.com:acme/gadgets.git", defaultBaseBranch: null },
];

interface World {
  prs?: SourceResult<readonly PullRequest[]>;
  merged?: SourceResult<readonly MergedPullRequest[]>;
  issues?: SourceResult<readonly Issue[]>;
  githubIssues?: SourceResult<readonly Issue[]>;
  /** Answer of the ignore-label lookup of unlisted issues; a lookup fails the test when absent. */
  ignoredKeys?: SourceResult<ReadonlySet<string>>;
  lookups?: string[][];
  sessions?: SourceResult<readonly PohunekSession[]>;
  registry?: SourceResult<readonly PohunekProject[]>;
}

function deps(world: World): Parameters<typeof runList>[2] {
  const pohunek: PohunekClient = {
    listProjects: () => Promise.resolve(world.registry ?? ok("pohunek", registry)),
    listSessions: () => Promise.resolve(world.sessions ?? ok("pohunek", [])),
    listNotifications: () => Promise.resolve(ok("pohunek", [])),
    launchSession: () => Promise.reject(new Error("not used")),
    waitSession: () => Promise.reject(new Error("not used")),
    listWorktrees: () => Promise.reject(new Error("not used")),
    attach: () => Promise.reject(new Error("not used")),
  };
  return {
    pohunek,
    github: {
      fetchPullRequests: () => Promise.resolve(world.prs ?? ok("github", [])),
      fetchMergedPullRequests: () => Promise.resolve(world.merged ?? ok("github", [])),
      fetchIssues: () => Promise.resolve(world.githubIssues ?? ok("github_issues", [])),
      fetchIgnoredKeys: (_project: unknown, keys: readonly string[]) => {
        world.lookups?.push([...keys]);
        return world.ignoredKeys === undefined ? Promise.reject(new Error("the test did not expect an ignore-label lookup")) : Promise.resolve(world.ignoredKeys);
      },
      fetchIssueDetail: () => Promise.reject(new Error("an issue body is read only when implement is planned")),
    },
    linear: {
      fetchIssues: () => Promise.resolve(world.issues ?? ok("linear", [])),
      fetchIgnoredKeys: (_project: unknown, keys: readonly string[], urls: readonly string[]) => {
        world.lookups?.push([...keys, ...urls.map((url) => `url:${url}`)]);
        return world.ignoredKeys === undefined ? Promise.reject(new Error("the test did not expect an ignore-label lookup")) : Promise.resolve(world.ignoredKeys);
      },
    },
    logger: silentLogger,
    cliVersion: "0.1.0",
  };
}

const draftPr = pr({ headRefName: "feature/abc-1", isDraft: true });
const quietPr = pr({ id: "acme/widgets#13", number: 13, url: "https://example.invalid/13", headRefName: "x", reviewDecision: "APPROVED", checks: [check("b", "pending")] });

test("json output lists rows and --mine keeps only the owner's turn", async () => {
  const world = { prs: ok("github", [draftPr, quietPr]) };
  const all = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps(world));
  const mine = await runList(config, { mine: true, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps(world));
  expect(all.items.map((i) => i.on_turn.actor)).toEqual(["me", "reviewer"]);
  expect(mine.items.map((i) => i.key)).toEqual(["github:acme/widgets#12"]);
  const envelope = JSON.parse(mine.stdout) as { ok: { items: unknown[] } };
  expect(envelope.ok.items).toHaveLength(1);
});

const ignoredMine = pr({ id: "acme/widgets#14", number: 14, url: "https://example.invalid/14", headRefName: "y", isDraft: true, ignored: true, updatedAt: "2026-01-01T00:00:00Z" });
const ignoredReviewer = { ...quietPr, id: "acme/widgets#15", number: 15, url: "https://example.invalid/15", ignored: true, updatedAt: "2026-06-10T00:00:00Z" };
const ignoredWorld = { prs: ok("github", [draftPr, quietPr, ignoredMine, ignoredReviewer]) };
const baseOptions = { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" };

interface Payload { items: { key: string; ignored: boolean; actions: unknown[] }[]; omitted_ignored: number }

function payload(stdout: string): Payload {
  return (JSON.parse(stdout) as { ok: Payload }).ok;
}

const truncatedLinear: SourceResult<never> = { ok: false, source: "linear", code: "truncated", message: "failed", durationMs: 1 };

/** The widgets project with an ignore label and nothing to pause. */
function unreadableConfig(): typeof config {
  return {
    ...config,
    projects: config.projects.map((p) =>
      p.name === "widgets" && p.issueSource.kind === "linear" ? { ...p, issueSource: { ...p.issueSource, pausedStates: [] }, ignoreLabel: "Pohunek:Ignore" } : p,
    ),
  };
}

describe("ignored rows", () => {
  test("are hidden by default and counted in omitted_ignored", async () => {
    const out = await runList(config, baseOptions, deps(ignoredWorld));
    expect(out.items.map((i) => i.key)).toEqual(["github:acme/widgets#12", "github:acme/widgets#13"]);
    expect(payload(out.stdout).omitted_ignored).toBe(2);
  });

  test("--include-ignored lists them marked ignored with no actions and omits nothing", async () => {
    const out = await runList(config, { ...baseOptions, includeIgnored: true }, deps(ignoredWorld));
    const rows = payload(out.stdout);
    expect(rows.items.map((i) => [i.key, i.ignored])).toEqual([
      ["github:acme/widgets#12", false],
      ["github:acme/widgets#13", false],
      ["github:acme/widgets#14", true],
      ["github:acme/widgets#15", true],
    ]);
    expect(rows.items[2]?.actions).toEqual([]);
    expect(rows.omitted_ignored).toBe(0);
  });

  test("--mine hides an ignored row on the owner's turn and counts only ignored rows --mine would keep", async () => {
    const out = await runList(config, { ...baseOptions, mine: true }, deps(ignoredWorld));
    expect(out.items.map((i) => i.key)).toEqual(["github:acme/widgets#12"]);
    expect(payload(out.stdout).omitted_ignored).toBe(1);
  });

  test("--mine --include-ignored returns the ignored row whose computed verdict is me", async () => {
    const out = await runList(config, { ...baseOptions, mine: true, includeIgnored: true }, deps(ignoredWorld));
    expect(out.items.map((i) => [i.key, i.ignored, i.on_turn.actor])).toEqual([
      ["github:acme/widgets#12", false, "me"],
      ["github:acme/widgets#14", true, "me"],
    ]);
    expect(payload(out.stdout).omitted_ignored).toBe(0);
  });

  test("--stale-days drops a stale ignored row before it is counted", async () => {
    const clock = { ...deps(ignoredWorld), now: () => Date.parse("2026-06-15T00:00:00Z") };
    const out = await runList(config, { ...baseOptions, staleDays: 30 }, clock);
    // #14 is stale, #15 is not: only #15 is a hidden row the other filters keep.
    expect(payload(out.stdout).omitted_ignored).toBe(1);
  });

  test("the table ends with the hidden-row line only when rows are hidden", async () => {
    const hidden = await runList(config, { ...baseOptions, json: false }, deps(ignoredWorld));
    expect(hidden.stdout.split("\n").at(-1)).toBe("2 ignored row(s) hidden (use --include-ignored)");
    const shown = await runList(config, { ...baseOptions, json: false, includeIgnored: true }, deps(ignoredWorld));
    expect(shown.stdout).not.toContain("hidden");
    const marked = shown.stdout.split("\n").filter((line) => line.includes("(ignored)"));
    expect(marked.map((line) => line.split(" ")[0])).toEqual(["github:acme/widgets#14", "github:acme/widgets#15"]);
    expect(hidden.stdout).not.toContain("(ignored)");
  });

  test("without ignored rows omitted_ignored is 0 and the table has no hidden-row line", async () => {
    const world = { prs: ok("github", [draftPr]) };
    expect(payload((await runList(config, baseOptions, deps(world))).stdout).omitted_ignored).toBe(0);
    expect((await runList(config, { ...baseOptions, json: false }, deps(world))).stdout).not.toContain("hidden");
  });

  test("a row whose issue is unreadable is shown as unknown with no actions, not hidden and not actionable", async () => {
    const guarded = unreadableConfig();
    const failing = pr({ headRefName: "alice/ABC-1/spike", checks: [check("build", "failure")] });
    const out = await runList(guarded, baseOptions, deps({ prs: ok("github", [failing]), issues: truncatedLinear }));
    expect(out.items.map((i) => [i.ignored, i.on_turn.actor, i.on_turn.reason, i.actions])).toEqual([[false, "unknown", "linear:truncated", []]]);
    expect(payload(out.stdout).omitted_ignored).toBe(0);
  });

  test("a live session on a row whose issue is unreadable offers no attach", async () => {
    const guarded = unreadableConfig();
    const spike = pr({ headRefName: "alice/ABC-1/spike", isDraft: true });
    const live = session({ id: "s-1", projectLabel: "widgets", metadata: { "work.link.provider": "linear", "work.link.id": "ABC-1", "work.link.branch": spike.headRefName } });
    const world = { prs: ok("github", [spike]), sessions: ok("pohunek", [live]), issues: truncatedLinear };
    const out = await runList(guarded, baseOptions, deps(world));
    expect(out.items.map((i) => [i.key, i.on_turn.actor, i.actions])).toEqual([["linear:ABC-1", "unknown", []]]);
    const up = await runList(guarded, baseOptions, deps({ ...world, issues: ok("linear", [issue()]) }));
    expect(up.items[0]?.actions.map((a) => a.name)).toContain("attach");
  });

  test("a pull request linked to its issue only by a Linear attachment is unknown with no actions while Linear is down", async () => {
    const guarded = unreadableConfig();
    const attached = pr({ headRefName: "feature/x", checks: [check("build", "failure")] });
    const down = await runList(guarded, baseOptions, deps({ prs: ok("github", [attached]), issues: truncatedLinear }));
    expect(down.items.map((i) => [i.key, i.ignored, i.on_turn.actor, i.actions])).toEqual([["github:acme/widgets#12", false, "unknown", []]]);
    const parked = await runList(guarded, baseOptions, deps({ prs: ok("github", [attached]), issues: ok("linear", [issue({ ignored: true, attachmentUrls: [attached.url] })]) }));
    expect(parked.items).toEqual([]);
    expect(payload(parked.stdout).omitted_ignored).toBe(1);
  });

  test("an issue row is unknown with no actions while github is down, because its pull request may carry the label", async () => {
    const live = session({ id: "s-1", projectLabel: "widgets", metadata: { "work.link.provider": "linear", "work.link.id": "ABC-1" } });
    for (const code of ["truncated", "rate_limited"] as const) {
      const githubDown: SourceResult<never> = { ok: false, source: "github", code, message: "failed", durationMs: 1 };
      const world = { prs: githubDown, sessions: ok("pohunek", [live]), issues: ok("linear", [issue()]) };
      const out = await runList(unreadableConfig(), baseOptions, deps(world));
      expect(out.items.map((i) => [i.key, i.ignored, i.on_turn.actor, i.on_turn.reason, i.actions])).toEqual([["linear:ABC-1", false, "unknown", `github:${code}`, []]]);
      const plain = await runList(config, baseOptions, deps(world));
      expect(plain.items[0]?.actions.map((a) => a.name)).toContain("attach");
    }
  });

  test("an ignored issue hides its row too", async () => {
    const out = await runList(config, baseOptions, deps({ issues: ok("linear", [issue({ ignored: true })]) }));
    expect(out.items).toEqual([]);
    expect(payload(out.stdout).omitted_ignored).toBe(1);
  });
});

describe("an issue the issue source did not list", () => {
  const linearSpike = pr({ headRefName: "alice/ABC-1/spike", checks: [check("build", "failure")] });
  const githubSpike = pr({ headRefName: "alice/5/spike", checks: [check("build", "failure")], closingIssueNumbers: [5] });
  const githubParked = {
    ...config,
    projects: [
      { ...widgets, branchPattern: /^alice\/(?<key>[0-9]+)\//, branchPatternSource: "^alice/(?P<key>[0-9]+)/", issueSource: githubIssueSource, ignoreLabel: "Pohunek:Ignore" },
      githubGadgets,
    ],
  };
  const variants = [
    { name: "Linear", config: unreadableConfig(), spike: linearSpike, key: "ABC-1", rowKey: "linear:ABC-1", source: "linear" as const, list: { issues: ok("linear", []) } },
    { name: "GitHub", config: githubParked, spike: githubSpike, key: "acme/widgets#5", rowKey: "github-issue:acme/widgets#5", source: "github_issues" as const, list: { githubIssues: ok("github_issues", []) } },
  ];

  for (const variant of variants) {
    const run = (world: World, options = baseOptions): ReturnType<typeof runList> =>
      runList(variant.config, options, deps({ prs: ok("github", [variant.spike]), ...variant.list, ...world }));

    test(`${variant.name}: a labelled issue hides its row and is counted`, async () => {
      const lookups: string[][] = [];
      const world = { ignoredKeys: ok(variant.source, new Set([variant.key])), lookups };
      const hidden = await run(world);
      expect(hidden.items).toEqual([]);
      expect(payload(hidden.stdout).omitted_ignored).toBe(1);
      const shown = await run(world, { ...baseOptions, includeIgnored: true });
      expect(shown.items.map((i) => [i.key, i.ignored, i.actions, i.on_turn.rule])).toEqual([[variant.rowKey, true, [], 5]]);
      expect(lookups).toEqual([[variant.key], [variant.key]]);
    });

    test(`${variant.name}: an issue without the label leaves a normal row`, async () => {
      const out = await run({ ignoredKeys: ok(variant.source, new Set()) });
      expect(out.items.map((i) => [i.key, i.ignored, i.on_turn.actor, i.on_turn.rule])).toEqual([[variant.rowKey, false, "me", 5]]);
      expect(payload(out.stdout).omitted_ignored).toBe(0);
    });

    test(`${variant.name}: a failed lookup makes the row unknown with no actions and is a source failure`, async () => {
      const failure: SourceResult<never> = { ok: false, source: variant.source, code: "truncated", message: "failed", durationMs: 1 };
      const out = await run({ ignoredKeys: failure });
      expect(out.items.map((i) => [i.key, i.ignored, i.on_turn.actor, i.on_turn.reason, i.actions])).toEqual([
        [variant.rowKey, false, "unknown", `${variant.source}:truncated`, []],
      ]);
      expect(out.sourceFailures).toEqual([`widgets ${variant.source} lookup: ${variant.source}:truncated`]);
    });

    test(`${variant.name}: a project without an ignore label asks nothing`, async () => {
      const lookups: string[][] = [];
      const plain = { ...variant.config, projects: variant.config.projects.map((p) => ({ ...p, ignoreLabel: null })) };
      const out = await runList(plain, baseOptions, deps({ prs: ok("github", [variant.spike]), ...variant.list, lookups }));
      expect(out.items.map((i) => i.on_turn.rule)).toEqual([5]);
      expect(lookups).toEqual([]);
    });
  }

  test("nothing is asked when the issue source returned the issue, and a keyless Linear pull request is asked for by URL only", async () => {
    const lookups: string[][] = [];
    const listed = await runList(unreadableConfig(), baseOptions, deps({ prs: ok("github", [linearSpike]), issues: ok("linear", [issue()]), lookups }));
    expect(listed.items).toHaveLength(1);
    expect(lookups).toEqual([]);
    const keyless = await runList(unreadableConfig(), baseOptions, deps({ prs: ok("github", [draftPr]), ignoredKeys: ok("linear", new Set()), lookups }));
    expect(keyless.items.map((i) => [i.key, i.ignored])).toEqual([["github:acme/widgets#12", false]]);
    expect(lookups).toEqual([[`url:${draftPr.url}`]]);
  });

  test("Linear: a keyless pull request attached to a labelled issue is hidden and counted, and a failed lookup makes it unknown", async () => {
    const world = { prs: ok("github", [draftPr]), issues: ok("linear", []) };
    const hidden = await runList(unreadableConfig(), baseOptions, deps({ ...world, ignoredKeys: ok("linear", new Set([draftPr.url])) }));
    expect(hidden.items).toEqual([]);
    expect(payload(hidden.stdout).omitted_ignored).toBe(1);
    const shown = await runList(unreadableConfig(), { ...baseOptions, includeIgnored: true }, deps({ ...world, ignoredKeys: ok("linear", new Set([draftPr.url])) }));
    expect(shown.items.map((i) => [i.key, i.ignored, i.actions])).toEqual([["github:acme/widgets#12", true, []]]);
    const failure: SourceResult<never> = { ok: false, source: "linear", code: "truncated", message: "failed", durationMs: 1 };
    const down = await runList(unreadableConfig(), baseOptions, deps({ ...world, ignoredKeys: failure }));
    expect(down.items.map((i) => [i.on_turn.actor, i.on_turn.reason, i.actions])).toEqual([["unknown", "linear:truncated", []]]);
  });
});

test("--stale-days leaves out pull requests not updated for that long, unless a session runs", async () => {
  const stale = pr({ headRefName: "feature/abc-1", updatedAt: "2026-01-01T00:00:00Z" });
  const fresh = pr({ id: "acme/widgets#13", number: 13, url: "https://example.invalid/13", headRefName: "x", updatedAt: "2026-06-10T00:00:00Z" });
  const world = { prs: ok("github", [stale, fresh]) };
  const withClock = { ...deps(world), now: () => Date.parse("2026-06-15T00:00:00Z") };
  const shown = await runList(config, { mine: false, staleDays: 30, includeIgnored: false, json: true, project: "widgets" }, withClock);
  expect(shown.items.map((i) => i.key)).toEqual(["github:acme/widgets#13"]);
  const all = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, withClock);
  expect(all.items).toHaveLength(2);
  const running = session({ id: "s-d", projectLabel: "widgets", metadata: { "work.link.id": stale.id, "work.link.provider": "github" } });
  const kept = await runList(config, { mine: false, staleDays: 30, includeIgnored: false, json: true, project: "widgets" }, { ...deps({ ...world, sessions: ok("pohunek", [running]) }), now: withClock.now });
  expect(kept.items.map((i) => i.key)).toContain("github:acme/widgets#12");
});

test("a failed github source turns every row unknown with the source code", async () => {
  const result = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ prs: fail("github", "rate_limited"), issues: ok("linear", [issue()]) }),
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.on_turn).toEqual({ actor: "unknown", reason: "github:rate_limited", rule: null });
  expect(result.items[0]?.sources).toEqual({ github: "rate_limited", github_merged: "ok", linear: "ok", github_issues: "unused", pohunek: "ok" });
});

test("a failed pohunek call marks pohunek unknown but rules not needing it still decide only after rules 1-2", async () => {
  const result = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ prs: ok("github", [draftPr]), sessions: fail("pohunek", "timeout") }),
  );
  expect(result.items[0]?.on_turn.actor).toBe("unknown");
  expect(result.items[0]?.sources.pohunek).toBe("timeout");
});

test("linked live session on the row makes the agent's turn when working", async () => {
  const linked = session({
    activity: "working",
    projectLabel: "widgets",
    metadata: { "work.link.id": "acme/widgets#12", "work.role": "babysit" },
  });
  const result = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ prs: ok("github", [draftPr]), sessions: ok("pohunek", [linked]) }),
  );
  expect(result.items[0]?.on_turn).toEqual({ actor: "agent", reason: "working", rule: 2 });
  expect(result.items[0]?.sessions[0]?.role).toBe("babysit");
});

test("table output is produced without --json", async () => {
  const result = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: false, project: "widgets" }, deps({ prs: ok("github", [draftPr]) }));
  expect(result.stdout).toContain("KEY");
  expect(result.stdout).toContain("me: leave draft (r6)");
});

test("selectProjects leaves out unregistered and origin-mismatched projects without guessing", () => {
  const missing = selectProjects(config, ok("pohunek", [registry[1] as PohunekProject]), null);
  expect(missing.projects.map((p) => p.pohunekLabel)).not.toContain("widgets");
  expect(missing.warnings.some((w) => w.includes("widgets") && w.includes("no pohunek project"))).toBe(true);
  const mismatch = selectProjects(
    config,
    ok("pohunek", [{ ...(registry[0] as PohunekProject), originUrl: "git@github.com:other/repo.git" }]),
    "widgets",
  );
  expect(mismatch.projects).toEqual([]);
  expect(mismatch.warnings[0]).toContain("origin_url");
});

test("with the registry unavailable every configured project is listed", () => {
  const selected = selectProjects(config, fail("pohunek", "timeout"), null);
  expect(selected.projects.length).toBe(config.projects.length);
});

test("unknown --project label warns", async () => {
  const result = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: false, project: "nope" }, deps({}));
  expect(result.warnings).toEqual(["project nope: no configuration file for this label"]);
});

test("read-only: list never launches a session", async () => {
  let launches = 0;
  const base = deps({ prs: ok("github", [draftPr]) });
  const pohunek: PohunekClient = {
    ...base.pohunek,
    launchSession: () => {
      launches += 1;
      return Promise.reject(new Error("list never launches a session"));
    },
  };
  await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, { ...base, pohunek });
  expect(launches).toBe(0);
});

test("failed sources are reported regardless of the --mine filter", async () => {
  const result = await runList(
    config,
    { mine: true, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ prs: fail("github", "rate_limited"), issues: ok("linear", [issue()]), sessions: fail("pohunek", "timeout") }),
  );
  expect(result.items).toEqual([]);
  expect(result.sourceFailures).toEqual(["pohunek: timeout", "widgets github: rate_limited"]);
  const envelope = JSON.parse(result.stdout) as { ok: { projects: { project: string; sources: Record<string, string> }[] } };
  expect(envelope.ok.projects[0]).toEqual({
    project: "widgets",
    sources: { github: "rate_limited", github_merged: "ok", linear: "ok", github_issues: "unused", pohunek: "timeout" },
  });
});

test("a registry failure counts as a pohunek failure", async () => {
  const result = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ registry: fail("pohunek", "timeout") }),
  );
  expect(result.sourceFailures).toContain("pohunek: timeout");
});

test("no failures are reported when every source answers", async () => {
  const result = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps({}));
  expect(result.sourceFailures).toEqual([]);
});

test("a failed linear source marks issue rows unknown with the linear code", async () => {
  const result = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ prs: ok("github", [draftPr]), issues: fail("linear", "timeout") }),
  );
  expect(result.items[0]?.on_turn).toEqual({ actor: "me", reason: "leave draft", rule: 6 });
  expect(result.items[0]?.sources).toEqual({ github: "ok", github_merged: "ok", linear: "timeout", github_issues: "unused", pohunek: "ok" });
  expect(result.items[0]?.no_issue).toBe(false);
  expect(result.sourceFailures).toEqual(["widgets linear: timeout"]);
});

test("a started issue without a pull request or live session is on my turn (rule 8)", async () => {
  const result = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ issues: ok("linear", [issue()]), prs: ok("github", []) }),
  );
  expect(result.items[0]?.on_turn).toEqual({ actor: "me", reason: "nothing runs", rule: 8 });
});

test("live sessions without a link are listed as unlinked, hidden under --mine", async () => {
  const unlinked = session({ id: "s-77", name: "scratch", projectLabel: "widgets", metadata: {} });
  const all = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps({ sessions: ok("pohunek", [unlinked]) }));
  const envelope = JSON.parse(all.stdout) as { ok: { unlinked_sessions: { id: string; project: string }[] } };
  expect(envelope.ok.unlinked_sessions.map((u) => [u.id, u.project])).toEqual([["s-77", "widgets"]]);
  const mine = await runList(config, { mine: true, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps({ sessions: ok("pohunek", [unlinked]) }));
  expect((JSON.parse(mine.stdout) as { ok: { unlinked_sessions: unknown[] } }).ok.unlinked_sessions).toEqual([]);
});

const onHold = issue({ state: "On hold", paused: true });
const working = session({ id: "s-work", activity: "working", metadata: { "work.link.id": "ABC-1", "work.link.provider": "linear" } });

test("a paused issue with a conflicting draft pull request is paused with no action and left out of --mine", async () => {
  const conflicting = pr({ headRefName: "alice/ABC-1/work", isDraft: true, mergeable: "CONFLICTING" });
  const owner = session({ id: "s-own", activity: "idle", worktreePath: "/wt/abc-1", metadata: { "work.link.id": "ABC-1", "work.link.provider": "linear" } });
  const world = { issues: ok("linear", [onHold]), prs: ok("github", [conflicting]), sessions: ok("pohunek", [owner]) };
  const all = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps(world));
  expect(all.items.map((i) => [i.key, i.on_turn, i.actions])).toEqual([
    ["linear:ABC-1", { actor: "paused", reason: "paused", rule: 12 }, []],
  ]);
  const mine = await runList(config, { mine: true, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps(world));
  expect(mine.items).toEqual([]);
  const resumed = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ ...world, issues: ok("linear", [issue()]) }),
  );
  expect(resumed.items[0]?.on_turn).toEqual({ actor: "me", reason: "rebase", rule: 5 });
  expect(resumed.items[0]?.actions.map((a) => a.name)).toEqual(["rebase", "attach"]);
});

test("a working session linked to a paused issue with a pull request keeps the row on the agent", async () => {
  const conflicting = pr({ headRefName: "alice/ABC-1/work", mergeable: "CONFLICTING" });
  const withPr = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ issues: ok("linear", [onHold]), prs: ok("github", [conflicting]), sessions: ok("pohunek", [working]) }),
  );
  expect(withPr.items.map((i) => [i.key, i.on_turn])).toEqual([["linear:ABC-1", { actor: "agent", reason: "working", rule: 2 }]]);
});

test("a paused issue without a pull request has no row, so its working session is neither listed nor orphaned", async () => {
  const withoutPr = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ issues: ok("linear", [onHold]), sessions: ok("pohunek", [working]) }),
  );
  expect(withoutPr.items).toEqual([]);
  const envelope = JSON.parse(withoutPr.stdout) as { ok: { orphaned_sessions: unknown[] } };
  expect(envelope.ok.orphaned_sessions).toEqual([]);
});

test("a pull request joined by branch is unknown while Linear is down, since its issue may be paused", async () => {
  const conflicting = pr({ headRefName: "alice/ABC-1/work", mergeable: "CONFLICTING" });
  const result = await runList(
    config,
    { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" },
    deps({ issues: fail("linear", "timeout"), prs: ok("github", [conflicting]) }),
  );
  expect(result.items.map((i) => [i.key, i.on_turn, i.actions])).toEqual([
    ["linear:ABC-1", { actor: "unknown", reason: "linear:timeout", rule: null }, []],
  ]);
});

test("an issue whose pull request is merged is on my turn to close or follow up and offers no implement", async () => {
  const world = {
    issues: ok("linear", [issue()]),
    merged: ok("github", [mergedPr({ headRefName: "alice/ABC-1/widget-cache" })]),
  };
  const out = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps(world));
  expect(out.items).toHaveLength(1);
  expect(out.items[0]?.on_turn).toEqual({ actor: "me", reason: "close or follow up", rule: 13 });
  expect(out.items[0]?.actions).toEqual([]);
});

test("an issue with no merged pull request still offers implement", async () => {
  const world = { issues: ok("linear", [issue()]) };
  const out = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps(world));
  expect(out.items[0]?.on_turn.rule).toBe(8);
  expect(out.items[0]?.actions.map((a) => a.name)).toEqual(["implement"]);
});

test("a failed merged lookup makes only the issue-only row unknown and PR rows keep their rules", async () => {
  const world = {
    issues: ok("linear", [issue({ id: "ABC-2" })]),
    prs: ok("github", [draftPr]),
    merged: fail("github", "rate_limited"),
  };
  const out = await runList(config, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps(world));
  const byKey = new Map(out.items.map((i) => [i.key, i]));
  expect(byKey.get("github:acme/widgets#12")?.on_turn).toEqual({ actor: "me", reason: "leave draft", rule: 6 });
  expect(byKey.get("linear:ABC-2")?.on_turn).toEqual({ actor: "unknown", reason: "github_merged:rate_limited", rule: null });
  expect(byKey.get("linear:ABC-2")?.actions).toEqual([]);
  expect(byKey.get("linear:ABC-2")?.sources).toEqual({ github: "ok", github_merged: "rate_limited", linear: "ok", github_issues: "unused", pohunek: "ok" });
  expect(out.sourceFailures).toEqual(["widgets github_merged: rate_limited"]);
});

const gadgets = config.projects.find((p) => p.pohunekLabel === "gadgets");
if (gadgets === undefined) throw new Error("fixture project gadgets missing");
const githubGadgets = { ...gadgets, issueSource: githubIssueSource };
const githubOnly = { ...config, global: { ...config.global, linear: null }, projects: [{ ...widgets, issueSource: githubIssueSource }, githubGadgets] };
const mixed = { ...config, projects: [widgets, githubGadgets] };

function spiedDeps(world: World): { deps: Parameters<typeof runList>[2]; fetched: string[] } {
  const fetched: string[] = [];
  const base = deps(world);
  return {
    fetched,
    deps: {
      ...base,
      linear: {
        fetchIssues: (project) => {
          fetched.push(project.pohunekLabel);
          return Promise.resolve(world.issues ?? ok("linear", []));
        },
        fetchIgnoredKeys: () => Promise.reject(new Error("not used")),
      },
    },
  };
}

test("a github-only configuration never touches Linear and reports no source failure", async () => {
  const { deps: spied, fetched } = spiedDeps({ prs: ok("github", [draftPr]) });
  const output = await runList(githubOnly, { mine: false, staleDays: null, includeIgnored: false, json: true, project: null }, { ...spied, linear: null });
  expect(fetched).toEqual([]);
  expect(output.sourceFailures).toEqual([]);
  const envelope = JSON.parse(output.stdout) as {
    ok: { projects: { project: string; sources: Record<string, string> }[]; items: { key: string; issue_key: unknown; no_issue: boolean }[] };
  };
  expect(envelope.ok.projects.map((p) => p.sources["linear"])).toEqual(["unused", "unused"]);
  expect(envelope.ok.projects.map((p) => p.sources["github_issues"])).toEqual(["ok", "ok"]);
  expect(envelope.ok.items.every((i) => i.key.startsWith("github:") && i.issue_key === null && i.no_issue)).toBe(true);
});

test("a github-only configuration does not call the Linear source even when one is supplied", async () => {
  const { deps: spied, fetched } = spiedDeps({ prs: ok("github", [draftPr]) });
  const output = await runList(githubOnly, { mine: false, staleDays: null, includeIgnored: false, json: false, project: null }, spied);
  expect(fetched).toEqual([]);
  expect(output.sourceFailures).toEqual([]);
});

test("a mixed configuration queries Linear only for the Linear project", async () => {
  const { deps: spied, fetched } = spiedDeps({ issues: fail("linear", "timeout") });
  const output = await runList(mixed, { mine: false, staleDays: null, includeIgnored: false, json: true, project: null }, spied);
  expect(fetched).toEqual(["widgets"]);
  expect(output.sourceFailures).toEqual(["widgets linear: timeout"]);
  const envelope = JSON.parse(output.stdout) as { ok: { projects: { project: string; sources: Record<string, string> }[] } };
  const byProject = Object.fromEntries(envelope.ok.projects.map((p) => [p.project, p.sources["linear"]]));
  expect(byProject).toEqual({ widgets: "timeout", gadgets: "unused" });
});

test("a Linear project without a Linear source is a programming error, not a silent skip", async () => {
  const run = runList(mixed, { mine: false, staleDays: null, includeIgnored: false, json: true, project: null }, { ...deps({}), linear: null });
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("uses Linear");
});

describe("a project whose issues come from GitHub", () => {
  const numeric = { branchPattern: /^alice\/(?<key>[0-9]+)\//, branchPatternSource: "^alice/(?P<key>[0-9]+)/" };
  const githubWidgets = { ...config, projects: [{ ...widgets, ...numeric, issueSource: githubIssueSource }, githubGadgets] };
  const startedIssue = issue({ id: "acme/widgets#7", state: "in-progress", title: "Cache widgets" });
  const run = (world: World): Promise<Awaited<ReturnType<typeof runList>>> =>
    runList(githubWidgets, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, deps(world));

  test("a started issue is a github-issue row on rule 8 and the sources name github_issues", async () => {
    const out = await run({ githubIssues: ok("github_issues", [startedIssue]) });
    expect(out.items.map((item) => [item.key, item.issue_key, item.on_turn.rule])).toEqual([["github-issue:acme/widgets#7", "acme/widgets#7", 8]]);
    expect(out.items[0]?.issue).toEqual({ id: "acme/widgets#7", title: "Cache widgets", state: "in-progress", url: startedIssue.url });
    expect(out.items[0]?.sources).toEqual({ github: "ok", github_merged: "ok", linear: "unused", github_issues: "ok", pohunek: "ok" });
  });

  test("rule 13: a started issue whose branch already merged is close or follow up, not nothing runs", async () => {
    const out = await run({ githubIssues: ok("github_issues", [startedIssue]), merged: ok("github", [mergedPr({ headRefName: "alice/7/cache" })]) });
    expect(out.items[0]?.on_turn).toEqual({ actor: "me", reason: "close or follow up", rule: 13 });
  });

  test("a failing issue source is a source failure and leaves a pull request joined by branch pattern unknown, never the reviewer's", async () => {
    const waiting = pr({ headRefName: "alice/7/cache", reviewDecision: "APPROVED", checks: [check("b", "pending")] });
    const out = await run({ githubIssues: fail("github_issues", "timeout"), prs: ok("github", [waiting]) });
    expect(out.sourceFailures).toEqual(["widgets github_issues: timeout"]);
    expect(out.items[0]?.key).toBe("github-issue:acme/widgets#7");
    expect(out.items[0]?.on_turn).toEqual({ actor: "unknown", reason: "github_issues:timeout", rule: null });
    expect(out.items[0]?.sources).toMatchObject({ linear: "unused", github_issues: "timeout" });
  });

  test("a pull request that closes an issue is joined to its row", async () => {
    const closes = pr({ headRefName: "feature/cache", isDraft: true, closingIssueNumbers: [7] });
    const out = await run({ githubIssues: ok("github_issues", [startedIssue]), prs: ok("github", [closes]) });
    expect(out.items.map((item) => [item.key, item.pull_request?.id, item.on_turn.rule])).toEqual([["github-issue:acme/widgets#7", "acme/widgets#12", 6]]);
  });

  test("the Linear source is never called and the project reports linear unused", async () => {
    const calls: string[] = [];
    const spied = { ...deps({ githubIssues: ok("github_issues", []) }), linear: { fetchIssues: () => { calls.push("linear"); return Promise.resolve(ok("linear", [])); }, fetchIgnoredKeys: () => Promise.reject(new Error("not used")) } };
    const out = await runList(githubWidgets, { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" }, spied);
    expect(calls).toEqual([]);
    expect((JSON.parse(out.stdout) as { ok: { projects: { sources: Record<string, string> }[] } }).ok.projects[0]?.sources["linear"]).toBe("unused");
  });
});

test("external reviews give rule 3 to the agent, offer no action and still yield to a working linked session", async () => {
  const external = { ...config, projects: config.projects.map((p) => (p.name === "widgets" ? { ...p, reviews: "external" as const } : p)) };
  const requested = pr({ relation: "review_requested", headRefName: "feature/theirs" });
  const request = { mine: false, staleDays: null, includeIgnored: false, json: true, project: "widgets" };
  const bare = await runList(external, request, deps({ prs: ok("github", [requested]) }));
  expect(bare.items[0]?.on_turn).toEqual({ actor: "agent", reason: "external review", rule: 3 });
  expect(bare.items[0]?.actions).toEqual([]);
  const mineOnly = await runList(external, { ...request, mine: true }, deps({ prs: ok("github", [requested]) }));
  expect(mineOnly.items).toEqual([]);
  const linked = session({ activity: "working", projectLabel: "widgets", metadata: { "work.link.id": requested.id, "work.link.provider": "github" } });
  const joined = await runList(external, request, deps({ prs: ok("github", [requested]), sessions: ok("pohunek", [linked]) }));
  expect(joined.items[0]?.on_turn).toEqual({ actor: "agent", reason: "working", rule: 2 });
  const session3 = await runList(config, request, deps({ prs: ok("github", [requested]) }));
  expect(session3.items[0]?.on_turn).toEqual({ actor: "me", reason: "review", rule: 3 });
  expect(session3.items[0]?.actions.map((a) => a.name)).toEqual(["review"]);
});
