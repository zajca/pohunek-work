// Routes the provider reads of a GitHub or Linear source through the shared cache. The key of each
// read holds every input the provider answer depends on (endpoint, page sizes, identity, project and
// the arguments), so two projects or two identities never share a result. The access token is never
// part of a key or of a cache file.

import type { CacheRequest, SharedCache } from "../cache/shared-cache.ts";
import type { GithubConfig, IdentityConfig, LinearConfig, GithubProject, LinearProject } from "../types/config.ts";
import type {
  CredentialResult,
  Issue,
  MergedPullRequest,
  PullRequest,
  SourceFailure,
  SourceResult,
  SourceSuccess,
} from "../types/sources.ts";
import type { GithubSource } from "./github.ts";
import type { LinearSource } from "./linear.ts";

export interface CachedSourceOptions {
  readonly cache: SharedCache;
  /** Clock of the merged lookback window; the system clock when absent. */
  readonly now?: () => number;
}

const GITHUB_PROVIDER = "github";
const LINEAR_PROVIDER = "linear";

type AccountResult = SourceSuccess<string> | SourceFailure;

/**
 * The account a read belongs to, as an offline identity of the credential the source reads locally. It is read on
 * every call: a long-running `watch` must see a token that changed, and the read does not ask the provider, so
 * an outage or a rate limit does not stop a read from finding its cached result.
 */
function accountOf(credential: () => Promise<CredentialResult>, cache: SharedCache): () => Promise<AccountResult> {
  return async () => {
    const read = await credential();
    if (!read.ok) return read;
    return { ok: true, source: read.source, data: await cache.identityOf(read.data), durationMs: 0 };
  };
}

function listCodec<T>(): Pick<CacheRequest<readonly T[]>, "encode" | "decode"> {
  return {
    encode: (data) => data,
    decode: (raw) => (Array.isArray(raw) ? (raw as T[]) : null),
  };
}

function keySetCodec(): Pick<CacheRequest<ReadonlySet<string>>, "encode" | "decode"> {
  return {
    encode: (data) => [...data],
    decode: (raw) => (Array.isArray(raw) && raw.every((key) => typeof key === "string") ? new Set<string>(raw) : null),
  };
}

export function cachedGithubSource(
  source: GithubSource,
  config: { readonly github: GithubConfig; readonly identity: IdentityConfig },
  options: CachedSourceOptions,
): GithubSource {
  const now = options.now ?? Date.now;
  const { cache } = options;
  const account = accountOf(() => source.credential(), cache);
  const settings = {
    endpoint: config.github.endpoint,
    pageSizes: [
      config.github.pullRequestPageSize,
      config.github.issuePageSize,
      config.github.nestedPageSize,
      config.github.threadCommentPageSize,
    ],
    mergedLookbackDays: config.github.mergedLookbackDays,
    identity: config.identity,
  };

  return {
    credential: () => source.credential(),

    async fetchPullRequests(project) {
      const id = await account();
      if (!id.ok) return id;
      return cache.read<readonly PullRequest[]>({
        provider: GITHUB_PROVIDER,
        source: "github",
        key: JSON.stringify(["pull_requests", settings, id.data, project]),
        fetch: () => source.fetchPullRequests(project),
        ...listCodec<PullRequest>(),
      });
    },

    // The lookback window starts at a day boundary, so the UTC day of the read is part of the key.
    async fetchMergedPullRequests(project) {
      const id = await account();
      if (!id.ok) return id;
      return cache.read<readonly MergedPullRequest[]>({
        provider: GITHUB_PROVIDER,
        source: "github",
        key: JSON.stringify(["merged_pull_requests", settings, id.data, project, new Date(now()).toISOString().slice(0, 10)]),
        fetch: () => source.fetchMergedPullRequests(project),
        ...listCodec<MergedPullRequest>(),
      });
    },

    async fetchIssues(project: GithubProject) {
      const id = await account();
      if (!id.ok) return id;
      return cache.read<readonly Issue[]>({
        provider: GITHUB_PROVIDER,
        source: "github_issues",
        key: JSON.stringify(["issues", settings, id.data, project]),
        fetch: () => source.fetchIssues(project),
        ...listCodec<Issue>(),
      });
    },

    async fetchIgnoredKeys(project: GithubProject, keys: readonly string[]) {
      const id = await account();
      if (!id.ok) return id;
      return cache.read<ReadonlySet<string>>({
        provider: GITHUB_PROVIDER,
        source: "github_issues",
        key: JSON.stringify(["ignored_keys", settings, id.data, project, [...keys].sort()]),
        fetch: () => source.fetchIgnoredKeys(project, keys),
        ...keySetCodec(),
      });
    },

    // Read only when `implement` plans an issue, and then it must show the current body.
    fetchIssueDetail: (project, number) => source.fetchIssueDetail(project, number),
  };
}

export function cachedLinearSource(
  source: LinearSource,
  config: LinearConfig,
  options: CachedSourceOptions,
): LinearSource {
  const { cache } = options;
  const settings = { endpoint: config.endpoint, pageSize: config.pageSize };
  const account = accountOf(() => source.credential(), cache);

  return {
    credential: () => source.credential(),

    async fetchIssues(project: LinearProject): Promise<SourceResult<readonly Issue[]>> {
      const id = await account();
      if (!id.ok) return id;
      return cache.read<readonly Issue[]>({
        provider: LINEAR_PROVIDER,
        source: "linear",
        key: JSON.stringify(["issues", settings, id.data, project]),
        fetch: () => source.fetchIssues(project),
        ...listCodec<Issue>(),
      });
    },

    async fetchIgnoredKeys(project, keys, pullRequestUrls) {
      const id = await account();
      if (!id.ok) return id;
      return cache.read<ReadonlySet<string>>({
        provider: LINEAR_PROVIDER,
        source: "linear",
        key: JSON.stringify(["ignored_keys", settings, id.data, project, [...keys].sort(), [...pullRequestUrls].sort()]),
        fetch: () => source.fetchIgnoredKeys(project, keys, pullRequestUrls),
        ...keySetCodec(),
      });
    },
  };
}
