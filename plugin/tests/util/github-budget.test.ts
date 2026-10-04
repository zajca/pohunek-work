import { describe, expect, test } from "bun:test";
import { CONNECTION_ALIAS_OVERHEAD_NODES, estimateConnectionNodes, estimateIssueSearchNodes, estimateRequestNodes, estimateSearchNodes, GITHUB_MAX_NODES } from "../../src/util/github-budget.ts";

const BASE = { closingReferences: false, pullRequestLabels: false };
const WITH_CLOSING = { closingReferences: true, pullRequestLabels: false };

test("page sizes 50/100/100 exceed the node limit, as GitHub measured 525,100 nodes for one search", () => {
  const oversized = { pullRequestPageSize: 50, nestedPageSize: 100, threadCommentPageSize: 100 };
  expect(estimateSearchNodes(oversized, BASE)).toBeGreaterThanOrEqual(525_000);
  expect(estimateRequestNodes(oversized, 2, BASE)).toBeGreaterThan(GITHUB_MAX_NODES);
});

test("the shipped sizes fit the limit with the base searches and many team searches", () => {
  const shipped = { pullRequestPageSize: 20, nestedPageSize: 50, threadCommentPageSize: 10 };
  expect(estimateRequestNodes(shipped, 2, BASE)).toBeLessThan(GITHUB_MAX_NODES);
  expect(estimateRequestNodes(shipped, 12, BASE)).toBeLessThan(GITHUB_MAX_NODES);
});

test("the closing issue references add one nested connection per pull request", () => {
  const sizes = { pullRequestPageSize: 20, nestedPageSize: 50, threadCommentPageSize: 10 };
  expect(estimateSearchNodes(sizes, WITH_CLOSING) - estimateSearchNodes(sizes, BASE)).toBe(20 * 50);
});

test("the pull request labels add one nested connection per pull request", () => {
  const sizes = { pullRequestPageSize: 20, nestedPageSize: 50, threadCommentPageSize: 10 };
  expect(estimateSearchNodes(sizes, { closingReferences: false, pullRequestLabels: true }) - estimateSearchNodes(sizes, BASE)).toBe(20 * 50);
});

test("an issue search page costs the issue and its label page per issue", () => {
  expect(estimateIssueSearchNodes({ issuePageSize: 30, nestedPageSize: 50 })).toBe(30 * 51);
});

describe("estimateConnectionNodes", () => {
  const sizes = { nestedPageSize: 100, threadCommentPageSize: 7 };

  test("flat nested connections cost one page of items plus the alias overhead", () => {
    for (const kind of ["reviews", "timelineItems", "reviewRequests", "checkContexts", "closingIssues", "issueLabels", "pullRequestLabels"] as const) {
      expect(estimateConnectionNodes(kind, sizes)).toBe(100 + CONNECTION_ALIAS_OVERHEAD_NODES);
    }
  });

  test("review threads also request a comment page per thread", () => {
    expect(estimateConnectionNodes("reviewThreads", sizes)).toBe(100 * (1 + 7) + CONNECTION_ALIAS_OVERHEAD_NODES);
  });

  test("thread comments cost one comment page", () => {
    expect(estimateConnectionNodes("threadComments", sizes)).toBe(7 + CONNECTION_ALIAS_OVERHEAD_NODES);
  });

  test("the largest sizes put 49 review-thread aliases below and 60 above the limit", () => {
    const largest = { nestedPageSize: 100, threadCommentPageSize: 100 };
    expect(49 * estimateConnectionNodes("reviewThreads", largest)).toBeLessThan(GITHUB_MAX_NODES);
    expect(60 * estimateConnectionNodes("reviewThreads", largest)).toBeGreaterThan(GITHUB_MAX_NODES);
  });
});
