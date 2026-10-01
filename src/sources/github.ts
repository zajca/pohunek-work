// GitHub source: open pull requests authored by the owner or awaiting the
// owner's review, fetched with batched read-only GraphQL queries.
//
// The token comes from `gh auth token`, lives only in memory and is only sent
// in the Authorization header to the configured endpoint. Failure messages are
// static text plus a short GraphQL error type; provider text never reaches them.

import type { GithubConfig, IdentityConfig, ProjectConfig } from "../types/config.ts";
import type {
  Actor,
  Check,
  CheckOutcome,
  Mergeable,
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
  buildSearchRequest,
  CONNECTION_KINDS,
  type ConnectionKind,
  type ConnectionPageSpec,
  type GraphqlRequest,
  type SearchSpec,
} from "./github-query.ts";
import { estimateConnectionNodes, estimateRequestNodes, GITHUB_MAX_NODES } from "../util/github-budget.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GithubSourceDeps {
  readonly exec?: Exec;
  readonly fetch?: FetchLike;
}

export interface GithubSource {
  fetchPullRequests(project: ProjectConfig): Promise<SourceResult<readonly PullRequest[]>>;
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

function toPullRequest(pr: JsonObject, relation: PullRequestRelation): PullRequest {
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
    headRefName: asString(pr["headRefName"], "headRefName"),
    baseRefName: asString(pr["baseRefName"], "baseRefName"),
    reviewDecision:
      decision === null || decision === undefined ? null : asOneOf(decision, REVIEW_DECISIONS, "reviewDecision"),
    mergeable: asOneOf(pr["mergeable"], MERGEABLE_VALUES, "mergeable"),
    reviews: connectionNodes(pr, "reviews", "reviews").map(toReview),
    threads: connectionNodes(pr, "reviewThreads", "reviewThreads").map(toThread),
    timeline: connectionNodes(pr, "timelineItems", "timelineItems").map(toTimelineEvent),
    reviewRequests: requests,
    checks: rollup === null ? [] : connectionNodes(rollup, "contexts", "contexts").map(toCheck),
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

async function send(transport: Transport, request: GraphqlRequest): Promise<JsonObject> {
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
    throw graphqlErrorFailure(Array.isArray(errors) ? (errors as unknown[]) : []);
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

function collectPending(prs: readonly JsonObject[], seen: SeenCursors): PendingPage[] {
  const pending: PendingPage[] = [];
  const check = (kind: ConnectionKind, nodeId: string, container: JsonObject, connectionKey: string): void => {
    const connection = asObject(container[connectionKey], kind);
    const after = nextCursor(connection, kind, seen);
    if (after !== null) {
      pending.push({ kind, nodeId, container, connectionKey, after });
    }
  };

  for (const pr of prs) {
    const prId = asString(pr["id"], "id");
    check("reviews", prId, pr, "reviews");
    check("reviewRequests", prId, pr, "reviewRequests");
    check("timelineItems", prId, pr, "timelineItems");
    check("reviewThreads", prId, pr, "reviewThreads");
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
  prs: readonly JsonObject[],
  seen: SeenCursors,
): Promise<void> {
  for (;;) {
    const pending = collectPending(prs, seen);
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
      }));
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
      }),
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

// ------------------------------------------------------------------ source

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
      if (estimateRequestNodes(config.github, searches.length) > GITHUB_MAX_NODES) {
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
      const collected = await runSearches(transport, searches);
      const raws = [...collected.values()].map((entry) => entry.raw);
      await completeNestedConnections(transport, raws, new WeakMap());
      const data = [...collected.values()].map((entry) => toPullRequest(entry.raw, entry.relation));
      return { ok: true, source: "github", data, durationMs: elapsed() };
    } catch (error) {
      if (error instanceof SourceFailureError) {
        return { ok: false, source: "github", code: error.code, message: error.message, durationMs: elapsed() };
      }
      // Anything else is a plugin bug and surfaces to the caller instead of masquerading as a provider failure.
      throw error;
    }
  };

  return { fetchPullRequests };
}
