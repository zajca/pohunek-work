import { expect, test } from "bun:test";
import { runList, selectProjects } from "../../src/commands/list.ts";
import { loadConfig } from "../../src/config/index.ts";
import type { Logger } from "../../src/log.ts";
import type { PohunekClient } from "../../src/sources/pohunek.ts";
import type {
  LinearIssue,
  PohunekProject,
  PohunekSession,
  PullRequest,
  SourceResult,
} from "../../src/types/sources.ts";
import { check, issue, pr, session } from "../rules/builders.ts";

const config = await loadConfig(new URL("../fixtures/config", import.meta.url).pathname);
const widgets = config.projects.find((p) => p.pohunekLabel === "widgets");
if (widgets === undefined) throw new Error("fixture project widgets missing");

function ok<T>(source: "github" | "linear" | "pohunek", data: T): SourceResult<T> {
  return { ok: true, source, data, durationMs: 1 };
}
function fail(source: "github" | "linear" | "pohunek", code: "rate_limited" | "timeout"): SourceResult<never> {
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
  issues?: SourceResult<readonly LinearIssue[]>;
  sessions?: SourceResult<readonly PohunekSession[]>;
  registry?: SourceResult<readonly PohunekProject[]>;
}

function deps(world: World): Parameters<typeof runList>[2] {
  const pohunek: PohunekClient = {
    listProjects: () => Promise.resolve(world.registry ?? ok("pohunek", registry)),
    listSessions: () => Promise.resolve(world.sessions ?? ok("pohunek", [])),
    listNotifications: () => Promise.resolve(ok("pohunek", [])),
    launchSession: () => Promise.reject(new Error("not used")),
  };
  return {
    pohunek,
    github: { fetchPullRequests: () => Promise.resolve(world.prs ?? ok("github", [])) },
    linear: { fetchIssues: () => Promise.resolve(world.issues ?? ok("linear", [])) },
    logger: silentLogger,
    cliVersion: "0.1.0",
  };
}

const draftPr = pr({ headRefName: "feature/abc-1", isDraft: true });
const quietPr = pr({ id: "acme/widgets#13", number: 13, url: "https://example.invalid/13", headRefName: "x", reviewDecision: "APPROVED", checks: [check("b", "pending")] });

test("json output lists rows and --mine keeps only the owner's turn", async () => {
  const world = { prs: ok("github", [draftPr, quietPr]) };
  const all = await runList(config, { mine: false, json: true, project: "widgets" }, deps(world));
  const mine = await runList(config, { mine: true, json: true, project: "widgets" }, deps(world));
  expect(all.items.map((i) => i.on_turn.actor)).toEqual(["me", "reviewer"]);
  expect(mine.items.map((i) => i.key)).toEqual(["github:acme/widgets#12"]);
  const envelope = JSON.parse(mine.stdout) as { ok: { items: unknown[] } };
  expect(envelope.ok.items).toHaveLength(1);
});

test("a failed github source turns every row unknown with the source code", async () => {
  const result = await runList(
    config,
    { mine: false, json: true, project: "widgets" },
    deps({ prs: fail("github", "rate_limited"), issues: ok("linear", [issue()]) }),
  );
  expect(result.items).toHaveLength(1);
  expect(result.items[0]?.on_turn).toEqual({ actor: "unknown", reason: "github:rate_limited", rule: null });
  expect(result.items[0]?.sources).toEqual({ github: "rate_limited", linear: "ok", pohunek: "ok" });
});

test("a failed pohunek call marks pohunek unknown but rules not needing it still decide only after rules 1-2", async () => {
  const result = await runList(
    config,
    { mine: false, json: true, project: "widgets" },
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
    { mine: false, json: true, project: "widgets" },
    deps({ prs: ok("github", [draftPr]), sessions: ok("pohunek", [linked]) }),
  );
  expect(result.items[0]?.on_turn).toEqual({ actor: "agent", reason: "working", rule: 2 });
  expect(result.items[0]?.sessions[0]?.role).toBe("babysit");
});

test("table output is produced without --json", async () => {
  const result = await runList(config, { mine: false, json: false, project: "widgets" }, deps({ prs: ok("github", [draftPr]) }));
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
  const result = await runList(config, { mine: false, json: false, project: "nope" }, deps({}));
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
  await runList(config, { mine: false, json: true, project: "widgets" }, { ...base, pohunek });
  expect(launches).toBe(0);
});

test("failed sources are reported regardless of the --mine filter", async () => {
  const result = await runList(
    config,
    { mine: true, json: true, project: "widgets" },
    deps({ prs: fail("github", "rate_limited"), issues: ok("linear", [issue()]), sessions: fail("pohunek", "timeout") }),
  );
  expect(result.items).toEqual([]);
  expect(result.sourceFailures).toEqual(["pohunek: timeout", "widgets github: rate_limited"]);
  const envelope = JSON.parse(result.stdout) as { ok: { projects: { project: string; sources: Record<string, string> }[] } };
  expect(envelope.ok.projects[0]).toEqual({
    project: "widgets",
    sources: { github: "rate_limited", linear: "ok", pohunek: "timeout" },
  });
});

test("a registry failure counts as a pohunek failure", async () => {
  const result = await runList(
    config,
    { mine: false, json: true, project: "widgets" },
    deps({ registry: fail("pohunek", "timeout") }),
  );
  expect(result.sourceFailures).toContain("pohunek: timeout");
});

test("no failures are reported when every source answers", async () => {
  const result = await runList(config, { mine: false, json: true, project: "widgets" }, deps({}));
  expect(result.sourceFailures).toEqual([]);
});

test("a failed linear source marks issue rows unknown with the linear code", async () => {
  const result = await runList(
    config,
    { mine: false, json: true, project: "widgets" },
    deps({ prs: ok("github", [draftPr]), issues: fail("linear", "timeout") }),
  );
  expect(result.items[0]?.on_turn).toEqual({ actor: "me", reason: "leave draft", rule: 6 });
  expect(result.items[0]?.sources).toEqual({ github: "ok", linear: "timeout", pohunek: "ok" });
  expect(result.items[0]?.no_issue).toBe(false);
  expect(result.sourceFailures).toEqual(["widgets linear: timeout"]);
});

test("a started issue without a pull request or live session is on my turn (rule 8)", async () => {
  const result = await runList(
    config,
    { mine: false, json: true, project: "widgets" },
    deps({ issues: ok("linear", [issue()]), prs: ok("github", []) }),
  );
  expect(result.items[0]?.on_turn).toEqual({ actor: "me", reason: "nothing runs", rule: 8 });
});

test("live sessions without a link are listed as unlinked, hidden under --mine", async () => {
  const unlinked = session({ id: "s-77", name: "scratch", projectLabel: "widgets", metadata: {} });
  const all = await runList(config, { mine: false, json: true, project: "widgets" }, deps({ sessions: ok("pohunek", [unlinked]) }));
  const envelope = JSON.parse(all.stdout) as { ok: { unlinked_sessions: { id: string; project: string }[] } };
  expect(envelope.ok.unlinked_sessions.map((u) => [u.id, u.project])).toEqual([["s-77", "widgets"]]);
  const mine = await runList(config, { mine: true, json: true, project: "widgets" }, deps({ sessions: ok("pohunek", [unlinked]) }));
  expect((JSON.parse(mine.stdout) as { ok: { unlinked_sessions: unknown[] } }).ok.unlinked_sessions).toEqual([]);
});
