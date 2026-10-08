// Linear rejects a GraphQL query whose complexity exceeds a fixed limit. The estimate mirrors
// the scoring rules of https://linear.app/developers/rate-limiting: each property is 0.1 point,
// each object is 1 point and a connection multiplies the points of its children by its `first`
// argument. The query shape is the issue page of src/sources/linear.ts; the ignore-label lookup
// documents select a subset of it, so the issue page bounds them. The estimator assumes the
// `pageInfo` nested in a connection is not multiplied by that connection's `first`; this is not
// verified against a live request.

/** Maximum complexity of a single Linear query, as published by Linear (10,000 points). */
export const LINEAR_MAX_COMPLEXITY = 10_000;

/** Complexity is counted in tenths of a point so the boundary is exact integer arithmetic. */
const TENTHS = 10;

/** One object (1 point) with `properties` properties (0.1 point each), in tenths. */
function objectTenths(properties: number): number {
  return TENTHS + properties;
}

/** A `nodes { url | name } pageInfo { hasNextPage endCursor }` connection of `first` nodes, in tenths. */
function pageTenths(first: number): number {
  return first * objectTenths(1) + objectTenths(2);
}

/**
 * Worst-case complexity, in points, of one issue page of `pageSize` issues whose attachment page
 * (and, with `labels`, label page) also holds `pageSize` nodes.
 */
export function estimateLinearComplexity(pageSize: number, labels: boolean): number {
  const perIssue =
    objectTenths(4) + // issue: id, identifier, title, url
    objectTenths(2) + // state: name, type
    pageTenths(pageSize) + // attachments
    (labels ? pageTenths(pageSize) : 0);
  const total = pageSize * perIssue + objectTenths(2); // page-level pageInfo
  return total / TENTHS;
}

/** Whether the issue page fits Linear's complexity limit. */
export function fitsLinearComplexity(pageSize: number, labels: boolean): boolean {
  return estimateLinearComplexity(pageSize, labels) <= LINEAR_MAX_COMPLEXITY;
}
