// Targeted ignore-label lookup for the issues a pull request joined to, or for a Linear project is
// attached to, but the issue source did not list. Linear lists only started issues assigned to the owner and GitHub only open issues
// assigned to the owner with a started or paused label, so a parked issue (moved to Backlog, or
// stripped of its started label) is absent from the list while its pull request is still open.

import { isGithubProject, isLinearProject, issueSourceStatusKey } from "./config/issue-source.ts";
import type { GithubSource } from "./sources/github.ts";
import type { LinearSource } from "./sources/linear.ts";
import type { ProjectConfig } from "./types/config.ts";
import { isSourceFailure, type SourceStatuses, type WorkItem } from "./types/item.ts";
import type { SourceResult } from "./types/sources.ts";

export interface IssueLookupDeps {
  readonly github: GithubSource;
  /** Absent when the configuration has no `[linear]` table, which only GitHub projects allow. */
  readonly linear: LinearSource | null;
}

export interface IssueLookupOutcome {
  readonly items: readonly WorkItem[];
  /** Source and code of a failed lookup; null when none ran or all succeeded. */
  readonly failure: string | null;
}

/** An authored pull request that is not ignored itself; only such rows can be parked by their issue. */
function parkable(item: WorkItem): boolean {
  const pr = item.pullRequest;
  return pr !== null && pr.relation === "authored" && !pr.ignored && item.issue === null && item.resolvedIssue === null;
}

/** Rows that joined to an issue key the issue source did not list. */
function needsKeyLookup(item: WorkItem): boolean {
  return parkable(item) && item.issueKey !== null;
}

/**
 * Rows of a Linear project that resolved to no key while the issue source answered: the pull
 * request may still carry a Linear attachment of an issue the list did not return.
 */
function needsUrlLookup(project: ProjectConfig, item: WorkItem): boolean {
  return isLinearProject(project) && parkable(item) && item.issueKey === null && item.noIssue;
}

async function askSource(
  project: ProjectConfig,
  keys: readonly string[],
  urls: readonly string[],
  deps: IssueLookupDeps,
): Promise<SourceResult<ReadonlySet<string>>> {
  if (isGithubProject(project)) return deps.github.fetchIgnoredKeys(project, keys);
  if (!isLinearProject(project)) throw new Error(`project ${project.pohunekLabel} has an unknown issue source`);
  if (deps.linear === null) throw new Error(`project ${project.pohunekLabel} uses Linear but no Linear source is configured`);
  return deps.linear.fetchIgnoredKeys(project, keys, urls);
}

/**
 * Sets `issueLookup` on the rows that need it. Nothing is asked unless the project has an ignore
 * label, the issue source and `github` answered and a row joined to an unlisted issue key or, for
 * Linear, may be attached to one;
 * with a failed source those rows are already unknown (rule 12 and the ignore-label check).
 */
export async function lookupUnlistedIssues(
  project: ProjectConfig,
  items: readonly WorkItem[],
  sources: SourceStatuses,
  deps: IssueLookupDeps,
): Promise<IssueLookupOutcome> {
  if (project.ignoreLabel === null) return { items, failure: null };
  if (isSourceFailure(sources[issueSourceStatusKey(project)]) || isSourceFailure(sources.github)) {
    return { items, failure: null };
  }
  const keys = [...new Set(items.filter(needsKeyLookup).flatMap((item) => (item.issueKey === null ? [] : [item.issueKey])))];
  const urls = [...new Set(items.filter((item) => needsUrlLookup(project, item)).flatMap((item) => (item.pullRequest === null ? [] : [item.pullRequest.url])))];
  if (keys.length === 0 && urls.length === 0) return { items, failure: null };
  const result = await askSource(project, keys, urls, deps);
  const subject = (item: WorkItem): string | null => {
    if (needsKeyLookup(item)) return item.issueKey;
    return needsUrlLookup(project, item) ? (item.pullRequest?.url ?? null) : null;
  };
  if (!result.ok) {
    const reason = `${result.source}:${result.code}`;
    return {
      items: items.map((item) => (subject(item) === null ? item : { ...item, issueLookup: { ok: false, reason } })),
      failure: reason,
    };
  }
  return {
    items: items.map((item) => {
      const asked = subject(item);
      return asked === null ? item : { ...item, issueLookup: { ok: true, ignored: result.data.has(asked) } };
    }),
    failure: null,
  };
}
