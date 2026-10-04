// Linear source: started issues assigned to the token owner for one team.
// The API key is sent as the raw Authorization value (personal API key form).

import type { LinearConfig, LinearProject } from "../types/config.ts";
import type { Issue, SourceErrorCode, SourceResult } from "../types/sources.ts";
import type { Exec } from "../util/exec.ts";
import { readKeyringSecret } from "./keyring.ts";

export interface LinearSource {
  fetchIssues(project: LinearProject): Promise<SourceResult<readonly Issue[]>>;
}

export interface LinearDeps {
  readonly exec?: Exec;
  readonly fetch?: typeof fetch;
}

const ISSUES_QUERY = `
query WorkIssues($first: Int!, $after: String, $teamKey: String!, $attachmentsFirst: Int!) {
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
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ATTACHMENTS_QUERY = `
query WorkIssueAttachments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    attachments(first: $first, after: $after) {
      nodes { url }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

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

  async function parseIssue(
    token: string,
    value: unknown,
    pausedStates: readonly string[],
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
    return {
      id: str(node, "identifier", "issue.identifier"),
      title: str(node, "title", "issue.title"),
      url: str(node, "url", "issue.url"),
      state: stateName,
      started: stateType === "started",
      paused: pausedStates.includes(stateName),
      assigneeIsMe: true,
      attachmentUrls: [...first, ...rest],
    };
  }

  async function collectIssues(
    token: string,
    teamKey: string,
    pausedStates: readonly string[],
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const data = await post(token, ISSUES_QUERY, {
        first: config.pageSize,
        after,
        teamKey,
        attachmentsFirst: config.pageSize,
      });
      const connection = obj(data["issues"], "issues");
      for (const node of arr(connection["nodes"], "issues.nodes")) {
        issues.push(await parseIssue(token, node, pausedStates));
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

  return {
    async fetchIssues(project) {
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
        const data = await collectIssues(secret.secret, project.issueSource.team, project.issueSource.pausedStates);
        return { ok: true, source: "linear", data, durationMs: elapsed() };
      } catch (error) {
        if (error instanceof LinearFailure) {
          return fail(error.code, error.message);
        }
        throw error;
      }
    },
  };
}
