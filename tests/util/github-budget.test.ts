import { expect, test } from "bun:test";
import { estimateRequestNodes, estimateSearchNodes, GITHUB_MAX_NODES } from "../../src/util/github-budget.ts";

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
