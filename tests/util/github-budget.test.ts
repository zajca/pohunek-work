import { expect, test } from "bun:test";
import { estimateRequestNodes, estimateSearchNodes, GITHUB_MAX_NODES } from "../../src/util/github-budget.ts";

test("the estimate reproduces the node count GitHub reported for the old production sizes", () => {
  // GitHub measured 525,100 possible nodes for one search at 50/100/100.
  const old = { pullRequestPageSize: 50, nestedPageSize: 100, threadCommentPageSize: 100 };
  expect(estimateSearchNodes(old)).toBeGreaterThanOrEqual(525_000);
  expect(estimateRequestNodes(old, 2)).toBeGreaterThan(GITHUB_MAX_NODES);
});

test("the shipped sizes fit the limit with the base searches and many team searches", () => {
  const shipped = { pullRequestPageSize: 20, nestedPageSize: 50, threadCommentPageSize: 10 };
  expect(estimateRequestNodes(shipped, 2)).toBeLessThan(GITHUB_MAX_NODES);
  expect(estimateRequestNodes(shipped, 12)).toBeLessThan(GITHUB_MAX_NODES);
});
