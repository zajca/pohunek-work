// GraphQL documents for the GitHub source. Only query operations are built.
// Search strings and page sizes travel as variables; no caller value is ever
// interpolated into the document text.

import type { SearchShape } from "../util/github-budget.ts";

export type ConnectionKind =
  | "reviews"
  | "reviewThreads"
  | "timelineItems"
  | "reviewRequests"
  | "checkContexts"
  | "threadComments"
  | "closingIssues"
  | "issueLabels"
  | "issueProjectItems"
  | "pullRequestLabels";

const PAGE_INFO = "pageInfo { hasNextPage endCursor }";
const ACTOR = "author { __typename login }";

const REVIEWS_FIELDS = `nodes { id state submittedAt ${ACTOR} } ${PAGE_INFO}`;
const THREAD_COMMENTS_FIELDS = `nodes { ${ACTOR} createdAt } ${PAGE_INFO}`;
const THREADS_FIELDS = `nodes { id isResolved isOutdated comments(first: $comments) { ${THREAD_COMMENTS_FIELDS} } } ${PAGE_INFO}`;
const TIMELINE_FIELDS = `nodes { __typename ... on PullRequestCommit { commit { committedDate } } ... on HeadRefForcePushedEvent { createdAt } } ${PAGE_INFO}`;
const REQUEST_FIELDS = `nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } ${PAGE_INFO}`;
const CONTEXT_FIELDS = `nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } ${PAGE_INFO}`;

const CLOSING_FIELDS = `nodes { number repository { nameWithOwner } } ${PAGE_INFO}`;
const LABEL_FIELDS = `nodes { name } ${PAGE_INFO}`;
// The owner login is read through both owner types of a Project; the field value is selected by the
// name in `$statusField`, so the variable must be declared by every document that uses these fields.
const PROJECT_ITEM_FIELDS = `nodes { project { number owner { __typename ... on User { login } ... on Organization { login } } } fieldValueByName(name: $statusField) { __typename ... on ProjectV2ItemFieldSingleSelectValue { name } } } ${PAGE_INFO}`;

const TIMELINE_ITEM_TYPES = "[PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]";

/**
 * The closing references are part of the document only for a project whose issues come from GitHub,
 * the labels only for a project with an ignore label.
 */
function pullRequestFragment(shape: SearchShape): string {
  const closing = shape.closingReferences ? `\n  closingIssuesReferences(first: $nested) { ${CLOSING_FIELDS} }` : "";
  const labels = shape.pullRequestLabels ? `\n  labels(first: $nested) { ${LABEL_FIELDS} }` : "";
  return `
fragment PrFields on PullRequest {
  id number url title isDraft isCrossRepository headRefName headRefOid baseRefName reviewDecision mergeable updatedAt
  repository { nameWithOwner }
  ${ACTOR}
  reviews(first: $nested) { ${REVIEWS_FIELDS} }
  reviewThreads(first: $nested) { ${THREADS_FIELDS} }
  timelineItems(first: $nested, itemTypes: ${TIMELINE_ITEM_TYPES}) { ${TIMELINE_FIELDS} }
  reviewRequests(first: $nested) { ${REQUEST_FIELDS} }
  commits(last: 1) { nodes { commit { id statusCheckRollup { contexts(first: $nested) { ${CONTEXT_FIELDS} } } } } }${closing}${labels}
}`;
}

export interface SearchSpec {
  /** Alias of the search field and suffix of its variables. */
  readonly alias: string;
  /** Search string, sent as a variable. */
  readonly queryString: string;
  /** Cursor of the page to fetch; null for the first page. */
  readonly after: string | null;
}

export type GraphqlVariables = Record<string, string | number | null>;

export interface GraphqlRequest {
  readonly query: string;
  readonly variables: GraphqlVariables;
}

export interface SearchRequestSizes {
  readonly pullRequestPageSize: number;
  readonly nestedPageSize: number;
  readonly threadCommentPageSize: number;
}

/** One request that fetches the next page of every active search. */
export function buildSearchRequest(
  searches: readonly SearchSpec[],
  sizes: SearchRequestSizes,
  shape: SearchShape,
): GraphqlRequest {
  const variables: GraphqlVariables = {
    top: sizes.pullRequestPageSize,
    nested: sizes.nestedPageSize,
    comments: sizes.threadCommentPageSize,
  };
  const declarations = ["$top: Int!", "$nested: Int!", "$comments: Int!"];
  const fields: string[] = [];
  for (const search of searches) {
    variables[`q_${search.alias}`] = search.queryString;
    variables[`after_${search.alias}`] = search.after;
    declarations.push(`$q_${search.alias}: String!`, `$after_${search.alias}: String`);
    fields.push(
      `${search.alias}: search(query: $q_${search.alias}, type: ISSUE, first: $top, after: $after_${search.alias}) { issueCount ${PAGE_INFO} nodes { ...PrFields } }`,
    );
  }
  const query = `query PohunekWorkPullRequests(${declarations.join(", ")}) {
  rateLimit { remaining }
  ${fields.join("\n  ")}
}${pullRequestFragment(shape)}`;
  return { query, variables };
}

/**
 * One page of the open issues of a repository assigned to the owner, with the first page of their
 * labels. A non-null `statusField` adds the first page of the Project items of every issue, each
 * with the value of that single-select field; the name travels as the variable `$statusField`.
 */
export function buildIssueSearchRequest(
  queryString: string,
  after: string | null,
  sizes: { readonly issuePageSize: number; readonly nestedPageSize: number },
  statusField: string | null,
): GraphqlRequest {
  const declaration = statusField === null ? "" : ", $statusField: String!";
  const items = statusField === null ? "" : ` projectItems(first: $nested) { ${PROJECT_ITEM_FIELDS} }`;
  const query = `query PohunekWorkIssues($q: String!, $top: Int!, $nested: Int!, $after: String${declaration}) {
  rateLimit { remaining }
  issues: search(query: $q, type: ISSUE, first: $top, after: $after) {
    issueCount ${PAGE_INFO}
    nodes { ... on Issue { id number url title labels(first: $nested) { ${LABEL_FIELDS} }${items} } }
  }
}`;
  const variables: GraphqlVariables = {
    q: queryString,
    top: sizes.issuePageSize,
    nested: sizes.nestedPageSize,
    after,
  };
  if (statusField !== null) {
    variables["statusField"] = statusField;
  }
  return { query, variables };
}

/** The single-select field of a Project by owner login, Project number and field name, with its option names. */
export function buildProjectStatusValidationRequest(owner: string, number: number, field: string): GraphqlRequest {
  const query = `query PohunekWorkProjectStatus($o: String!, $n: Int!, $f: String!) {
  rateLimit { remaining }
  repositoryOwner(login: $o) {
    ... on ProjectV2Owner {
      projectV2(number: $n) {
        number
        field(name: $f) { __typename ... on ProjectV2SingleSelectField { name options { name } } }
      }
    }
  }
}`;
  return { query, variables: { o: owner, n: number, f: field } };
}

/**
 * Issues of a repository by number, each under the alias `i<index>`, with the first page of their
 * labels. The numbers travel as variables; the batch is bounded by the caller to `issue_page_size`
 * issues, which is the shape `estimateIssueSearchNodes` already validates.
 */
export function buildIgnoredIssuesRequest(
  owner: string,
  name: string,
  numbers: readonly number[],
  nestedPageSize: number,
): GraphqlRequest {
  const declarations = numbers.map((_, index) => `, $n${index.toString()}: Int!`).join("");
  const aliases = numbers
    .map(
      (_, index) =>
        `i${index.toString()}: issue(number: $n${index.toString()}) { id number labels(first: $nested) { ${LABEL_FIELDS} } }`,
    )
    .join("\n    ");
  const query = `query PohunekWorkIgnoredIssues($owner: String!, $name: String!, $nested: Int!${declarations}) {
  rateLimit { remaining }
  repository(owner: $owner, name: $name) {
    ${aliases}
  }
}`;
  const variables: GraphqlVariables = { owner, name, nested: nestedPageSize };
  numbers.forEach((number, index) => {
    variables[`n${index.toString()}`] = number;
  });
  return { query, variables };
}

/** One issue of a repository by number, with the fields the `implement` prompt carries. */
export function buildIssueDetailRequest(owner: string, name: string, number: number): GraphqlRequest {
  const query = `query PohunekWorkIssueDetail($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining }
  repository(owner: $owner, name: $name) { issue(number: $number) { number url title state body } }
}`;
  return { query, variables: { owner, name, number } };
}

/** One page of the merged pull request search; only the fields the join needs. */
export function buildMergedSearchRequest(
  queryString: string,
  after: string | null,
  pageSize: number,
): GraphqlRequest {
  const query = `query PohunekWorkMergedPullRequests($q: String!, $top: Int!, $after: String) {
  rateLimit { remaining }
  merged: search(query: $q, type: ISSUE, first: $top, after: $after) {
    issueCount ${PAGE_INFO}
    nodes { ... on PullRequest { number url title headRefName mergedAt repository { nameWithOwner } } }
  }
}`;
  return { query, variables: { q: queryString, top: pageSize, after } };
}

interface KindSpec {
  /** GraphQL type of the node the connection hangs off. */
  readonly parentType: string;
  /** Field path from the node to the connection, last element is the connection. */
  readonly path: readonly string[];
  readonly fields: string;
}

export const CONNECTION_KINDS: Readonly<Record<ConnectionKind, KindSpec>> = {
  reviews: { parentType: "PullRequest", path: ["reviews"], fields: REVIEWS_FIELDS },
  reviewThreads: { parentType: "PullRequest", path: ["reviewThreads"], fields: THREADS_FIELDS },
  timelineItems: { parentType: "PullRequest", path: ["timelineItems"], fields: TIMELINE_FIELDS },
  reviewRequests: { parentType: "PullRequest", path: ["reviewRequests"], fields: REQUEST_FIELDS },
  checkContexts: {
    parentType: "Commit",
    path: ["statusCheckRollup", "contexts"],
    fields: CONTEXT_FIELDS,
  },
  threadComments: {
    parentType: "PullRequestReviewThread",
    path: ["comments"],
    fields: THREAD_COMMENTS_FIELDS,
  },
  closingIssues: { parentType: "PullRequest", path: ["closingIssuesReferences"], fields: CLOSING_FIELDS },
  issueLabels: { parentType: "Issue", path: ["labels"], fields: LABEL_FIELDS },
  issueProjectItems: { parentType: "Issue", path: ["projectItems"], fields: PROJECT_ITEM_FIELDS },
  pullRequestLabels: { parentType: "PullRequest", path: ["labels"], fields: LABEL_FIELDS },
};

export interface ConnectionPageSpec {
  readonly alias: string;
  readonly kind: ConnectionKind;
  readonly nodeId: string;
  readonly after: string;
}

function connectionSelection(spec: ConnectionPageSpec): string {
  const kind = CONNECTION_KINDS[spec.kind];
  const size = spec.kind === "threadComments" ? "$comments" : "$nested";
  const args = `first: ${size}, after: $after_${spec.alias}`;
  const timelineArgs = spec.kind === "timelineItems" ? `, itemTypes: ${TIMELINE_ITEM_TYPES}` : "";
  let inner = "";
  kind.path.forEach((segment, index) => {
    const isLast = index === kind.path.length - 1;
    inner += isLast ? `${segment}(${args}${timelineArgs}) { ${kind.fields} }` : `${segment} { `;
  });
  inner += " }".repeat(kind.path.length - 1);
  return `${spec.alias}: node(id: $id_${spec.alias}) { ... on ${kind.parentType} { ${inner} } }`;
}

/**
 * One request that fetches the next page of several nested connections by node id. Pages of kind
 * `issueProjectItems` need `statusField`, the field name the first page was selected with.
 */
export function buildConnectionRequest(
  pages: readonly ConnectionPageSpec[],
  sizes: Pick<SearchRequestSizes, "nestedPageSize" | "threadCommentPageSize">,
  statusField: string | null = null,
): GraphqlRequest {
  const variables: GraphqlVariables = {};
  const declarations: string[] = [];
  const fields: string[] = [];
  // GraphQL rejects a declared variable that no field uses, so the size variables are declared only when needed.
  if (pages.some((page) => page.kind !== "threadComments")) {
    variables["nested"] = sizes.nestedPageSize;
    declarations.push("$nested: Int!");
  }
  if (pages.some((page) => page.kind === "reviewThreads" || page.kind === "threadComments")) {
    variables["comments"] = sizes.threadCommentPageSize;
    declarations.push("$comments: Int!");
  }
  if (pages.some((page) => page.kind === "issueProjectItems")) {
    if (statusField === null) {
      throw new Error("a project items page needs the status field name");
    }
    variables["statusField"] = statusField;
    declarations.push("$statusField: String!");
  }
  for (const page of pages) {
    variables[`id_${page.alias}`] = page.nodeId;
    variables[`after_${page.alias}`] = page.after;
    declarations.push(`$id_${page.alias}: ID!`, `$after_${page.alias}: String!`);
    fields.push(connectionSelection(page));
  }
  const query = `query PohunekWorkConnections(${declarations.join(", ")}) {
  rateLimit { remaining }
  ${fields.join("\n  ")}
}`;
  return { query, variables };
}
