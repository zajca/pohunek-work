// Routes the provider reads of a GitHub or Linear source through the shared cache. The key of each
// read holds every input the provider answer depends on (endpoint, page sizes, identity, project and
// the arguments), so two projects or two identities never share a result. The access token is never
// part of a key or of a cache file.

import type { CacheRequest, SharedCache } from "../cache/shared-cache.ts";
import type { GithubConfig, IdentityConfig, LinearConfig, GithubProject, LinearProject } from "../types/config.ts";
import type { Issue, MergedPullRequest, PullRequest, SourceResult } from "../types/sources.ts";
import type { GithubSource } from "./github.ts";
import type { LinearSource } from "./linear.ts";

export interface CachedSourceOptions {
  readonly cache: SharedCache;
  /** Clock of the merged lookback window; the system clock when absent. */
  readonly now?: () => number;
}

const GITHUB_PROVIDER = "github";
const LINEAR_PROVIDER = "linear";

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
    fetchPullRequests: (project) =>
      cache.read<readonly PullRequest[]>({
        provider: GITHUB_PROVIDER,
        source: "github",
        key: JSON.stringify(["pull_requests", settings, project]),
        fetch: () => source.fetchPullRequests(project),
        ...listCodec<PullRequest>(),
      }),

    // The lookback window starts at a day boundary, so the UTC day of the read is part of the key.
    fetchMergedPullRequests: (project) =>
      cache.read<readonly MergedPullRequest[]>({
        provider: GITHUB_PROVIDER,
        source: "github",
        key: JSON.stringify(["merged_pull_requests", settings, project, new Date(now()).toISOString().slice(0, 10)]),
        fetch: () => source.fetchMergedPullRequests(project),
        ...listCodec<MergedPullRequest>(),
      }),

    fetchIssues: (project: GithubProject) =>
      cache.read<readonly Issue[]>({
        provider: GITHUB_PROVIDER,
        source: "github_issues",
        key: JSON.stringify(["issues", settings, project]),
        fetch: () => source.fetchIssues(project),
        ...listCodec<Issue>(),
      }),

    fetchIgnoredKeys: (project: GithubProject, keys: readonly string[]) =>
      cache.read<ReadonlySet<string>>({
        provider: GITHUB_PROVIDER,
        source: "github_issues",
        key: JSON.stringify(["ignored_keys", settings, project, [...keys].sort()]),
        fetch: () => source.fetchIgnoredKeys(project, keys),
        ...keySetCodec(),
      }),

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
  // The account is part of every key: the keyring entry keeps its name when the owner's token is replaced
  // by another account's, and the issue queries answer for whichever account the token belongs to.
  // One lookup per source object, so a run reads the viewer once per process.
  let viewer: ReturnType<LinearSource["viewerId"]> | null = null;
  const viewerId = (): ReturnType<LinearSource["viewerId"]> => {
    viewer ??= source.viewerId();
    return viewer;
  };

  return {
    viewerId,

    async fetchIssues(project: LinearProject): Promise<SourceResult<readonly Issue[]>> {
      const account = await viewerId();
      if (!account.ok) return account;
      return cache.read<readonly Issue[]>({
        provider: LINEAR_PROVIDER,
        source: "linear",
        key: JSON.stringify(["issues", settings, account.data, project]),
        fetch: () => source.fetchIssues(project),
        ...listCodec<Issue>(),
      });
    },

    async fetchIgnoredKeys(project, keys, pullRequestUrls) {
      const account = await viewerId();
      if (!account.ok) return account;
      return cache.read<ReadonlySet<string>>({
        provider: LINEAR_PROVIDER,
        source: "linear",
        key: JSON.stringify(["ignored_keys", settings, account.data, project, [...keys].sort(), [...pullRequestUrls].sort()]),
        fetch: () => source.fetchIgnoredKeys(project, keys, pullRequestUrls),
        ...keySetCodec(),
      });
    },
  };
}
