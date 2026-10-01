// GitHub rejects a GraphQL document whose possible node count exceeds the API
// limit. The estimate mirrors how GitHub multiplies connection sizes down the
// selection of the pull request fragment (src/sources/github-query.ts).

/** Maximum possible nodes per GraphQL request (GitHub API limit). */
export const GITHUB_MAX_NODES = 500_000;

export interface NodeBudgetSizes {
  readonly pullRequestPageSize: number;
  readonly nestedPageSize: number;
  readonly threadCommentPageSize: number;
}

/**
 * Upper bound of nodes one search page can request: per pull request the
 * node itself, five nested connections (reviews, threads, timeline, review
 * requests, check contexts) and the comments of every thread.
 */
export function estimateSearchNodes(sizes: NodeBudgetSizes): number {
  const perPullRequest =
    1 + 5 * sizes.nestedPageSize + sizes.nestedPageSize * sizes.threadCommentPageSize;
  return sizes.pullRequestPageSize * (1 + perPullRequest);
}

/** Total for a request that holds `searches` aliased searches. */
export function estimateRequestNodes(sizes: NodeBudgetSizes, searches: number): number {
  return searches * estimateSearchNodes(sizes);
}
