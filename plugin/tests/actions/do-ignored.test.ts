// `do` on a row that carries the ignore label: refused unless --include-ignored.
import { describe, expect, test } from "bun:test";
import { runDo } from "../../src/commands/do.ts";
import { ActionError } from "../../src/actions/types.ts";
import type { Logger } from "../../src/log.ts";
import { githubIssueSource, issue, pr, session } from "../rules/builders.ts";
import { baseConfig, expectRefusal, ok, options, refusal, setup, type Envelope } from "./harness.ts";

const PARKED = pr({ headRefName: "feature/x", isDraft: true, ignored: true });
const OPEN = pr({ headRefName: "feature/x", isDraft: true });
const KEY = `github:${PARKED.id}`;

for (const action of ["fix-ci", "ready", "attach"] as const) {
  for (const dryRun of [true, false]) {
    test(`${action} (dryRun ${String(dryRun)}) on an ignored row is refused before anything runs`, async () => {
      const { deps, commands, launches } = setup({ prs: ok("github", [PARKED]) });
      const error = await refusal(runDo(baseConfig, options({ key: KEY, action, dryRun, yes: !dryRun }), deps));
      expect(error).toBeInstanceOf(ActionError);
      expect(error.code).toBe("precondition_failed");
      expect(error.message).toContain(KEY);
      expect(error.message).toContain("--include-ignored");
      expect(commands).toHaveLength(0);
      expect(launches).toHaveLength(0);
    });
  }
}

test("the refusal is logged like any other refusal", async () => {
  const events: string[] = [];
  const { deps } = setup({ prs: ok("github", [PARKED]) });
  const logger: Logger = { ...deps.logger, error: (event) => void events.push(event) };
  await expectRefusal(runDo(baseConfig, options({ key: KEY, action: "ready", dryRun: true, yes: false }), { ...deps, logger }), "precondition_failed", "ignore label");
  expect(events).toContain("do_refused");
});

test("--include-ignored lets the normal preconditions decide for ready and attach", async () => {
  const { deps } = setup({ prs: ok("github", [PARKED]) });
  const ready = await runDo(baseConfig, options({ key: KEY, action: "ready", dryRun: true, yes: false, includeIgnored: true }), deps);
  expect((JSON.parse(ready.stdout) as Envelope).ok.dry_run).toBe(true);
  const attach = await refusal(runDo(baseConfig, options({ key: KEY, action: "attach", dryRun: true, yes: false, includeIgnored: true }), deps));
  expect(attach.message).not.toContain("--include-ignored");
});

test("--include-ignored plans a launch action on an ignored row", async () => {
  const conflicting = pr({ headRefName: "feature/x", mergeable: "CONFLICTING", ignored: true });
  const { deps } = setup({ prs: ok("github", [conflicting]) });
  const out = await runDo(baseConfig, options({ key: `github:${conflicting.id}`, action: "rebase", profile: "profile-a", dryRun: true, yes: false, includeIgnored: true }), deps);
  expect((JSON.parse(out.stdout) as Envelope).ok.dry_run).toBe(true);
});

test("a row without the ignore label is unaffected by the flag", async () => {
  for (const includeIgnored of [false, true]) {
    const { deps } = setup({ prs: ok("github", [OPEN]) });
    const out = await runDo(baseConfig, options({ key: KEY, action: "ready", dryRun: true, yes: false, includeIgnored }), deps);
    expect((JSON.parse(out.stdout) as Envelope).ok.dry_run).toBe(true);
  }
});

test("fix-ci on a row whose issue cannot be read is refused: the issue may carry the ignore label", async () => {
  const guarded = {
    ...baseConfig,
    projects: baseConfig.projects.map((p) =>
      p.name === "widgets" && p.issueSource.kind === "linear" ? { ...p, issueSource: { ...p.issueSource, pausedStates: [] }, ignoreLabel: "Pohunek:Ignore" } : p,
    ),
  };
  const failing = pr({ headRefName: "alice/ABC-1/spike", checks: [{ name: "build", outcome: "failure" }] });
  const truncated = { ok: false, source: "linear", code: "truncated", message: "failed", durationMs: 1 } as const;
  const { deps, commands, launches } = setup({ prs: ok("github", [failing]), issues: truncated });
  for (const dryRun of [true, false]) {
    const error = await refusal(runDo(guarded, options({ key: "linear:ABC-1", action: "fix-ci", profile: "profile-a", dryRun, yes: !dryRun }), deps));
    expect(error.code).toBe("source_unavailable");
    expect(error.message).toContain("linear:truncated");
  }
  expect(commands).toHaveLength(0);
  expect(launches).toHaveLength(0);
});

test("attach on a row whose issue cannot be read is refused: list offers no action on it", async () => {
  const guarded = {
    ...baseConfig,
    projects: baseConfig.projects.map((p) =>
      p.name === "widgets" && p.issueSource.kind === "linear" ? { ...p, issueSource: { ...p.issueSource, pausedStates: [] }, ignoreLabel: "Pohunek:Ignore" } : p,
    ),
  };
  const spike = pr({ headRefName: "alice/ABC-1/spike" });
  const live = session({ id: "s-1", metadata: { "work.link.provider": "linear", "work.link.id": "ABC-1", "work.link.branch": spike.headRefName } });
  const truncated = { ok: false, source: "linear", code: "truncated", message: "failed", durationMs: 1 } as const;
  const { deps, attached } = setup({ prs: ok("github", [spike]), sessions: [live], issues: truncated });
  for (const dryRun of [true, false]) {
    const error = await refusal(runDo(guarded, options({ key: "linear:ABC-1", action: "attach", dryRun, yes: !dryRun }), deps));
    expect(error.code).toBe("source_unavailable");
    expect(error.message).toContain("linear:truncated");
  }
  expect(attached).toHaveLength(0);
});

test("attach on an issue row is refused while github is down: its pull request may carry the ignore label", async () => {
  const guarded = {
    ...baseConfig,
    projects: baseConfig.projects.map((p) =>
      p.name === "widgets" && p.issueSource.kind === "linear" ? { ...p, issueSource: { ...p.issueSource, pausedStates: [] }, ignoreLabel: "Pohunek:Ignore" } : p,
    ),
  };
  const live = session({ id: "s-1", metadata: { "work.link.provider": "linear", "work.link.id": "ABC-1" } });
  for (const code of ["truncated", "rate_limited"] as const) {
    const githubDown = { ok: false, source: "github", code, message: "failed", durationMs: 1 } as const;
    const { deps, attached } = setup({ prs: githubDown, sessions: [live], issues: ok("linear", [issue()]) });
    for (const dryRun of [true, false]) {
      const error = await refusal(runDo(guarded, options({ key: "linear:ABC-1", action: "attach", dryRun, yes: !dryRun }), deps));
      expect(error.code).toBe("source_unavailable");
      expect(error.message).toContain(`github:${code}`);
    }
    expect(attached).toHaveLength(0);
  }
});

describe("an issue the issue source did not list", () => {
  const parkedLinear = {
    ...baseConfig,
    projects: baseConfig.projects.map((p) =>
      p.name === "widgets" && p.issueSource.kind === "linear" ? { ...p, issueSource: { ...p.issueSource, pausedStates: [] }, ignoreLabel: "Pohunek:Ignore" } : p,
    ),
  };
  const parkedGithub = {
    ...baseConfig,
    projects: baseConfig.projects.map((p) =>
      p.name === "widgets"
        ? { ...p, issueSource: githubIssueSource, branchPattern: /^alice\/(?<key>[0-9]+)\//, branchPatternSource: "^alice/(?P<key>[0-9]+)/", ignoreLabel: "Pohunek:Ignore" }
        : p,
    ),
  };
  const variants = [
    { name: "Linear", config: parkedLinear, rowKey: "linear:ABC-1", key: "ABC-1", source: "linear" as const, branch: "alice/ABC-1/spike", closing: [] as number[], list: { issues: ok("linear", []) } },
    { name: "GitHub", config: parkedGithub, rowKey: "github-issue:acme/widgets#5", key: "acme/widgets#5", source: "github_issues" as const, branch: "alice/5/spike", closing: [5], list: { githubIssues: ok("github_issues", []) } },
  ];

  for (const variant of variants) {
    const spike = pr({ headRefName: variant.branch, closingIssueNumbers: variant.closing, checks: [{ name: "build", outcome: "failure" }] });
    const live = session({ id: "s-1", metadata: { "work.link.provider": variant.source === "linear" ? "linear" : "github", "work.link.id": variant.key, "work.link.branch": variant.branch } });

    test(`${variant.name}: fix-ci on a labelled issue is refused before anything runs, naming --include-ignored`, async () => {
      for (const dryRun of [true, false]) {
        const { deps, commands, launches, lookups } = setup({ prs: ok("github", [spike]), ...variant.list, ignoredKeys: ok(variant.source, new Set([variant.key])) });
        const error = await refusal(runDo(variant.config, options({ key: variant.rowKey, action: "fix-ci", profile: "profile-a", dryRun, yes: !dryRun }), deps));
        expect(error.code).toBe("precondition_failed");
        expect(error.message).toContain("--include-ignored");
        expect(lookups).toEqual([variant.source === "linear" ? [variant.key, `url:${spike.url}`] : [variant.key]]);
        expect(commands).toHaveLength(0);
        expect(launches).toHaveLength(0);
      }
    });

    test(`${variant.name}: attach is refused while the lookup fails, in dry-run and for real`, async () => {
      const failure = { ok: false, source: variant.source, code: "truncated", message: "failed", durationMs: 1 } as const;
      for (const dryRun of [true, false]) {
        const { deps, attached } = setup({ prs: ok("github", [spike]), sessions: [live], ...variant.list, ignoredKeys: failure });
        const error = await refusal(runDo(variant.config, options({ key: variant.rowKey, action: "attach", dryRun, yes: !dryRun }), deps));
        expect(error.code).toBe("source_unavailable");
        expect(error.message).toContain(`${variant.source}:truncated`);
        expect(attached).toHaveLength(0);
      }
    });

    test(`${variant.name}: an issue without the label leaves fix-ci to the normal preconditions`, async () => {
      const { deps } = setup({ prs: ok("github", [spike]), ...variant.list, ignoredKeys: ok(variant.source, new Set()) });
      const out = await runDo(variant.config, options({ key: variant.rowKey, action: "fix-ci", profile: "profile-a", dryRun: true, yes: false }), deps);
      expect((JSON.parse(out.stdout) as Envelope).ok.dry_run).toBe(true);
    });
  }
});

describe("a Linear pull request without a key", () => {
  const parked = {
    ...baseConfig,
    projects: baseConfig.projects.map((p) =>
      p.name === "widgets" && p.issueSource.kind === "linear" ? { ...p, issueSource: { ...p.issueSource, pausedStates: [] }, ignoreLabel: "Pohunek:Ignore" } : p,
    ),
  };
  const keyless = pr({ headRefName: "feature/x", checks: [{ name: "build", outcome: "failure" }] });
  const rowKey = `github:${keyless.id}`;

  test("fix-ci on a pull request attached to a labelled issue is refused, naming --include-ignored", async () => {
    for (const dryRun of [true, false]) {
      const { deps, commands, launches, lookups } = setup({ prs: ok("github", [keyless]), ignoredKeys: ok("linear", new Set([keyless.url])) });
      const error = await refusal(runDo(parked, options({ key: rowKey, action: "fix-ci", profile: "profile-a", dryRun, yes: !dryRun }), deps));
      expect(error.code).toBe("precondition_failed");
      expect(error.message).toContain("--include-ignored");
      expect(lookups).toEqual([[`url:${keyless.url}`]]);
      expect(commands).toHaveLength(0);
      expect(launches).toHaveLength(0);
    }
  });

  test("attach is refused while the lookup fails, in dry-run and for real", async () => {
    const failure = { ok: false, source: "linear", code: "truncated", message: "failed", durationMs: 1 } as const;
    const live = session({ id: "s-1", metadata: { "work.link.provider": "github", "work.link.id": keyless.id, "work.link.kind": "pull_request", "work.link.branch": keyless.headRefName } });
    for (const dryRun of [true, false]) {
      const { deps, attached } = setup({ prs: ok("github", [keyless]), sessions: [live], issues: ok("linear", []), ignoredKeys: failure });
      const error = await refusal(runDo(parked, options({ key: rowKey, action: "attach", dryRun, yes: !dryRun }), deps));
      expect(error.code).toBe("source_unavailable");
      expect(error.message).toContain("linear:truncated");
      expect(attached).toHaveLength(0);
    }
  });
});
