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
    expect(run.asked).toEqual([["ABC-1", "ABC-2", `url:${pr().url}`]]);
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
      expect(run.asked).toEqual([["ABC-1", "url:https://github.example/pr/12", `url:${pr().url}`]]);
      expect(out.items.map((i) => i.issueLookup)).toEqual([{ ok: false, reason: "linear:timeout" }, { ok: false, reason: "linear:timeout" }]);
    });
  });

  describe("asks nothing", () => {
    const cases: [string, ProjectConfig, ReturnType<typeof item>, SourceStatuses][] = [
      ["a project without an ignore label", { ...linearProject, ignoreLabel: null }, unlisted, allOk],
      ["a row whose issue the list returned and nothing else to ask", linearProject, item({ ...unlisted, issue: issue(), resolvedIssue: issue() }), allOk],
      ["a github row without an issue key", githubProject, item({ key: "github:acme/widgets#12", issueKey: null, joinedBy: null, noIssue: true }), { ...allOk, linear: "unused", github_issues: "ok" }],
      ["a github row with a listed issue and no other candidate", githubProject, item({ ...unlisted, issueKey: "acme/widgets#5", issue: issue(), pullRequest: pr({ headRefName: "feature" }) }), { ...allOk, linear: "unused", github_issues: "ok" }],
      ["a Linear row with a listed issue that is the branch key", linearProject, item({ ...unlisted, issue: issue(), resolvedIssue: issue(), pullRequest: pr({ headRefName: "me/ABC-1/cache" }) }), allOk],
      ["a Linear row with a listed ignored issue", linearProject, item({ ...unlisted, issue: issue({ ignored: true }), resolvedIssue: issue({ ignored: true }), pullRequest: pr({ headRefName: "me/ABC-9/cache" }) }), allOk],
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

  describe("every candidate issue of the pull request is consulted", () => {
    const github = { ...allOk, linear: "unused", github_issues: "ok" } as const;
    const url = "https://github.example/pr/12";
    const branchJoined = item({ key: "github:acme/widgets#12", issueKey: "ABC-1", joinedBy: "branch_pattern", noIssue: false, pullRequest: pr({ url, headRefName: "me/ABC-1/cache" }) });

    test("a Linear row joined by branch asks the key and the URL in one call; the attached parked issue ignores it", async () => {
      const run = spy(keyed([url]));
      const out = await lookupUnlistedIssues(linearProject, [branchJoined], allOk, run.deps);
      expect(run.asked).toEqual([["ABC-1", `url:${url}`]]);
      expect(out.items[0]?.issueLookup).toEqual({ ok: true, ignored: true });
    });

    test("a Linear row joined by branch is ignored when only the key answers", async () => {
      const run = spy(keyed(["ABC-1"]));
      const out = await lookupUnlistedIssues(linearProject, [branchJoined], allOk, run.deps);
      expect(out.items[0]?.issueLookup).toEqual({ ok: true, ignored: true });
    });

    test("a Linear row stays unignored when neither the key nor the URL answers", async () => {
      const run = spy(keyed(["ABC-7", "https://github.example/pr/99"]));
      const out = await lookupUnlistedIssues(linearProject, [branchJoined], allOk, run.deps);
      expect(out.items[0]?.issueLookup).toEqual({ ok: true, ignored: false });
    });

    test("a Linear row joined by session link also asks the key captured from the branch", async () => {
      const row = item({ ...branchJoined, issueKey: "ABC-5", joinedBy: "session_link" });
      const run = spy(keyed(["ABC-1"]));
      const out = await lookupUnlistedIssues(linearProject, [row], allOk, run.deps);
      expect(run.asked).toEqual([["ABC-5", "ABC-1", `url:${url}`]]);
      expect(out.items[0]?.issueLookup).toEqual({ ok: true, ignored: true });
    });

    test("a GitHub row asks every closing reference in one batch with the project's repo spelling; one parked issue ignores it", async () => {
      const row = item({ key: "github:acme/widgets#12", issueKey: "acme/widgets#3", joinedBy: "issue_reference", noIssue: false, pullRequest: pr({ closingIssueNumbers: [3, 4, 5], headRefName: "feature" }) });
      const run = spy(keyed(["acme/widgets#5"]));
      const out = await lookupUnlistedIssues({ ...githubProject, repo: "Acme/Widgets" }, [row], github, run.deps);
      expect(run.asked).toEqual([["acme/widgets#3", "Acme/Widgets#3", "Acme/Widgets#4", "Acme/Widgets#5"]]);
      expect(out.items[0]?.issueLookup).toEqual({ ok: true, ignored: false });
      const parked = spy(keyed(["Acme/Widgets#5"]));
      const ignored = await lookupUnlistedIssues({ ...githubProject, repo: "Acme/Widgets" }, [row], github, parked.deps);
      expect(ignored.items[0]?.issueLookup).toEqual({ ok: true, ignored: true });
    });

    test("a GitHub row asks the issue number from the branch next to the closing reference", async () => {
      const githubBranch = { ...githubProject, branchPattern: /^issue-(?<key>\d+)$/ };
      const row = item({ key: "github:acme/widgets#12", issueKey: "acme/widgets#3", joinedBy: "issue_reference", noIssue: false, pullRequest: pr({ closingIssueNumbers: [3], headRefName: "issue-8" }) });
      const run = spy(keyed(["acme/widgets#8"]));
      const out = await lookupUnlistedIssues(githubBranch, [row], github, run.deps);
      expect(run.asked).toEqual([["acme/widgets#3", "acme/widgets#8"]]);
      expect(out.items[0]?.issueLookup).toEqual({ ok: true, ignored: true });
    });

    test("a GitHub branch capture that is not a positive decimal number is not asked", async () => {
      for (const captured of ["abc", "0", "007x", "99999999999999999999"]) {
        const githubBranch = { ...githubProject, branchPattern: /^b-(?<key>.+)$/ };
        const row = item({ key: "github:acme/widgets#12", issueKey: "acme/widgets#3", joinedBy: "issue_reference", noIssue: false, pullRequest: pr({ closingIssueNumbers: [3], headRefName: `b-${captured}` }) });
        const run = spy(keyed([]));
        await lookupUnlistedIssues(githubBranch, [row], github, run.deps);
        expect(run.asked).toEqual([["acme/widgets#3"]]);
      }
    });

    test("a row with a listed issue asks only the extra candidates, never the URL", async () => {
      const listed = item({ ...branchJoined, issue: issue(), resolvedIssue: issue(), pullRequest: pr({ url, headRefName: "me/ABC-9/cache" }) });
      const run = spy(keyed(["ABC-9"]));
      const out = await lookupUnlistedIssues(linearProject, [listed], allOk, run.deps);
      expect(run.asked).toEqual([["ABC-9"]]);
      expect(out.items[0]?.issueLookup).toEqual({ ok: true, ignored: true });
      expect(out.items[0] === undefined ? false : isIgnoredItem(out.items[0])).toBe(true);
    });

    test("a GitHub row with a listed issue asks its other closing references", async () => {
      const listed = item({ key: "github-issue:acme/widgets#3", issue: issue({ id: "acme/widgets#3" }), resolvedIssue: issue({ id: "acme/widgets#3" }), issueKey: "acme/widgets#3", joinedBy: "issue_reference", noIssue: false, pullRequest: pr({ closingIssueNumbers: [3, 4], headRefName: "feature" }) });
      const run = spy(keyed([]));
      const out = await lookupUnlistedIssues(githubProject, [listed], github, run.deps);
      expect(run.asked).toEqual([["acme/widgets#4"]]);
      expect(out.items[0]?.issueLookup).toEqual({ ok: true, ignored: false });
    });

    test("a failed lookup marks a row with a listed issue unknown as well", async () => {
      const listed = item({ ...branchJoined, issue: issue(), resolvedIssue: issue(), pullRequest: pr({ url, headRefName: "me/ABC-9/cache" }) });
      const run = spy(failed("linear", "timeout"));
      const out = await lookupUnlistedIssues(linearProject, [listed], allOk, run.deps);
      expect(out.items[0]?.issueLookup).toEqual({ ok: false, reason: "linear:timeout" });
      expect(out.failure).toBe("linear:timeout");
    });

    test("keys and URLs are deduplicated across rows", async () => {
      const second = item({ ...branchJoined, key: "github:acme/widgets#13", pullRequest: pr({ number: 13, url: "https://github.example/pr/13", headRefName: "me/ABC-1/more" }) });
      const run = spy(keyed([]));
      await lookupUnlistedIssues(linearProject, [branchJoined, second, branchJoined], allOk, run.deps);
      expect(run.asked).toEqual([["ABC-1", `url:${url}`, "url:https://github.example/pr/13"]]);
    });
  });
});
