import { expect, test } from "bun:test";
import { canPauseIssues, issueSourceStatusKey } from "../../src/config/issue-source.ts";
import type { IssueSource } from "../../src/types/config.ts";

const linear = (pausedStates: string[]): { issueSource: IssueSource } => ({
  issueSource: { kind: "linear", team: "ABC", pausedStates },
});
const github = (pausedLabels: string[]): { issueSource: IssueSource } => ({
  issueSource: { kind: "github", signal: "labels", startedLabels: ["in-progress"], pausedLabels, projectStatus: null },
});
const githubProject = (signal: "project" | "both", pausedOptions: string[], pausedLabels: string[] = []): { issueSource: IssueSource } => ({
  issueSource: {
    kind: "github",
    signal,
    startedLabels: signal === "both" ? ["in-progress"] : [],
    pausedLabels,
    projectStatus: { owner: "acme", number: 7, field: "Status", startedOptions: ["In Progress"], pausedOptions },
  },
});

test("a Linear project reports its issue source status under the linear key", () => {
  expect(issueSourceStatusKey(linear([]))).toBe("linear");
});

test("a GitHub project reports its issue source status under the github_issues key", () => {
  expect(issueSourceStatusKey(github([]))).toBe("github_issues");
});

test("pausing needs configured paused states or paused labels", () => {
  expect(canPauseIssues(linear(["On hold"]))).toBe(true);
  expect(canPauseIssues(linear([]))).toBe(false);
  expect(canPauseIssues(github(["on-hold"]))).toBe(true);
  expect(canPauseIssues(github([]))).toBe(false);
});

test("a project signal pauses through its paused options", () => {
  expect(canPauseIssues(githubProject("project", ["Blocked"]))).toBe(true);
  expect(canPauseIssues(githubProject("project", []))).toBe(false);
  expect(canPauseIssues(githubProject("both", ["Blocked"]))).toBe(true);
  expect(canPauseIssues(githubProject("both", [], ["on-hold"]))).toBe(true);
  expect(canPauseIssues(githubProject("both", []))).toBe(false);
});
