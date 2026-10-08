// Targeted ignore-label lookup for the candidate issues of an authored pull request: the issue it
// joined to, the issue its branch names, every closing reference (GitHub) and every issue it is
// attached to (Linear). Linear lists only started issues assigned to the owner and GitHub only open
// issues assigned to the owner with a started or paused label, so a parked issue (moved to Backlog,
// or stripped of its started label) is absent from the list while its pull request is still open.

import { isGithubProject, isLinearProject, issueSourceStatusKey } from "./config/issue-source.ts";
import { githubIssueKey, keyFromBranch } from "./join.ts";
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

const DECIMAL = /^[0-9]+$/;

/** What one row asks the issue source: issue keys and, for a Linear row, its pull request URL. */
interface Candidates {
  readonly keys: readonly string[];
  readonly url: string | null;
}

/** Key of the issue the branch names; a GitHub project accepts only a positive decimal issue number. */
function branchKey(project: ProjectConfig, headRefName: string): string | null {
  const captured = keyFromBranch(project.branchPattern, headRefName);
  if (captured === null || !isGithubProject(project)) return captured;
  if (!DECIMAL.test(captured)) return null;
  const number = Number(captured);
  return Number.isSafeInteger(number) && number > 0 ? githubIssueKey(project, number) : null;
}

/**
 * Candidates of an authored pull request that is not ignored itself and whose listed issue, if
 * any, is not ignored; null for every other row. A row with a listed issue asks only for the
 * candidates besides that issue and never for the URL, its attachments are known. A Linear row
 * without a listed issue also asks for its URL: any issue the pull request is attached to counts.
 */
function candidatesOf(project: ProjectConfig, item: WorkItem): Candidates | null {
  const pr = item.pullRequest;
  if (pr === null || pr.relation !== "authored" || pr.ignored) return null;
  if ((item.issue?.ignored ?? false) || (item.resolvedIssue?.ignored ?? false)) return null;
  const listed = (item.issue ?? item.resolvedIssue) !== null;
  const closing = isGithubProject(project) ? pr.closingIssueNumbers.map((number) => githubIssueKey(project, number)) : [];
  const own = listed ? item.issueKey : null;
  const keys = [item.issueKey, branchKey(project, pr.headRefName), ...closing].filter(
    (key): key is string => key !== null && key !== own,
  );
  const url = isLinearProject(project) && !listed ? pr.url : null;
  return keys.length === 0 && url === null ? null : { keys: [...new Set(keys)], url };
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
 * Sets `issueLookup` on the rows that need it: the row is ignored when any of its candidates
 * carries the label. Nothing is asked unless the project has an ignore label, the issue source and
 * `github` answered and a row has a candidate to ask for; with a failed source those rows are
 * already unknown (rule 12 and the ignore-label check). A failed lookup marks every asked row,
 * also one whose issue the list returned.
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
  const candidates = items.map((item) => candidatesOf(project, item));
  const keys = [...new Set(candidates.flatMap((candidate) => candidate?.keys ?? []))];
  const urls = [...new Set(candidates.flatMap((candidate) => (candidate?.url == null ? [] : [candidate.url])))];
  if (keys.length === 0 && urls.length === 0) return { items, failure: null };
  const result = await askSource(project, keys, urls, deps);
  if (!result.ok) {
    const reason = `${result.source}:${result.code}`;
    return {
      items: items.map((item, index) => (candidates[index] === null ? item : { ...item, issueLookup: { ok: false, reason } })),
      failure: reason,
    };
  }
  return {
    items: items.map((item, index) => {
      const asked = candidates[index];
      if (asked == null) return item;
      const ignored = asked.keys.some((key) => result.data.has(key)) || (asked.url !== null && result.data.has(asked.url));
      return { ...item, issueLookup: { ok: true, ignored } };
    }),
    failure: null,
  };
}
