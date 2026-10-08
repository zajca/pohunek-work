// GitHub source: open pull requests authored by the owner or awaiting the
// owner's review, fetched with batched read-only GraphQL queries.
//
// The token comes from `gh auth token`, lives only in memory and is only sent
// in the Authorization header to the configured endpoint. Failure messages are
// static text plus a short GraphQL error type; provider text never reaches them.

import type { GithubConfig, GithubProject, GithubProjectStatus, IdentityConfig, ProjectConfig } from "../types/config.ts";
import type {
  Actor,
  Check,
  CheckOutcome,
  Issue,
  IssueDetail,
  Mergeable,
  MergedPullRequest,
  PullRequest,
  PullRequestRelation,
  Review,
  ReviewDecision,
  ReviewRequest,
  ReviewState,
  SourceErrorCode,
  SourceResult,
  Thread,
  ThreadComment,
  TimelineEvent,
} from "../types/sources.ts";
import { exec as defaultExec, SpawnError, type Exec } from "../util/exec.ts";
import {
  buildConnectionRequest,
  buildIgnoredIssuesRequest,
  buildIssueDetailRequest,
  buildIssueSearchRequest,
  buildMergedSearchRequest,
  buildProjectStatusValidationRequest,
  buildSearchRequest,
  CONNECTION_KINDS,
  type ConnectionKind,
  type ConnectionPageSpec,
  type GraphqlRequest,
  type SearchSpec,
} from "./github-query.ts";
import { estimateConnectionNodes, estimateRequestNodes, GITHUB_MAX_NODES, type SearchShape } from "../util/github-budget.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GithubSourceDeps {
  readonly exec?: Exec;
  readonly fetch?: FetchLike;
  /** Clock for the merged lookback window; the system clock when absent. */
  readonly now?: () => number;
}

export interface GithubSource {
  fetchPullRequests(project: ProjectConfig): Promise<SourceResult<readonly PullRequest[]>>;
  /** Pull requests of the owner merged within `merged_lookback_days`. */
  fetchMergedPullRequests(project: ProjectConfig): Promise<SourceResult<readonly MergedPullRequest[]>>;
  /** Open issues of the project's repository assigned to the owner that the configured signal (labels, Project status or both) marks as started or paused. */
  fetchIssues(project: GithubProject): Promise<SourceResult<readonly Issue[]>>;
  /**
   * Of the issue keys asked for, those whose issue carries the project's ignore label. The issue
   * search lists only open issues with a started or paused label, so a pull request can join an
   * issue it does not return. A key whose issue does not exist is not in the result.
   */
  fetchIgnoredKeys(project: GithubProject, keys: readonly string[]): Promise<SourceResult<ReadonlySet<string>>>;
  /** One issue of the project's repository by number, with its body; used only when `implement` is planned. */
  fetchIssueDetail(project: GithubProject, number: number): Promise<SourceResult<IssueDetail>>;
}

type JsonObject = Record<string, unknown>;

const USER_AGENT = "pohunek-work";
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SLUG_PATTERN = /^[A-Za-z0-9_.-]+$/;
const LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const GRAPHQL_ERROR_TYPE_PATTERN = /^[A-Z][A-Z_]{0,39}$/;

class SourceFailureError extends Error {
  public readonly code: SourceErrorCode;

  public constructor(code: SourceErrorCode, message: string) {
    super(message);
    this.name = "SourceFailureError";
    this.code = code;
  }
}

function schemaMismatch(label: string): SourceFailureError {
  return new SourceFailureError("invalid_response", `GitHub response does not match the expected schema (${label})`);
}

function truncated(label: string): SourceFailureError {
  return new SourceFailureError("truncated", `GitHub ${label} has more pages that cannot be followed`);
}

// ------------------------------------------------------------ JSON readers

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw schemaMismatch(label);
  }
  return value as JsonObject;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw schemaMismatch(label);
  }
  return value as unknown[];
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw schemaMismatch(label);
  }
  return value;
}

function asNullableString(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : asString(value, label);
}

function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw schemaMismatch(label);
  }
  return value;
}

function asInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw schemaMismatch(label);
  }
  return value;
}

function asOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) {
    throw schemaMismatch(label);
  }
  return found;
}

// ----------------------------------------------------------- normalization

const REVIEW_STATES: readonly ReviewState[] = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"];
const REVIEW_DECISIONS: readonly ReviewDecision[] = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"];
const MERGEABLE_VALUES: readonly Mergeable[] = ["MERGEABLE", "CONFLICTING", "UNKNOWN"];

// CheckRun conclusion -> outcome:
//   SUCCESS -> success
//   NEUTRAL, SKIPPED -> neutral
//   FAILURE, TIMED_OUT, CANCELLED, STARTUP_FAILURE, ACTION_REQUIRED, STALE -> failure
//   status not COMPLETED, or conclusion null -> pending
// StatusContext state -> outcome:
//   SUCCESS -> success; FAILURE, ERROR -> failure; PENDING, EXPECTED -> pending
const CHECK_RUN_CONCLUSIONS: Readonly<Record<string, CheckOutcome>> = {
  SUCCESS: "success",
  NEUTRAL: "neutral",
  SKIPPED: "neutral",
  FAILURE: "failure",
  TIMED_OUT: "failure",
  CANCELLED: "failure",
  STARTUP_FAILURE: "failure",
  ACTION_REQUIRED: "failure",
  STALE: "failure",
};

const STATUS_CONTEXT_STATES: Readonly<Record<string, CheckOutcome>> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending",
};

function lookupOutcome(table: Readonly<Record<string, CheckOutcome>>, key: string, label: string): CheckOutcome {
  const outcome = Object.hasOwn(table, key) ? table[key] : undefined;
  if (outcome === undefined) {
    throw schemaMismatch(label);
  }
  return outcome;
}

function toActor(value: unknown, label: string): Actor | null {
  if (value === null || value === undefined) {
    return null;
  }
  const actor = asObject(value, label);
  const login = asString(actor["login"], `${label}.login`);
  return { login: login.replace(/\[bot\]$/i, ""), isBot: actor["__typename"] === "Bot" };
}

function connectionNodes(container: JsonObject, key: string, label: string): unknown[] {
  const connection = asObject(container[key], label);
  return asArray(connection["nodes"], `${label}.nodes`);
}

function toReview(value: unknown): Review {
  const review = asObject(value, "review");
  return {
    id: asString(review["id"], "review.id"),
    author: toActor(review["author"], "review.author"),
    state: asOneOf(review["state"], REVIEW_STATES, "review.state"),
    submittedAt: asNullableString(review["submittedAt"], "review.submittedAt"),
  };
}

function toThread(value: unknown): Thread {
  const thread = asObject(value, "thread");
  const comments: ThreadComment[] = connectionNodes(thread, "comments", "thread.comments").map((raw) => {
    const comment = asObject(raw, "thread.comment");
    return {
      author: toActor(comment["author"], "thread.comment.author"),
      createdAt: asString(comment["createdAt"], "thread.comment.createdAt"),
    };
  });
  return {
    id: asString(thread["id"], "thread.id"),
    isResolved: asBoolean(thread["isResolved"], "thread.isResolved"),
    isOutdated: asBoolean(thread["isOutdated"], "thread.isOutdated"),
    comments,
  };
}

function toTimelineEvent(value: unknown): TimelineEvent {
  const item = asObject(value, "timeline item");
  switch (item["__typename"]) {
    case "PullRequestCommit": {
      const commit = asObject(item["commit"], "timeline commit");
      return { kind: "commit", at: asString(commit["committedDate"], "timeline commit date") };
    }
    case "HeadRefForcePushedEvent":
      return { kind: "force_push", at: asString(item["createdAt"], "timeline force push date") };
    default:
      throw schemaMismatch("timeline item type");
  }
}

/** Reviewers other than users and teams (bots, mannequins) cannot be the owner and are skipped. */
function toReviewRequest(value: unknown): ReviewRequest | null {
  const request = asObject(value, "review request");
  const reviewer = request["requestedReviewer"];
  if (reviewer === null || reviewer === undefined) {
    return null;
  }
  const target = asObject(reviewer, "review request reviewer");
  if (target["__typename"] === "User") {
    return { kind: "user", login: asString(target["login"], "review request login") };
  }
  if (target["__typename"] === "Team") {
    return { kind: "team", slug: asString(target["slug"], "review request slug") };
  }
  return null;
}

function toCheck(value: unknown): Check {
  const context = asObject(value, "check context");
  if (context["__typename"] === "CheckRun") {
    const name = asString(context["name"], "check name");
    const status = asString(context["status"], "check status");
    const conclusion = asNullableString(context["conclusion"], "check conclusion");
    if (status !== "COMPLETED" || conclusion === null) {
      return { name, outcome: "pending" };
    }
    return { name, outcome: lookupOutcome(CHECK_RUN_CONCLUSIONS, conclusion, "check conclusion") };
  }
  if (context["__typename"] === "StatusContext") {
    const name = asString(context["context"], "status context name");
    const state = asString(context["state"], "status context state");
    return { name, outcome: lookupOutcome(STATUS_CONTEXT_STATES, state, "status context state") };
  }
  throw schemaMismatch("check context type");
}

function latestCommit(pr: JsonObject): JsonObject | null {
  const nodes = connectionNodes(pr, "commits", "commits");
  const first: unknown = nodes[0];
  if (first === undefined) {
    return null;
  }
  return asObject(asObject(first, "commit node")["commit"], "commit");
}

function rollupOf(commit: JsonObject | null): JsonObject | null {
  if (commit === null) {
    return null;
  }
  const rollup = commit["statusCheckRollup"];
  return rollup === null || rollup === undefined ? null : asObject(rollup, "statusCheckRollup");
}

/** Numbers of the issues of `repo` among the closing references; GitHub repository names are case-insensitive. */
function closingIssueNumbers(pr: JsonObject, repo: string, withClosing: boolean): number[] {
  if (!withClosing) {
    return [];
  }
  const numbers = new Set<number>();
  for (const raw of connectionNodes(pr, "closingIssuesReferences", "closingIssuesReferences")) {
    const reference = asObject(raw, "closing reference");
    const owner = asString(
      asObject(reference["repository"], "closing reference repository")["nameWithOwner"],
      "closing reference repository.nameWithOwner",
    );
    const number = asInteger(reference["number"], "closing reference number");
    if (owner.toLowerCase() === repo.toLowerCase()) {
      numbers.add(number);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}

function labelNames(container: JsonObject): string[] {
  return connectionNodes(container, "labels", "labels").map((node) =>
    asString(asObject(node, "label")["name"], "label.name"),
  );
}

/** True when a label equals the project's ignore label (case-insensitive); false when the project has none. */
function carriesIgnoreLabel(labels: readonly string[], ignoreLabel: string | null): boolean {
  return ignoreLabel !== null && firstNameOf(labels, [ignoreLabel]) !== null;
}

function toPullRequest(pr: JsonObject, relation: PullRequestRelation, project: ProjectConfig): PullRequest {
  const repo = asString(asObject(pr["repository"], "repository")["nameWithOwner"], "repository.nameWithOwner");
  const number = asInteger(pr["number"], "number");
  const rollup = rollupOf(latestCommit(pr));
  const decision = pr["reviewDecision"];
  const requests: ReviewRequest[] = [];
  for (const raw of connectionNodes(pr, "reviewRequests", "reviewRequests")) {
    const request = toReviewRequest(raw);
    if (request !== null) {
      requests.push(request);
    }
  }
  return {
    id: `${repo}#${number}`,
    repo,
    number,
    url: asString(pr["url"], "url"),
    title: asString(pr["title"], "title"),
    author: toActor(pr["author"], "author"),
    relation,
    isDraft: asBoolean(pr["isDraft"], "isDraft"),
    isCrossRepository: asBoolean(pr["isCrossRepository"], "isCrossRepository"),
    headRefName: asString(pr["headRefName"], "headRefName"),
    headSha: asString(pr["headRefOid"], "headRefOid"),
    baseRefName: asString(pr["baseRefName"], "baseRefName"),
    reviewDecision:
      decision === null || decision === undefined ? null : asOneOf(decision, REVIEW_DECISIONS, "reviewDecision"),
    mergeable: asOneOf(pr["mergeable"], MERGEABLE_VALUES, "mergeable"),
    reviews: connectionNodes(pr, "reviews", "reviews").map(toReview),
    threads: connectionNodes(pr, "reviewThreads", "reviewThreads").map(toThread),
    timeline: connectionNodes(pr, "timelineItems", "timelineItems").map(toTimelineEvent),
    reviewRequests: requests,
    checks: rollup === null ? [] : connectionNodes(rollup, "contexts", "contexts").map(toCheck),
    closingIssueNumbers: closingIssueNumbers(pr, project.repo, project.issueSource.kind === "github"),
    ignored: project.ignoreLabel !== null && carriesIgnoreLabel(labelNames(pr), project.ignoreLabel),
    updatedAt: asString(pr["updatedAt"], "updatedAt"),
  };
}

// --------------------------------------------------------------- transport

interface Transport {
  readonly token: string;
  readonly config: GithubConfig;
  readonly fetchFn: FetchLike;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Schema names only: error `type`, `extensions.code` and the field path; free text is never copied. */
function graphqlErrorLabel(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const error = raw as JsonObject;
  const extensions = error["extensions"];
  const code =
    typeof extensions === "object" && extensions !== null ? (extensions as JsonObject)["code"] : undefined;
  const type = typeof error["type"] === "string" ? error["type"] : code;
  const path = Array.isArray(error["path"])
    ? (error["path"] as unknown[])
        .filter((segment): segment is string | number => typeof segment === "string" || typeof segment === "number")
        .map(String)
        .filter((segment) => /^[A-Za-z0-9_]{1,40}$/.test(segment))
        .join(".")
    : "";
  const label = typeof type === "string" && GRAPHQL_ERROR_TYPE_PATTERN.test(type) ? type : "";
  const joined = [label, path === "" ? "" : `at ${path}`].filter((part) => part !== "").join(" ");
  return joined === "" ? null : joined;
}

function graphqlErrorFailure(errors: unknown[]): SourceFailureError {
  const labels = errors.map(graphqlErrorLabel).filter((label): label is string => label !== null);
  const hasRateLimit = errors.some(
    (raw) => typeof raw === "object" && raw !== null && (raw as JsonObject)["type"] === "RATE_LIMITED",
  );
  if (hasRateLimit) {
    return new SourceFailureError("rate_limited", "GitHub GraphQL rate limit reached");
  }
  const detail = labels.length > 0 ? `: ${[...new Set(labels)].slice(0, 5).join("; ")}` : "";
  return new SourceFailureError("invalid_response", `GitHub GraphQL returned errors${detail}`);
}

/** Decides whether one GraphQL error of a response is expected and leaves the rest of the data usable. */
type ToleratedError = (error: unknown) => boolean;

async function send(transport: Transport, request: GraphqlRequest, tolerated?: ToleratedError): Promise<JsonObject> {
  let response: Response;
  try {
    response = await transport.fetchFn(transport.config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${transport.token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(transport.config.timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new SourceFailureError("timeout", "GitHub request timed out");
    }
    throw new SourceFailureError("unavailable", "GitHub request failed");
  }

  if (response.status === 401) {
    throw new SourceFailureError("unauthenticated", "GitHub rejected the token (HTTP 401)");
  }
  if (response.status === 403 || response.status === 429) {
    throw new SourceFailureError("rate_limited", `GitHub refused the request (HTTP ${response.status})`);
  }
  if (response.status >= 500) {
    throw new SourceFailureError("unavailable", `GitHub is unavailable (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new SourceFailureError("invalid_response", `GitHub returned HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new SourceFailureError("timeout", "GitHub request timed out");
    }
    throw new SourceFailureError("invalid_response", "GitHub response is not valid JSON");
  }
  const envelope = asObject(body, "envelope");
  const errors = envelope["errors"];
  if (errors !== undefined && errors !== null) {
    const list = Array.isArray(errors) ? (errors as unknown[]) : [];
    if (tolerated === undefined || list.length === 0 || !list.every(tolerated)) {
      throw graphqlErrorFailure(list);
    }
  }
  // rateLimit.remaining is the budget left after this query, so 0 on a complete response is valid;
  // exhaustion arrives as a RATE_LIMITED error or HTTP 403/429.
  return asObject(envelope["data"], "data");
}

async function obtainToken(config: GithubConfig, execFn: Exec): Promise<string> {
  let result;
  try {
    result = await execFn([config.ghBin, "auth", "token"], { timeoutMs: config.timeoutMs });
  } catch (error) {
    if (error instanceof SpawnError) {
      throw new SourceFailureError("unauthenticated", "gh is not available to read the GitHub token");
    }
    throw new SourceFailureError("unauthenticated", "reading the GitHub token failed");
  }
  if (result.timedOut) {
    throw new SourceFailureError("timeout", "gh auth token timed out");
  }
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || token === "" || /\s/.test(token)) {
    throw new SourceFailureError("unauthenticated", "gh has no usable GitHub token (run gh auth login)");
  }
  return token;
}

// -------------------------------------------------------------- pagination

interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function readPageInfo(connection: JsonObject, label: string): PageInfo {
  const info = asObject(connection["pageInfo"], `${label}.pageInfo`);
  return {
    hasNextPage: asBoolean(info["hasNextPage"], `${label}.hasNextPage`),
    endCursor: asNullableString(info["endCursor"], `${label}.endCursor`),
  };
}

/** Cursors already requested per connection object; a repeat means the walk would never end. */
type SeenCursors = WeakMap<JsonObject, Set<string>>;

/** Returns the cursor of the next page, or null when the connection is complete. */
function nextCursor(connection: JsonObject, label: string, seen: SeenCursors): string | null {
  const info = readPageInfo(connection, label);
  if (!info.hasNextPage) {
    return null;
  }
  const used = seen.get(connection) ?? new Set<string>();
  seen.set(connection, used);
  if (info.endCursor === null || info.endCursor === "" || used.has(info.endCursor)) {
    throw truncated(label);
  }
  used.add(info.endCursor);
  return info.endCursor;
}

interface PendingPage {
  readonly kind: ConnectionKind;
  readonly nodeId: string;
  /** Object that holds the connection under `connectionKey`. */
  readonly container: JsonObject;
  readonly connectionKey: string;
  readonly after: string;
}

type CollectPending = (roots: readonly JsonObject[], seen: SeenCursors) => PendingPage[];

type CheckConnection = (kind: ConnectionKind, nodeId: string, container: JsonObject, connectionKey: string) => void;

function pendingChecker(pending: PendingPage[], seen: SeenCursors): CheckConnection {
  return (kind: ConnectionKind, nodeId: string, container: JsonObject, connectionKey: string): void => {
    const connection = asObject(container[connectionKey], kind);
    const after = nextCursor(connection, kind, seen);
    if (after !== null) {
      pending.push({ kind, nodeId, container, connectionKey, after });
    }
  };
}

/**
 * Pages still missing from the labels of issues, and from their Project items when the document
 * requested them: a page cut short could hide a started or paused label or the item of the
 * configured Project.
 */
function issuePendingCollector(withProjectItems: boolean): CollectPending {
  return (issues, seen) => {
    const pending: PendingPage[] = [];
    const check = pendingChecker(pending, seen);
    for (const issue of issues) {
      const issueId = asString(issue["id"], "id");
      check("issueLabels", issueId, issue, "labels");
      if (withProjectItems) {
        check("issueProjectItems", issueId, issue, "projectItems");
      }
    }
    return pending;
  };
}

function collectPendingPullRequests(prs: readonly JsonObject[], seen: SeenCursors, shape: SearchShape): PendingPage[] {
  const pending: PendingPage[] = [];
  const check = pendingChecker(pending, seen);

  for (const pr of prs) {
    const prId = asString(pr["id"], "id");
    check("reviews", prId, pr, "reviews");
    check("reviewRequests", prId, pr, "reviewRequests");
    check("timelineItems", prId, pr, "timelineItems");
    check("reviewThreads", prId, pr, "reviewThreads");
    if (shape.closingReferences) {
      check("closingIssues", prId, pr, "closingIssuesReferences");
    }
    if (shape.pullRequestLabels) {
      check("pullRequestLabels", prId, pr, "labels");
    }
    for (const raw of connectionNodes(pr, "reviewThreads", "reviewThreads")) {
      const thread = asObject(raw, "thread");
      check("threadComments", asString(thread["id"], "thread.id"), thread, "comments");
    }
    const commit = latestCommit(pr);
    const rollup = rollupOf(commit);
    if (commit !== null && rollup !== null) {
      check("checkContexts", asString(commit["id"], "commit.id"), rollup, "contexts");
    }
  }
  return pending;
}

function walkPath(root: unknown, path: readonly string[], label: string): JsonObject {
  let current = asObject(root, label);
  for (const segment of path) {
    current = asObject(current[segment], label);
  }
  return current;
}

/**
 * Splits pending pages, in order, into batches whose estimated node count stays
 * within the GitHub limit. A page that cannot fit even alone is a configuration error.
 */
function batchPending(pending: readonly PendingPage[], config: GithubConfig): PendingPage[][] {
  const batches: PendingPage[][] = [];
  let current: PendingPage[] = [];
  let currentNodes = 0;
  for (const page of pending) {
    const cost = estimateConnectionNodes(page.kind, config);
    if (cost > GITHUB_MAX_NODES) {
      throw new SourceFailureError(
        "not_configured",
        "github page sizes exceed the GitHub node limit for a nested connection; lower the page sizes",
      );
    }
    if (current.length > 0 && currentNodes + cost > GITHUB_MAX_NODES) {
      batches.push(current);
      current = [];
      currentNodes = 0;
    }
    current.push(page);
    currentNodes += cost;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

async function completeNestedConnections(
  transport: Transport,
  roots: readonly JsonObject[],
  seen: SeenCursors,
  collect: CollectPending,
  statusField: string | null = null,
): Promise<void> {
  for (;;) {
    const pending = collect(roots, seen);
    if (pending.length === 0) {
      return;
    }
    for (const batch of batchPending(pending, transport.config)) {
      const specs: ConnectionPageSpec[] = batch.map((page, index) => ({
        alias: `c${index}`,
        kind: page.kind,
        nodeId: page.nodeId,
        after: page.after,
      }));
      const data = await send(transport, buildConnectionRequest(specs, {
        nestedPageSize: transport.config.nestedPageSize,
        threadCommentPageSize: transport.config.threadCommentPageSize,
      }, statusField));
      batch.forEach((page, index) => {
        const fetched = walkPath(data[`c${index}`], CONNECTION_KINDS[page.kind].path, page.kind);
        const target = asObject(page.container[page.connectionKey], page.kind);
        const merged = [
          ...asArray(target["nodes"], `${page.kind}.nodes`),
          ...asArray(fetched["nodes"], `${page.kind}.nodes`),
        ];
        target["nodes"] = merged;
        target["pageInfo"] = fetched["pageInfo"];
      });
    }
  }
}

interface SearchState {
  readonly alias: string;
  readonly relation: PullRequestRelation;
  readonly queryString: string;
  after: string | null;
  done: boolean;
  collected: number;
}

interface CollectedPullRequest {
  readonly raw: JsonObject;
  relation: PullRequestRelation;
}

async function runSearches(
  transport: Transport,
  searches: SearchState[],
  shape: SearchShape,
): Promise<Map<string, CollectedPullRequest>> {
  const collected = new Map<string, CollectedPullRequest>();
  const searchCursors = new WeakMap<SearchState, Set<string>>();

  for (;;) {
    const active = searches.filter((search) => !search.done);
    if (active.length === 0) {
      return collected;
    }
    const specs: SearchSpec[] = active.map((search) => ({
      alias: search.alias,
      queryString: search.queryString,
      after: search.after,
    }));
    const data = await send(
      transport,
      buildSearchRequest(specs, {
        pullRequestPageSize: transport.config.pullRequestPageSize,
        nestedPageSize: transport.config.nestedPageSize,
        threadCommentPageSize: transport.config.threadCommentPageSize,
      }, shape),
    );

    for (const search of active) {
      const connection = asObject(data[search.alias], `search ${search.alias}`);
      const nodes = asArray(connection["nodes"], "search.nodes");
      for (const rawNode of nodes) {
        const raw = asObject(rawNode, "search node");
        const id = asString(raw["id"], "search node id");
        const existing = collected.get(id);
        if (existing === undefined) {
          collected.set(id, { raw, relation: search.relation });
        } else if (search.relation === "authored") {
          existing.relation = "authored";
        }
      }
      search.collected += nodes.length;

      const info = readPageInfo(connection, "search");
      if (!info.hasNextPage) {
        search.done = true;
        if (search.collected < asInteger(connection["issueCount"], "search.issueCount")) {
          throw truncated("search results");
        }
        continue;
      }
      const used = searchCursors.get(search) ?? new Set<string>();
      searchCursors.set(search, used);
      if (info.endCursor === null || info.endCursor === "" || used.has(info.endCursor)) {
        throw truncated("search results");
      }
      used.add(info.endCursor);
      search.after = info.endCursor;
    }
  }
}

const MS_PER_DAY = 86_400_000;

function toMergedPullRequest(raw: unknown): MergedPullRequest {
  const pr = asObject(raw, "merged search node");
  const repo = asString(asObject(pr["repository"], "repository")["nameWithOwner"], "repository.nameWithOwner");
  const number = asInteger(pr["number"], "number");
  return {
    id: `${repo}#${number}`,
    number,
    url: asString(pr["url"], "url"),
    title: asString(pr["title"], "title"),
    headRefName: asString(pr["headRefName"], "headRefName"),
    mergedAt: asString(pr["mergedAt"], "mergedAt"),
  };
}

/** Follows the merged search to its end; a page that cannot be followed fails instead of dropping results. */
async function runMergedSearch(transport: Transport, queryString: string): Promise<MergedPullRequest[]> {
  const found: MergedPullRequest[] = [];
  const used = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const data = await send(transport, buildMergedSearchRequest(queryString, after, transport.config.pullRequestPageSize));
    const connection = asObject(data["merged"], "merged search");
    const nodes = asArray(connection["nodes"], "merged search.nodes");
    for (const node of nodes) found.push(toMergedPullRequest(node));
    const info = readPageInfo(connection, "merged search");
    if (!info.hasNextPage) {
      if (found.length < asInteger(connection["issueCount"], "merged search.issueCount")) {
        throw truncated("merged search results");
      }
      return found;
    }
    if (info.endCursor === null || info.endCursor === "" || used.has(info.endCursor)) {
      throw truncated("merged search results");
    }
    used.add(info.endCursor);
    after = info.endCursor;
  }
}

/** Follows the issue search to its end; a page that cannot be followed fails instead of dropping results. */
async function runIssueSearch(
  transport: Transport,
  queryString: string,
  statusField: string | null,
): Promise<JsonObject[]> {
  const found: JsonObject[] = [];
  const used = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const data = await send(transport, buildIssueSearchRequest(queryString, after, transport.config, statusField));
    const connection = asObject(data["issues"], "issue search");
    for (const node of asArray(connection["nodes"], "issue search.nodes")) {
      found.push(asObject(node, "issue search node"));
    }
    const info = readPageInfo(connection, "issue search");
    if (!info.hasNextPage) {
      if (found.length < asInteger(connection["issueCount"], "issue search.issueCount")) {
        throw truncated("issue search results");
      }
      return found;
    }
    if (info.endCursor === null || info.endCursor === "" || used.has(info.endCursor)) {
      throw truncated("issue search results");
    }
    used.add(info.endCursor);
    after = info.endCursor;
  }
}

/** The first of the wanted names among the found ones, spelled as GitHub returns it; names compare case-insensitively. */
function firstNameOf(found: readonly string[], wanted: readonly string[]): string | null {
  const folded = wanted.map((name) => name.toLowerCase());
  return found.find((name) => folded.includes(name.toLowerCase())) ?? null;
}

const SINGLE_SELECT_VALUE = "ProjectV2ItemFieldSingleSelectValue";

/**
 * Option names the configured Project's items of the issue carry in the status field, as GitHub
 * spells them. Items of other Projects (another number or owner) and an unset field yield nothing, archived items are excluded by the query;
 * a value that is not a single-select value is a schema mismatch.
 */
function projectOptionNames(raw: JsonObject, status: GithubProjectStatus): string[] {
  const names: string[] = [];
  for (const node of connectionNodes(raw, "projectItems", "projectItems")) {
    const item = asObject(node, "project item");
    const project = asObject(item["project"], "project item.project");
    if (asInteger(project["number"], "project item.project.number") !== status.number) continue;
    // An owner without a login is neither a user nor an organization, so it cannot own the configured Project.
    const login = asObject(project["owner"], "project item.project.owner")["login"];
    if (typeof login !== "string" || login.toLowerCase() !== status.owner.toLowerCase()) continue;
    const value = item["fieldValueByName"];
    if (value === null || value === undefined) continue;
    const field = asObject(value, "project item.fieldValueByName");
    if (field["__typename"] !== SINGLE_SELECT_VALUE) {
      throw schemaMismatch("project item.fieldValueByName type");
    }
    names.push(asString(field["name"], "project item.fieldValueByName.name"));
  }
  return names;
}

/**
 * Started: a started label or option and no paused one. Paused: a paused label or option, which
 * outranks every started one. An issue with neither is not on the table and yields null. `state` is
 * the deciding name, the label before the option when both signals decide the same side.
 */
function toIssue(raw: JsonObject, project: GithubProject): Issue | null {
  const source = project.issueSource;
  const labels = labelNames(raw);
  const options = source.projectStatus === null ? [] : projectOptionNames(raw, source.projectStatus);
  const usesLabels = source.signal !== "project";
  const paused =
    (usesLabels ? firstNameOf(labels, source.pausedLabels) : null) ??
    (source.projectStatus === null ? null : firstNameOf(options, source.projectStatus.pausedOptions));
  const started =
    (usesLabels ? firstNameOf(labels, source.startedLabels) : null) ??
    (source.projectStatus === null ? null : firstNameOf(options, source.projectStatus.startedOptions));
  const state = paused ?? started;
  if (state === null) {
    return null;
  }
  return {
    id: `${project.repo}#${asInteger(raw["number"], "number")}`,
    title: asString(raw["title"], "title"),
    url: asString(raw["url"], "url"),
    state,
    started: paused === null,
    paused: paused !== null,
    assigneeIsMe: true,
    attachmentUrls: [],
    ignored: carriesIgnoreLabel(labels, project.ignoreLabel),
  };
}

/** A `NOT_FOUND` error on the path to the Project, or to its field: the validation reports which one is missing. */
function missingProjectPartError(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const error = raw as JsonObject;
  const path = error["path"];
  const expected = ["repositoryOwner", "projectV2", "field"];
  return (
    error["type"] === "NOT_FOUND" &&
    Array.isArray(path) &&
    path.length >= 1 &&
    path.length <= expected.length &&
    path.every((segment, index) => segment === expected[index])
  );
}

/**
 * Checks that the configured Project, its field and every configured option exist. A failure is
 * `not_configured` with the missing part named; an unreadable answer fails like any other request.
 */
async function validateProjectStatus(transport: Transport, status: GithubProjectStatus): Promise<void> {
  if (!LOGIN_PATTERN.test(status.owner)) {
    throw new SourceFailureError("not_configured", "status_project_owner is not a valid GitHub login");
  }
  const data = await send(
    transport,
    buildProjectStatusValidationRequest(status.owner, status.number, status.field),
    missingProjectPartError,
  );
  const owner = data["repositoryOwner"];
  if (owner === null) {
    throw new SourceFailureError("not_configured", "the GitHub Project owner does not exist (status_project_owner)");
  }
  const project = asObject(owner, "repositoryOwner")["projectV2"];
  if (project === null || project === undefined) {
    throw new SourceFailureError(
      "not_configured",
      "the GitHub Project does not exist or the token cannot read it (status_project_owner, status_project_number; reading needs the read:project scope)",
    );
  }
  const projectObject = asObject(project, "projectV2");
  if (asInteger(projectObject["number"], "projectV2.number") !== status.number) {
    throw schemaMismatch("projectV2.number");
  }
  const field = projectObject["field"];
  if (field === null || field === undefined) {
    throw new SourceFailureError("not_configured", "the GitHub Project has no field named status_field");
  }
  const fieldObject = asObject(field, "projectV2.field");
  if (fieldObject["__typename"] !== "ProjectV2SingleSelectField") {
    throw new SourceFailureError("not_configured", "the GitHub Project field named status_field is not a single-select field");
  }
  const known = asArray(fieldObject["options"], "projectV2.field.options").map((option) =>
    asString(asObject(option, "projectV2.field.option")["name"], "projectV2.field.option.name").toLowerCase(),
  );
  for (const option of [...status.startedOptions, ...status.pausedOptions]) {
    if (!known.includes(option.toLowerCase())) {
      throw new SourceFailureError(
        "not_configured",
        `the status field has no option named "${option}" (status_started_options, status_paused_options)`,
      );
    }
  }
}

// ------------------------------------------------------------------ source

const ISSUE_NUMBER = /^[1-9][0-9]*$/;

/** A `NOT_FOUND` error whose path is exactly `repository.<alias>` of one lookup alias: the issue does not exist. */
function missingIssueError(aliases: ReadonlySet<string>): ToleratedError {
  return (raw) => {
    if (typeof raw !== "object" || raw === null) return false;
    const error = raw as JsonObject;
    const path = error["path"];
    return (
      error["type"] === "NOT_FOUND" &&
      Array.isArray(path) &&
      path.length === 2 &&
      path[0] === "repository" &&
      typeof path[1] === "string" &&
      aliases.has(path[1])
    );
  };
}

function validateInputs(project: ProjectConfig, identity: IdentityConfig): void {
  if (!REPO_PATTERN.test(project.repo)) {
    throw new SourceFailureError("not_configured", `project ${project.name} has an invalid repo`);
  }
  if (!LOGIN_PATTERN.test(identity.githubLogin)) {
    throw new SourceFailureError("not_configured", "identity.github_login is not a valid GitHub login");
  }
  for (const team of identity.reviewTeams) {
    const parts = team.split("/");
    const valid = parts.length === 2 ? REPO_PATTERN.test(team) : SLUG_PATTERN.test(team);
    if (!valid) {
      throw new SourceFailureError("not_configured", "identity.review_teams contains an invalid team");
    }
  }
}

/** Team entries without an organization belong to the organization of the project repo. */
function teamQualifier(team: string, repo: string): string {
  if (team.includes("/")) {
    return team;
  }
  const owner = repo.split("/")[0] ?? "";
  return `${owner}/${team}`;
}

function buildSearches(project: ProjectConfig, identity: IdentityConfig): SearchState[] {
  const base = `repo:${project.repo} is:pr is:open`;
  const make = (alias: string, relation: PullRequestRelation, qualifier: string): SearchState => ({
    alias,
    relation,
    queryString: `${base} ${qualifier}`,
    after: null,
    done: false,
    collected: 0,
  });
  return [
    make("authored", "authored", `author:${identity.githubLogin}`),
    make("requested", "review_requested", `user-review-requested:${identity.githubLogin}`),
    ...identity.reviewTeams.map((team, index) =>
      make(`team${index}`, "review_requested", `team-review-requested:${teamQualifier(team, project.repo)}`),
    ),
  ];
}

/** The issue of an `issue(number:)` lookup; an issue that does not exist (or no access to it) is a schema mismatch for the caller to report. */
function toIssueDetail(data: JsonObject, project: GithubProject, number: number): IssueDetail {
  const repository = data["repository"] === null ? null : asObject(data["repository"], "repository");
  const raw = repository === null || repository["issue"] === null ? null : asObject(repository["issue"], "issue");
  if (raw === null) {
    throw new SourceFailureError("invalid_response", "GitHub has no such issue in the repository (or the token cannot read it)");
  }
  if (asInteger(raw["number"], "issue.number") !== number) throw schemaMismatch("issue.number");
  return {
    id: `${project.repo}#${number.toString()}`,
    title: asString(raw["title"], "issue.title"),
    url: asString(raw["url"], "issue.url"),
    open: asOneOf(raw["state"], ["OPEN", "CLOSED"], "issue.state") === "OPEN",
    body: asString(raw["body"], "issue.body"),
  };
}

export function createGithubSource(
  config: { readonly github: GithubConfig; readonly identity: IdentityConfig },
  deps: GithubSourceDeps = {},
): GithubSource {
  const execFn = deps.exec ?? defaultExec;

  const fetchPullRequests = async (project: ProjectConfig): Promise<SourceResult<readonly PullRequest[]>> => {
    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);
    try {
      validateInputs(project, config.identity);
      const searches = buildSearches(project, config.identity);
      const shape: SearchShape = {
        closingReferences: project.issueSource.kind === "github",
        pullRequestLabels: project.ignoreLabel !== null,
      };
      if (estimateRequestNodes(config.github, searches.length, shape) > GITHUB_MAX_NODES) {
        throw new SourceFailureError(
          "not_configured",
          "github page sizes exceed the GitHub node limit for the configured review teams; lower the page sizes",
        );
      }
      const token = await obtainToken(config.github, execFn);
      const transport: Transport = {
        token,
        config: config.github,
        fetchFn: deps.fetch ?? ((input, init) => fetch(input, init)),
      };
      const collected = await runSearches(transport, searches, shape);
      const raws = [...collected.values()].map((entry) => entry.raw);
      await completeNestedConnections(transport, raws, new WeakMap(), (roots, seen) =>
        collectPendingPullRequests(roots, seen, shape),
      );
      const data = [...collected.values()].map((entry) => toPullRequest(entry.raw, entry.relation, project));
      return { ok: true, source: "github", data, durationMs: elapsed() };
    } catch (error) {
      if (error instanceof SourceFailureError) {
        return { ok: false, source: "github", code: error.code, message: error.message, durationMs: elapsed() };
      }
      // Anything else is a plugin bug and surfaces to the caller instead of masquerading as a provider failure.
      throw error;
    }
  };

  const fetchMergedPullRequests = async (
    project: ProjectConfig,
  ): Promise<SourceResult<readonly MergedPullRequest[]>> => {
    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);
    try {
      validateInputs(project, config.identity);
      const since = new Date((deps.now ?? Date.now)() - config.github.mergedLookbackDays * MS_PER_DAY)
        .toISOString()
        .slice(0, 10);
      const queryString =
        `repo:${project.repo} is:pr is:merged author:${config.identity.githubLogin} merged:>=${since} sort:updated-desc`;
      const token = await obtainToken(config.github, execFn);
      const transport: Transport = {
        token,
        config: config.github,
        fetchFn: deps.fetch ?? ((input, init) => fetch(input, init)),
      };
      const data = await runMergedSearch(transport, queryString);
      return { ok: true, source: "github", data, durationMs: elapsed() };
    } catch (error) {
      if (error instanceof SourceFailureError) {
        return { ok: false, source: "github", code: error.code, message: error.message, durationMs: elapsed() };
      }
      throw error;
    }
  };

  const fetchIssues = async (project: GithubProject): Promise<SourceResult<readonly Issue[]>> => {
    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);
    try {
      validateInputs(project, config.identity);
      const queryString = `repo:${project.repo} is:issue is:open assignee:${config.identity.githubLogin}`;
      const token = await obtainToken(config.github, execFn);
      const transport: Transport = {
        token,
        config: config.github,
        fetchFn: deps.fetch ?? ((input, init) => fetch(input, init)),
      };
      const status = project.issueSource.projectStatus;
      if (status !== null) {
        await validateProjectStatus(transport, status);
      }
      const statusField = status === null ? null : status.field;
      const raws = await runIssueSearch(transport, queryString, statusField);
      await completeNestedConnections(
        transport,
        raws,
        new WeakMap(),
        issuePendingCollector(status !== null),
        statusField,
      );
      const data = raws.flatMap((raw) => toIssue(raw, project) ?? []);
      return { ok: true, source: "github_issues", data, durationMs: elapsed() };
    } catch (error) {
      if (error instanceof SourceFailureError) {
        return { ok: false, source: "github_issues", code: error.code, message: error.message, durationMs: elapsed() };
      }
      throw error;
    }
  };

  const fetchIgnoredKeys = async (
    project: GithubProject,
    keys: readonly string[],
  ): Promise<SourceResult<ReadonlySet<string>>> => {
    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);
    try {
      validateInputs(project, config.identity);
      const ignoreLabel = project.ignoreLabel;
      const prefix = `${project.repo.toLowerCase()}#`;
      const byNumber = new Map<number, string>();
      for (const key of keys) {
        const digits = key.slice(prefix.length);
        if (key.toLowerCase().startsWith(prefix) && ISSUE_NUMBER.test(digits) && Number.isSafeInteger(Number(digits))) {
          byNumber.set(Number(digits), key);
        }
      }
      const ignored = new Set<string>();
      if (ignoreLabel === null || byNumber.size === 0) {
        return { ok: true, source: "github_issues", data: ignored, durationMs: elapsed() };
      }
      const [owner = "", name = ""] = project.repo.split("/");
      const token = await obtainToken(config.github, execFn);
      const transport: Transport = {
        token,
        config: config.github,
        fetchFn: deps.fetch ?? ((input, init) => fetch(input, init)),
      };
      const numbers = [...byNumber.keys()];
      for (let start = 0; start < numbers.length; start += config.github.issuePageSize) {
        const batch = numbers.slice(start, start + config.github.issuePageSize);
        const aliases = new Set(batch.map((_, index) => `i${index.toString()}`));
        const data = await send(
          transport,
          buildIgnoredIssuesRequest(owner, name, batch, config.github.nestedPageSize),
          missingIssueError(aliases),
        );
        const repository = asObject(data["repository"], "repository");
        const found: { readonly number: number; readonly raw: JsonObject }[] = [];
        batch.forEach((number, index) => {
          const raw = repository[`i${index.toString()}`];
          if (raw === null) return;
          const issue = asObject(raw, "issue");
          if (asInteger(issue["number"], "issue.number") !== number) throw schemaMismatch("issue.number");
          found.push({ number, raw: issue });
        });
        // A label page cut short could hide the ignore label.
        await completeNestedConnections(transport, found.map((entry) => entry.raw), new WeakMap(), issuePendingCollector(false));
        for (const { number, raw } of found) {
          const key = byNumber.get(number);
          if (key !== undefined && carriesIgnoreLabel(labelNames(raw), ignoreLabel)) ignored.add(key);
        }
      }
      return { ok: true, source: "github_issues", data: ignored, durationMs: elapsed() };
    } catch (error) {
      if (error instanceof SourceFailureError) {
        return { ok: false, source: "github_issues", code: error.code, message: error.message, durationMs: elapsed() };
      }
      throw error;
    }
  };

  const fetchIssueDetail = async (project: GithubProject, number: number): Promise<SourceResult<IssueDetail>> => {
    const startedAt = performance.now();
    const elapsed = (): number => Math.round(performance.now() - startedAt);
    try {
      validateInputs(project, config.identity);
      if (!Number.isSafeInteger(number) || number <= 0) {
        throw new SourceFailureError("not_configured", "the issue number is not a positive integer");
      }
      const [owner = "", name = ""] = project.repo.split("/");
      const token = await obtainToken(config.github, execFn);
      const transport: Transport = {
        token,
        config: config.github,
        fetchFn: deps.fetch ?? ((input, init) => fetch(input, init)),
      };
      const data = await send(transport, buildIssueDetailRequest(owner, name, number));
      const detail = toIssueDetail(data, project, number);
      return { ok: true, source: "github_issues", data: detail, durationMs: elapsed() };
    } catch (error) {
      if (error instanceof SourceFailureError) {
        return { ok: false, source: "github_issues", code: error.code, message: error.message, durationMs: elapsed() };
      }
      throw error;
    }
  };

  return { fetchPullRequests, fetchMergedPullRequests, fetchIssues, fetchIgnoredKeys, fetchIssueDetail };
}
