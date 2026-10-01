// GitHub rejects a GraphQL document whose possible node count exceeds the API
// limit. The estimate mirrors how GitHub multiplies connection sizes down the
// selection of the pull request fragment (src/sources/github-query.ts).

import type { ConnectionKind } from "../sources/github-query.ts";

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

/** Nodes a follow-up alias spends on the `node(id:)` lookup and the parents above its connection. */
export const CONNECTION_ALIAS_OVERHEAD_NODES = 3;

export type ConnectionNodeSizes = Pick<NodeBudgetSizes, "nestedPageSize" | "threadCommentPageSize">;

/**
 * Upper bound of nodes one follow-up alias can request for the next page of a
 * nested connection: the page items (review threads also request their
 * comment page) plus the alias overhead.
 */
export function estimateConnectionNodes(kind: ConnectionKind, sizes: ConnectionNodeSizes): number {
  let items: number;
  switch (kind) {
    case "reviewThreads":
      items = sizes.nestedPageSize * (1 + sizes.threadCommentPageSize);
      break;
    case "threadComments":
      items = sizes.threadCommentPageSize;
      break;
    case "reviews":
    case "timelineItems":
    case "reviewRequests":
    case "checkContexts":
      items = sizes.nestedPageSize;
      break;
  }
  return items + CONNECTION_ALIAS_OVERHEAD_NODES;
}
