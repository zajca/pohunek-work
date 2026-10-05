import { describe, expect, test } from "bun:test";
import { lookupUnlistedIssues, type IssueLookupDeps } from "../src/issue-lookup.ts";
import type { ProjectConfig } from "../src/types/config.ts";
import { isIgnoredItem, type SourceStatuses } from "../src/types/item.ts";
import type { SourceResult } from "../src/types/sources.ts";
import { allOk, githubIssueSource, issue, item, pr } from "./rules/builders.ts";

const linearProject: ProjectConfig = {
  name: "widgets",
  pohunekLabel: "widgets",
  repo: "acme/widgets",
  issueSource: { kind: "linear", team: "ABC", pausedStates: [] },
  branchPattern: /^me\/(?<key>[A-Z]+-\d+)\//,
  branchPatternSource: "^me/(?P<key>[A-Z]+-\\d+)/",
  ignoredChecks: [],
  policyChecks: [],
  aiReviewers: [],
  reviews: "session",
  policy: null,
  profiles: null,
  ignoreLabel: "Pohunek:Ignore",
};
const githubProject: ProjectConfig = { ...linearProject, issueSource: githubIssueSource };

const unlisted = item({ key: "linear:ABC-1", issueKey: "ABC-1", joinedBy: "branch_pattern", noIssue: false });

function keyed(keys: readonly string[]): SourceResult<ReadonlySet<string>> {
  return { ok: true, source: "linear", data: new Set(keys), durationMs: 1 };
}

function failed(source: "linear" | "github_issues", code: "truncated" | "timeout"): SourceResult<never> {
  return { ok: false, source, code, message: "failed", durationMs: 1 };
}

function spy(answer: SourceResult<ReadonlySet<string>> | null): { deps: IssueLookupDeps; asked: string[][] } {
  const asked: string[][] = [];
  const ask = (_project: unknown, keys: readonly string[], urls: readonly string[] = []): Promise<SourceResult<ReadonlySet<string>>> => {
    asked.push([...keys, ...urls.map((url) => `url:${url}`)]);
    return answer === null ? Promise.reject(new Error("no lookup expected")) : Promise.resolve(answer);
  };
  return { deps: { linear: { fetchIssues: () => Promise.reject(new Error("unused")), fetchIgnoredKeys: ask }, github: { fetchIgnoredKeys: ask } as IssueLookupDeps["github"] }, asked };
}

describe("lookupUnlistedIssues", () => {
  test("a labelled issue marks the row ignored, an unlabelled one does not", async () => {
    const labelled = spy(keyed(["ABC-1"]));
    const marked = await lookupUnlistedIssues(linearProject, [unlisted], allOk, labelled.deps);
    expect(marked.items[0]?.issueLookup).toEqual({ ok: true, ignored: true });
    expect(marked.items[0] === undefined ? false : isIgnoredItem(marked.items[0])).toBe(true);
    expect(marked.failure).toBeNull();
    const clear = spy(keyed([]));
    const open = await lookupUnlistedIssues(linearProject, [unlisted], allOk, clear.deps);
    expect(open.items[0]?.issueLookup).toEqual({ ok: true, ignored: false });
    expect(open.items[0] === undefined ? true : isIgnoredItem(open.items[0])).toBe(false);
  });

  test("a failed lookup keeps the source and code for the row and reports the failure", async () => {
    const run = spy(failed("linear", "truncated"));
    const out = await lookupUnlistedIssues(linearProject, [unlisted], allOk, run.deps);
    expect(out.items[0]?.issueLookup).toEqual({ ok: false, reason: "linear:truncated" });
    expect(out.failure).toBe("linear:truncated");
  });

  test("each key is asked once, for every row that joined to it", async () => {
    const secondary = item({ key: "github:acme/widgets#13", pullRequest: pr({ id: "acme/widgets#13", number: 13 }), issueKey: "ABC-1", joinedBy: null, noIssue: false });
    const other = item({ key: "linear:ABC-2", issueKey: "ABC-2", joinedBy: "branch_pattern", noIssue: false });
    const run = spy(keyed(["ABC-1"]));
    const out = await lookupUnlistedIssues(linearProject, [unlisted, secondary, other], allOk, run.deps);
    expect(run.asked).toEqual([["ABC-1", "ABC-2"]]);
    expect(out.items.map((i) => i.issueLookup)).toEqual([
      { ok: true, ignored: true },
      { ok: true, ignored: true },
      { ok: true, ignored: false },
    ]);
  });

  test("the GitHub source answers for a github project", async () => {
    const run = spy(keyed(["acme/widgets#5"]));
    const row = item({ key: "github-issue:acme/widgets#5", issueKey: "acme/widgets#5", joinedBy: "issue_reference", noIssue: false });
    const out = await lookupUnlistedIssues(githubProject, [row], { ...allOk, linear: "unused", github_issues: "ok" }, run.deps);
    expect(out.items[0]?.issueLookup).toEqual({ ok: true, ignored: true });
  });

  describe("a Linear pull request without a key", () => {
    const keyless = item({ key: "github:acme/widgets#12", issueKey: null, joinedBy: null, noIssue: true, pullRequest: pr({ url: "https://github.example/pr/12" }) });

    test("is asked for by URL, once, and the attached issue's label decides", async () => {
      const other = item({ ...keyless, key: "github:acme/widgets#13", pullRequest: pr({ number: 13, url: "https://github.example/pr/13" }) });
      const run = spy(keyed(["https://github.example/pr/12"]));
      const out = await lookupUnlistedIssues(linearProject, [keyless, other, keyless], allOk, run.deps);
      expect(run.asked).toEqual([["url:https://github.example/pr/12", "url:https://github.example/pr/13"]]);
      expect(out.items.map((i) => i.issueLookup)).toEqual([{ ok: true, ignored: true }, { ok: true, ignored: false }, { ok: true, ignored: true }]);
      expect(out.items[0] === undefined ? false : isIgnoredItem(out.items[0])).toBe(true);
      expect(out.items[0]?.noIssue).toBe(true);
    });

    test("is unknown through the failed lookup and asks for keys and URLs in one call", async () => {
      const run = spy(failed("linear", "timeout"));
      const out = await lookupUnlistedIssues(linearProject, [keyless, unlisted], allOk, run.deps);
      expect(run.asked).toEqual([["ABC-1", "url:https://github.example/pr/12"]]);
      expect(out.items.map((i) => i.issueLookup)).toEqual([{ ok: false, reason: "linear:timeout" }, { ok: false, reason: "linear:timeout" }]);
    });
  });

  describe("asks nothing", () => {
    const cases: [string, ProjectConfig, ReturnType<typeof item>, SourceStatuses][] = [
      ["a project without an ignore label", { ...linearProject, ignoreLabel: null }, unlisted, allOk],
      ["a row whose issue the list returned", linearProject, item({ ...unlisted, issue: issue(), resolvedIssue: issue() }), allOk],
      ["a github row without an issue key", githubProject, item({ key: "github:acme/widgets#12", issueKey: null, joinedBy: null, noIssue: true }), { ...allOk, linear: "unused", github_issues: "ok" }],
      ["a Linear row without a key that is not known to be keyless", linearProject, item({ key: "github:acme/widgets#12", issueKey: null, joinedBy: null, noIssue: false }), allOk],
      ["a Linear row without a key whose pull request is already ignored", linearProject, item({ key: "github:acme/widgets#12", issueKey: null, joinedBy: null, noIssue: true, pullRequest: pr({ ignored: true }) }), allOk],
      ["a Linear row without a key and a pull request of someone else", linearProject, item({ key: "github:acme/widgets#12", issueKey: null, joinedBy: null, noIssue: true, pullRequest: pr({ relation: "review_requested" }) }), allOk],
      ["a pull request that is already ignored", linearProject, item({ ...unlisted, pullRequest: pr({ ignored: true }) }), allOk],
      ["a pull request of someone else", linearProject, item({ ...unlisted, pullRequest: pr({ relation: "review_requested" }) }), allOk],
      ["an issue row without a pull request", linearProject, item({ ...unlisted, pullRequest: null }), allOk],
      ["a failed issue source", linearProject, unlisted, { ...allOk, linear: "truncated" }],
      ["a failed github source", linearProject, unlisted, { ...allOk, github: "rate_limited" }],
    ];
    for (const [name, project, row, sources] of cases) {
      test(name, async () => {
        const run = spy(null);
        const out = await lookupUnlistedIssues(project, [row], sources, run.deps);
        expect(run.asked).toEqual([]);
        expect(out.items).toEqual([row]);
        expect(out.failure).toBeNull();
      });
    }
  });
});
