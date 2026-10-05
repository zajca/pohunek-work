// Linear source: started issues assigned to the token owner for one team.
// The API key is sent as the raw Authorization value (personal API key form).

import type { LinearConfig, LinearProject } from "../types/config.ts";
import type { Issue, SourceErrorCode, SourceResult } from "../types/sources.ts";
import type { Exec } from "../util/exec.ts";
import { readKeyringSecret } from "./keyring.ts";

export interface LinearSource {
  fetchIssues(project: LinearProject): Promise<SourceResult<readonly Issue[]>>;
  /**
   * Of the issue keys and pull request URLs asked for, those whose issue carries the project's
   * ignore label: a key is the issue's own, a URL is a Linear attachment of the issue. The list
   * holds only started issues assigned to the owner, so a pull request can join an issue it does
   * not return. A key or URL that matches no issue of the project's team is not in the result.
   */
  fetchIgnoredKeys(
    project: LinearProject,
    keys: readonly string[],
    pullRequestUrls: readonly string[],
  ): Promise<SourceResult<ReadonlySet<string>>>;
}

export interface LinearDeps {
  readonly exec?: Exec;
  readonly fetch?: typeof fetch;
}

// The label selection is added only when the project has an ignore label.
function issuesQuery(withLabels: boolean): string {
  return `
query WorkIssues($first: Int!, $after: String, $teamKey: String!, $attachmentsFirst: Int!${withLabels ? ", $labelsFirst: Int!" : ""}) {
  issues(
    first: $first
    after: $after
    filter: {
      assignee: { isMe: { eq: true } }
      state: { type: { eq: "started" } }
      team: { key: { eq: $teamKey } }
    }
  ) {
    nodes {
      id
      identifier
      title
      url
      state { name type }
      attachments(first: $attachmentsFirst) {
        nodes { url }
        pageInfo { hasNextPage endCursor }
      }${
        withLabels
          ? `
      labels(first: $labelsFirst) {
        nodes { name }
        pageInfo { hasNextPage endCursor }
      }`
          : ""
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
}

const ATTACHMENTS_QUERY = `
query WorkIssueAttachments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    attachments(first: $first, after: $after) {
      nodes { url }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const LABELS_QUERY = `
query WorkIssueLabels($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    labels(first: $first, after: $after) {
      nodes { name }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

// Issues of one team by number, with the first page of their labels. At most `page_size` numbers
// are asked per request, so the document is a subset of the issue page query.
const IGNORED_ISSUES_QUERY = `
query WorkIgnoredIssues($first: Int!, $teamKey: String!, $numbers: [Float!]!, $labelsFirst: Int!) {
  issues(first: $first, filter: { team: { key: { eq: $teamKey } }, number: { in: $numbers } }) {
    nodes {
      id
      identifier
      labels(first: $labelsFirst) {
        nodes { name }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Issues of one team that carry one of the pull request URLs as an attachment. Each issue selects
// the same attachment and label pages as the issue page query, at most `page_size` issues per
// request, so the document stays within the complexity the loader validates.
const IGNORED_ATTACHMENT_ISSUES_QUERY = `
query WorkIgnoredAttachmentIssues($first: Int!, $teamKey: String!, $urls: [String!]!, $attachmentsFirst: Int!, $labelsFirst: Int!) {
  issues(first: $first, filter: { team: { key: { eq: $teamKey } }, attachments: { some: { url: { in: $urls } } } }) {
    nodes {
      id
      identifier
      attachments(first: $attachmentsFirst) {
        nodes { url }
        pageInfo { hasNextPage endCursor }
      }
      labels(first: $labelsFirst) {
        nodes { name }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_KEY = /^([A-Za-z0-9]+)-([1-9][0-9]*)$/;

const STATE_TYPES: ReadonlySet<string> = new Set([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);

class LinearFailure extends Error {
  public readonly code: SourceErrorCode;

  public constructor(code: SourceErrorCode, message: string) {
    super(message);
    this.name = "LinearFailure";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(what: string): LinearFailure {
  return new LinearFailure("invalid_response", `unexpected Linear response shape: ${what}`);
}

function str(obj: JsonObject, key: string, what: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    throw invalid(what);
  }
  return value;
}

function obj(value: unknown, what: string): JsonObject {
  if (!isObject(value)) {
    throw invalid(what);
  }
  return value;
}

function arr(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(what);
  }
  return value as readonly unknown[];
}

interface PageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function parsePageInfo(value: unknown, what: string): PageInfo {
  const info = obj(value, what);
  const { hasNextPage, endCursor } = info;
  if (typeof hasNextPage !== "boolean") {
    throw invalid(what);
  }
  if (endCursor !== null && endCursor !== undefined && typeof endCursor !== "string") {
    throw invalid(what);
  }
  return { hasNextPage, endCursor: typeof endCursor === "string" ? endCursor : null };
}

function parseAttachmentNodes(value: unknown, what: string): string[] {
  return arr(value, what).map((node) => str(obj(node, what), "url", what));
}

function parseLabelNames(value: unknown, what: string): string[] {
  return arr(value, what).map((node) => str(obj(node, what), "name", what));
}

/** Failure code for a GraphQL error list; only error codes and paths are used. */
function describeGraphqlErrors(errors: readonly unknown[]): LinearFailure {
  const parts: string[] = [];
  let code: SourceErrorCode = "invalid_response";
  for (const entry of errors) {
    const error = isObject(entry) ? entry : {};
    const extensions = isObject(error["extensions"]) ? error["extensions"] : {};
    const type = [extensions["code"], extensions["type"]].find(
      (candidate): candidate is string => typeof candidate === "string",
    );
    const path = Array.isArray(error["path"]) ? (error["path"] as unknown[]).map(String).join(".") : "";
    if (type === "RATELIMITED") {
      code = "rate_limited";
    } else if (type === "AUTHENTICATION_ERROR" && code === "invalid_response") {
      code = "unauthenticated";
    }
    parts.push(`${type ?? "unknown"}${path === "" ? "" : ` at ${path}`}`);
  }
  return new LinearFailure(code, `Linear GraphQL errors: ${parts.join(", ")}`);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

// Header values must be visible ASCII; anything else cannot be a Linear API key.
const HEADER_SAFE = /^[\x21-\x7e]+$/;

export function createLinearSource(config: LinearConfig, deps: LinearDeps = {}): LinearSource {
  const doFetch = deps.fetch ?? fetch;

  async function post(token: string, query: string, variables: JsonObject): Promise<JsonObject> {
    let response: Response;
    try {
      response = await doFetch(config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new LinearFailure("timeout", "Linear request timed out");
      }
      throw new LinearFailure("unavailable", "Linear request failed");
    }
    if (response.status === 401 || response.status === 403) {
      throw new LinearFailure("unauthenticated", `Linear rejected the token (HTTP ${response.status})`);
    }
    if (response.status === 429) {
      throw new LinearFailure("rate_limited", "Linear rate limit reached (HTTP 429)");
    }
    if (response.status >= 500) {
      throw new LinearFailure("unavailable", `Linear unavailable (HTTP ${response.status})`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (isTimeout(error)) {
        throw new LinearFailure("timeout", "Linear request timed out");
      }
      throw invalid(`HTTP ${response.status} body is not JSON`);
    }
    if (isObject(body) && Array.isArray(body["errors"]) && body["errors"].length > 0) {
      throw describeGraphqlErrors(body["errors"] as readonly unknown[]);
    }
    if (!response.ok) {
      throw invalid(`HTTP ${response.status}`);
    }
    return obj(obj(body, "body")["data"], "data");
  }

  async function remainingAttachments(
    token: string,
    issueId: string,
    start: PageInfo,
  ): Promise<string[]> {
    const collected: string[] = [];
    const seen = new Set<string>();
    let page = start;
    while (page.hasNextPage) {
      const cursor = page.endCursor;
      if (cursor === null || seen.has(cursor)) {
        throw new LinearFailure("truncated", "Linear attachments cannot be paginated further");
      }
      seen.add(cursor);
      const data = await post(token, ATTACHMENTS_QUERY, {
        id: issueId,
        first: config.pageSize,
        after: cursor,
      });
      const connection = obj(obj(data["issue"], "issue")["attachments"], "attachments");
      collected.push(...parseAttachmentNodes(connection["nodes"], "attachments.nodes"));
      page = parsePageInfo(connection["pageInfo"], "attachments.pageInfo");
    }
    return collected;
  }

  async function remainingLabels(token: string, issueId: string, start: PageInfo): Promise<string[]> {
    const collected: string[] = [];
    const seen = new Set<string>();
    let page = start;
    while (page.hasNextPage) {
      const cursor = page.endCursor;
      if (cursor === null || seen.has(cursor)) {
        throw new LinearFailure("truncated", "Linear labels cannot be paginated further");
      }
      seen.add(cursor);
      const data = await post(token, LABELS_QUERY, {
        id: issueId,
        first: config.pageSize,
        after: cursor,
      });
      const connection = obj(obj(data["issue"], "issue")["labels"], "labels");
      collected.push(...parseLabelNames(connection["nodes"], "labels.nodes"));
      page = parsePageInfo(connection["pageInfo"], "labels.pageInfo");
    }
    return collected;
  }

  async function isIgnored(
    token: string,
    node: JsonObject,
    ignoreLabel: string | null,
  ): Promise<boolean> {
    if (ignoreLabel === null) {
      return false;
    }
    const wanted = ignoreLabel.toLowerCase();
    const labels = obj(node["labels"], "issue.labels");
    const names = parseLabelNames(labels["nodes"], "issue.labels.nodes");
    if (names.some((name) => name.toLowerCase() === wanted)) {
      return true;
    }
    const rest = await remainingLabels(
      token,
      str(node, "id", "issue.id"),
      parsePageInfo(labels["pageInfo"], "issue.labels.pageInfo"),
    );
    return rest.some((name) => name.toLowerCase() === wanted);
  }

  async function parseIssue(
    token: string,
    value: unknown,
    pausedStates: readonly string[],
    ignoreLabel: string | null,
  ): Promise<Issue> {
    const node = obj(value, "issue");
    const state = obj(node["state"], "issue.state");
    const stateType = str(state, "type", "issue.state.type");
    if (!STATE_TYPES.has(stateType)) {
      throw invalid("issue.state.type");
    }
    const attachments = obj(node["attachments"], "issue.attachments");
    const first = parseAttachmentNodes(attachments["nodes"], "issue.attachments.nodes");
    const rest = await remainingAttachments(
      token,
      str(node, "id", "issue.id"),
      parsePageInfo(attachments["pageInfo"], "issue.attachments.pageInfo"),
    );
    const stateName = str(state, "name", "issue.state.name");
    const ignored = await isIgnored(token, node, ignoreLabel);
    return {
      id: str(node, "identifier", "issue.identifier"),
      title: str(node, "title", "issue.title"),
      url: str(node, "url", "issue.url"),
      state: stateName,
      started: stateType === "started",
      paused: pausedStates.includes(stateName),
      assigneeIsMe: true,
      attachmentUrls: [...first, ...rest],
      ignored,
    };
  }

  async function collectIssues(
    token: string,
    teamKey: string,
    pausedStates: readonly string[],
    ignoreLabel: string | null,
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    const seen = new Set<string>();
    const query = issuesQuery(ignoreLabel !== null);
    let after: string | null = null;
    for (;;) {
      const data = await post(token, query, {
        first: config.pageSize,
        after,
        teamKey,
        attachmentsFirst: config.pageSize,
        ...(ignoreLabel === null ? {} : { labelsFirst: config.pageSize }),
      });
      const connection = obj(data["issues"], "issues");
      for (const node of arr(connection["nodes"], "issues.nodes")) {
        issues.push(await parseIssue(token, node, pausedStates, ignoreLabel));
      }
      const page = parsePageInfo(connection["pageInfo"], "issues.pageInfo");
      if (!page.hasNextPage) {
        return issues;
      }
      if (page.endCursor === null || seen.has(page.endCursor)) {
        throw new LinearFailure("truncated", "Linear issues cannot be paginated further");
      }
      seen.add(page.endCursor);
      after = page.endCursor;
    }
  }

  /** Issue numbers of `team` among `keys`, each with every spelling that was asked for. */
  function teamNumbers(team: string, keys: readonly string[]): Map<number, Set<string>> {
    const numbers = new Map<number, Set<string>>();
    for (const key of keys) {
      const match = ISSUE_KEY.exec(key);
      if (match !== null && match[1]?.toUpperCase() === team.toUpperCase()) {
        const number = Number(match[2]);
        numbers.set(number, (numbers.get(number) ?? new Set<string>()).add(key));
      }
    }
    return numbers;
  }

  async function collectIgnoredKeys(
    token: string,
    team: string,
    ignoreLabel: string,
    keys: readonly string[],
  ): Promise<Set<string>> {
    const numbers = teamNumbers(team, keys);
    const requested = [...numbers.keys()];
    const ignored = new Set<string>();
    for (let start = 0; start < requested.length; start += config.pageSize) {
      const batch = requested.slice(start, start + config.pageSize);
      const data = await post(token, IGNORED_ISSUES_QUERY, {
        first: batch.length,
        teamKey: team,
        numbers: batch,
        labelsFirst: config.pageSize,
      });
      const connection = obj(data["issues"], "issues");
      if (parsePageInfo(connection["pageInfo"], "issues.pageInfo").hasNextPage) {
        throw new LinearFailure("truncated", "Linear returned more issues than were asked for");
      }
      for (const node of arr(connection["nodes"], "issues.nodes")) {
        const issue = obj(node, "issue");
        const match = ISSUE_KEY.exec(str(issue, "identifier", "issue.identifier"));
        const spellings = match === null ? undefined : numbers.get(Number(match[2]));
        if (spellings !== undefined && (await isIgnored(token, issue, ignoreLabel))) {
          for (const spelling of spellings) ignored.add(spelling);
        }
      }
    }
    return ignored;
  }

  async function collectIgnoredUrls(
    token: string,
    team: string,
    ignoreLabel: string,
    urls: readonly string[],
  ): Promise<Set<string>> {
    const ignored = new Set<string>();
    const wanted = new Set(urls);
    for (let start = 0; start < urls.length; start += config.pageSize) {
      const batch = urls.slice(start, start + config.pageSize);
      const data = await post(token, IGNORED_ATTACHMENT_ISSUES_QUERY, {
        first: config.pageSize,
        teamKey: team,
        urls: batch,
        attachmentsFirst: config.pageSize,
        labelsFirst: config.pageSize,
      });
      const connection = obj(data["issues"], "issues");
      if (parsePageInfo(connection["pageInfo"], "issues.pageInfo").hasNextPage) {
        throw new LinearFailure("truncated", "Linear returned more issues than one page for the attachment URLs");
      }
      for (const node of arr(connection["nodes"], "issues.nodes")) {
        const issue = obj(node, "issue");
        const attachments = obj(issue["attachments"], "issue.attachments");
        const attached = [
          ...parseAttachmentNodes(attachments["nodes"], "issue.attachments.nodes"),
          ...(await remainingAttachments(
            token,
            str(issue, "id", "issue.id"),
            parsePageInfo(attachments["pageInfo"], "issue.attachments.pageInfo"),
          )),
        ].filter((url) => wanted.has(url));
        if (attached.length > 0 && (await isIgnored(token, issue, ignoreLabel))) {
          for (const url of attached) ignored.add(url);
        }
      }
    }
    return ignored;
  }

  async function withToken<T>(
    run: (token: string) => Promise<T>,
  ): Promise<{ ok: true; data: T; durationMs: number } | SourceResult<never>> {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    const fail = (code: SourceErrorCode, message: string): SourceResult<never> => ({
      ok: false,
      source: "linear",
      code,
      message,
      durationMs: elapsed(),
    });
    const keyringDeps = deps.exec === undefined ? {} : { exec: deps.exec };
    const secret = await readKeyringSecret(config, keyringDeps);
    if (!secret.ok) {
      return fail("unauthenticated", `Linear token unavailable: keyring ${secret.kind} (${secret.message})`);
    }
    if (!HEADER_SAFE.test(secret.secret)) {
      return fail("unauthenticated", "Linear token from keyring is not a valid API key");
    }
    try {
      return { ok: true, data: await run(secret.secret), durationMs: elapsed() };
    } catch (error) {
      if (error instanceof LinearFailure) {
        return fail(error.code, error.message);
      }
      throw error;
    }
  }

  return {
    async fetchIgnoredKeys(project, keys, pullRequestUrls) {
      const ignoreLabel = project.ignoreLabel;
      if (ignoreLabel === null) {
        return { ok: true, source: "linear", data: new Set<string>(), durationMs: 0 };
      }
      const team = project.issueSource.team;
      const result = await withToken(async (token) => {
        const byKey = await collectIgnoredKeys(token, team, ignoreLabel, keys);
        const byUrl = await collectIgnoredUrls(token, team, ignoreLabel, [...new Set(pullRequestUrls)]);
        return new Set([...byKey, ...byUrl]);
      });
      return result.ok ? { ok: true, source: "linear", data: result.data, durationMs: result.durationMs } : result;
    },
    async fetchIssues(project) {
      const { team, pausedStates } = project.issueSource;
      const result = await withToken((token) => collectIssues(token, team, pausedStates, project.ignoreLabel));
      return result.ok ? { ok: true, source: "linear", data: result.data, durationMs: result.durationMs } : result;
    },
  };
}
