import { describe, expect, test } from "bun:test";
import { CONNECTION_ALIAS_OVERHEAD_NODES, estimateConnectionNodes, estimateRequestNodes, estimateSearchNodes, GITHUB_MAX_NODES } from "../../src/util/github-budget.ts";

test("page sizes 50/100/100 exceed the node limit, as GitHub measured 525,100 nodes for one search", () => {
  const oversized = { pullRequestPageSize: 50, nestedPageSize: 100, threadCommentPageSize: 100 };
  expect(estimateSearchNodes(oversized)).toBeGreaterThanOrEqual(525_000);
  expect(estimateRequestNodes(oversized, 2)).toBeGreaterThan(GITHUB_MAX_NODES);
});

test("the shipped sizes fit the limit with the base searches and many team searches", () => {
  const shipped = { pullRequestPageSize: 20, nestedPageSize: 50, threadCommentPageSize: 10 };
  expect(estimateRequestNodes(shipped, 2)).toBeLessThan(GITHUB_MAX_NODES);
  expect(estimateRequestNodes(shipped, 12)).toBeLessThan(GITHUB_MAX_NODES);
});

describe("estimateConnectionNodes", () => {
  const sizes = { nestedPageSize: 100, threadCommentPageSize: 7 };

  test("flat nested connections cost one page of items plus the alias overhead", () => {
    for (const kind of ["reviews", "timelineItems", "reviewRequests", "checkContexts"] as const) {
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
