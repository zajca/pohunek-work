import { expect, test } from "bun:test";
import { canPauseIssues, issueSourceStatusKey } from "../../src/config/issue-source.ts";
import type { IssueSource } from "../../src/types/config.ts";

const linear = (pausedStates: string[]): { issueSource: IssueSource } => ({
  issueSource: { kind: "linear", team: "ABC", pausedStates },
});
const github = { issueSource: { kind: "github" } } as const satisfies { issueSource: IssueSource };

test("a Linear project reports its issue source status under the linear key", () => {
  expect(issueSourceStatusKey(linear([]))).toBe("linear");
});

test("a GitHub project has no issue source status key", () => {
  expect(issueSourceStatusKey(github)).toBeNull();
});

test("pausing needs configured paused states", () => {
  expect(canPauseIssues(linear(["On hold"]))).toBe(true);
  expect(canPauseIssues(linear([]))).toBe(false);
  expect(canPauseIssues(github)).toBe(false);
});
