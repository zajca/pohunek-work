// `pohunek-work list`: fetch every source once per project, join, evaluate
// the rules and render. Read-only: no pohunek mutation, no provider write.
import { isGithubProject, isLinearProject, issueSourceStatusKey } from "../config/issue-source.ts";
import { lookupUnlistedIssues } from "../issue-lookup.ts";
import { joinItems } from "../join.ts";
import { finishedCutoff } from "../output/finished.ts";
import { isStalePullRequest, staleCutoff } from "../output/stale.ts";
import {
  buildListEnvelope,
  buildListItem,
  filterMine,
  renderTable,
} from "../output/list.ts";
import type { GlobalConfig, PluginConfig, ProjectConfig } from "../types/config.ts";
import {
  isSourceFailure,
  type ListItem,
  type ListProjectStatus,
  type OrphanedSession,
  type SourceFreshness,
  type SourceStatus,
  type SourceStatuses,
  type UnlinkedSession,
  type WorkItem,
} from "../types/item.ts";
import {
  resultData,
  type Issue,
  type MergedPullRequest,
  type PohunekNotification,
  type PohunekProject,
  type PohunekSession,
  type PullRequest,
  type SourceResult,
} from "../types/sources.ts";
import type { Logger } from "../log.ts";
import { parseOriginRepo, type PohunekClient } from "../sources/pohunek.ts";
import type { GithubSource } from "../sources/github.ts";
import type { LinearSource } from "../sources/linear.ts";

export interface ListOptions {
  readonly mine: boolean;
  /** Leaves out pull requests not updated for this many days that nothing runs for; null keeps all. */
  readonly staleDays: number | null;
  /** With `mine`, also keeps rows whose agent work finished within this many hours; null keeps none. */
  readonly finishedHours: number | null;
  readonly json: boolean;
  /** Pohunek project labels to restrict the listing to, without duplicates; null for every project. */
  readonly projects: readonly string[] | null;
  /** Lists rows carrying the project's ignore label; they are hidden otherwise. */
  readonly includeIgnored: boolean;
}

export interface ListDeps {
  readonly pohunek: PohunekClient;
  readonly github: GithubSource;
  /** Absent when the configuration has no `[linear]` table, which only GitHub projects allow. */
  readonly linear: LinearSource | null;
  readonly logger: Logger;
  readonly cliVersion: string;
  /** Clock for `staleDays`; the system clock when absent. */
  readonly now?: () => number;
}

export interface ListOutput {
  /** Text for stdout. */
  readonly stdout: string;
  /** Diagnostics for stderr (projects left out, never guessed). */
  readonly warnings: readonly string[];
  readonly items: readonly ListItem[];
  /** One entry per source that did not return `ok`, regardless of the row filter. */
  readonly sourceFailures: readonly string[];
}

function statusOf(result: SourceResult<unknown>): SourceStatus {
  return result.ok ? "ok" : result.code;
}

/** The failure code, plus the age of the data shown instead and the instant of the next provider read when either is known. */
function describeSource(result: SourceResult<unknown>): string {
  if (result.ok) return "ok";
  const parts: string[] = [result.code];
  if ("stale" in result) parts.push(`showing data read at ${new Date(result.fetchedAtMs).toISOString()}`);
  if (result.retryAtMs !== undefined) parts.push(`provider not asked before ${new Date(result.retryAtMs).toISOString()}`);
  return parts.join("; ");
}

/** Issues come from the project's own issue source; the other issue source reports `unused`. */
async function fetchProjectIssues(
  project: ProjectConfig,
  deps: Pick<ListDeps, "github" | "linear">,
): Promise<SourceResult<readonly Issue[]>> {
  if (isGithubProject(project)) return deps.github.fetchIssues(project);
  if (!isLinearProject(project)) throw new Error(`project ${project.pohunekLabel} has an unknown issue source`);
  if (deps.linear === null) throw new Error(`project ${project.pohunekLabel} uses Linear but no Linear source is configured`);
  return deps.linear.fetchIssues(project);
}

/** When the data behind a cached source was read, whether it is shown stale, and when the provider is asked again. */
function freshnessOf(result: SourceResult<unknown>): SourceFreshness {
  return {
    fetched_at: result.fetchedAtMs === undefined ? null : new Date(result.fetchedAtMs).toISOString(),
    stale: "stale" in result,
    retry_at: result.retryAtMs === undefined ? null : new Date(result.retryAtMs).toISOString(),
  };
}

/** First failing pohunek call decides the pohunek status. */
function pohunekStatus(...results: readonly SourceResult<unknown>[]): SourceStatus {
  for (const result of results) {
    if (!result.ok) return result.code;
  }
  return "ok";
}

/**
 * A configured project is listed only when the pohunek registry has its label
 * and the registered origin resolves to the configured repository. With the
 * registry unavailable every configured project is listed (rows are `unknown`
 * through the pohunek source status anyway).
 */
export function selectProjects(
  config: PluginConfig,
  registry: SourceResult<readonly PohunekProject[]>,
  only: readonly string[] | null,
): { projects: ProjectConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  const projects: ProjectConfig[] = [];
  for (const project of config.projects) {
    if (only !== null && !only.includes(project.pohunekLabel)) continue;
    if (registry.ok) {
      const registered = registry.data.find((p) => p.label === project.pohunekLabel);
      if (registered === undefined) {
        warnings.push(`project ${project.pohunekLabel}: no pohunek project with this label; left out (run doctor)`);
        continue;
      }
      const repo = registered.originUrl === null ? null : parseOriginRepo(registered.originUrl);
      if (repo?.toLowerCase() !== project.repo.toLowerCase()) {
        warnings.push(`project ${project.pohunekLabel}: origin_url does not resolve to ${project.repo}; left out (run doctor)`);
        continue;
      }
    }
    projects.push(project);
  }
  return { projects, warnings };
}

/** One joined row with the context a later action needs. */
export interface CollectedRow {
  readonly item: WorkItem;
  readonly project: ProjectConfig;
  readonly listItem: ListItem;
}

export interface Collected {
  readonly rows: readonly CollectedRow[];
  readonly orphans: readonly OrphanedSession[];
  readonly unlinked: readonly UnlinkedSession[];
  readonly projectStatuses: readonly ListProjectStatus[];
  readonly warnings: string[];
  readonly sourceFailures: readonly string[];
  readonly sessions: readonly PohunekSession[];
  /** Instant the sources were read: the clock of `--stale-days` and of every age in the output. */
  readonly readAtMs: number;
}

/** Fetches every source once per selected project, joins and evaluates the rules. */
export async function collectRows(
  config: PluginConfig,
  onlyProjects: readonly string[] | null,
  deps: Omit<ListDeps, "cliVersion">,
): Promise<Collected> {
  const { logger } = deps;
  const global: GlobalConfig = config.global;
  const readAtMs = (deps.now ?? Date.now)();
  const [registry, sessionsResult, notificationsResult] = await Promise.all([
    deps.pohunek.listProjects(),
    deps.pohunek.listSessions(),
    deps.pohunek.listNotifications(),
  ]);
  logger.sourceResult(registry);
  logger.sourceResult(sessionsResult);
  logger.sourceResult(notificationsResult);

  const pohunek = pohunekStatus(registry, sessionsResult, notificationsResult);
  const sessions: readonly PohunekSession[] = sessionsResult.ok ? sessionsResult.data : [];
  const notifications: readonly PohunekNotification[] = notificationsResult.ok ? notificationsResult.data : [];

  const { projects, warnings } = selectProjects(config, registry, onlyProjects);
  for (const warning of warnings) logger.info("project_skipped", { warning });
  for (const label of onlyProjects ?? []) {
    if (!config.projects.some((project) => project.pohunekLabel === label)) {
      warnings.push(`project ${label}: no configuration file for this label`);
    }
  }

  const rows: CollectedRow[] = [];
  const orphans: OrphanedSession[] = [];
  const unlinked: UnlinkedSession[] = [];
  const projectStatuses: ListProjectStatus[] = [];
  const sourceFailures: string[] = [];
  if (pohunek !== "ok") sourceFailures.push(`pohunek: ${pohunek}`);
  const perProject = await Promise.all(
    projects.map(async (project) => {
      const [github, merged, issues] = await Promise.all([
        deps.github.fetchPullRequests(project),
        deps.github.fetchMergedPullRequests(project),
        fetchProjectIssues(project, deps),
      ]);
      logger.sourceResult(github);
      logger.sourceResult(merged);
      logger.sourceResult(issues);
      return { project, github, merged, issues };
    }),
  );

  for (const { project, github, merged, issues: issueResult } of perProject) {
    const issueSource = issueSourceStatusKey(project);
    const issueStatus = (key: typeof issueSource): SourceStatus => (key === issueSource ? statusOf(issueResult) : "unused");
    const sources: SourceStatuses = {
      github: statusOf(github),
      github_merged: statusOf(merged),
      linear: issueStatus("linear"),
      github_issues: issueStatus("github_issues"),
      pohunek,
    };
    const issueFreshness = freshnessOf(issueResult);
    const freshness: ListProjectStatus["freshness"] = {
      github: freshnessOf(github),
      github_merged: freshnessOf(merged),
      linear: issueSource === "linear" ? issueFreshness : null,
      github_issues: issueSource === "github_issues" ? issueFreshness : null,
      pohunek: null,
    };
    projectStatuses.push({ project: project.pohunekLabel, sources, freshness });
    if (sources.github !== "ok") sourceFailures.push(`${project.pohunekLabel} github: ${describeSource(github)}`);
    if (sources.github_merged !== "ok") sourceFailures.push(`${project.pohunekLabel} github_merged: ${describeSource(merged)}`);
    if (isSourceFailure(sources[issueSource])) sourceFailures.push(`${project.pohunekLabel} ${issueSource}: ${describeSource(issueResult)}`);
    // Stale data is shown with its source marked failed, so rules that need a fresh source leave those rows unknown.
    const pullRequests: readonly PullRequest[] = resultData(github) ?? [];
    const mergedPullRequests: readonly MergedPullRequest[] = resultData(merged) ?? [];
    const issues: readonly Issue[] = resultData(issueResult) ?? [];
    const joined = joinItems({ project, issues, pullRequests, mergedPullRequests, sessions, notifications, sources });
    const looked = await lookupUnlistedIssues(project, joined.items, sources, deps);
    if (looked.failure !== null) sourceFailures.push(`${project.pohunekLabel} ${issueSource} lookup: ${looked.failure}`);
    for (const item of looked.items) {
      rows.push({ item, project, listItem: buildListItem(item, { sources, identity: global.identity, project, profiles: global.profiles, sessions, nowMs: readAtMs }) });
    }
    orphans.push(...joined.orphanedSessions);
    unlinked.push(
      ...joined.unlinkedSessions.map((session) => ({
        id: session.id,
        name: session.name,
        project: project.pohunekLabel,
        state: session.state,
        activity: session.activity,
      })),
    );
  }
  for (const failure of sourceFailures) logger.error("source_failed", { failure });
  return { rows, orphans, unlinked, projectStatuses, warnings, sourceFailures, sessions, readAtMs };
}

export async function runList(
  config: PluginConfig,
  options: ListOptions,
  deps: ListDeps,
): Promise<ListOutput> {
  const { logger } = deps;
  const collected = await collectRows(config, options.projects, deps);
  const { orphans, unlinked, projectStatuses, warnings, sourceFailures } = collected;
  const items = collected.rows.map((row) => row.listItem);

  const now = collected.readAtMs;
  const finishedCut = options.mine && options.finishedHours !== null ? finishedCutoff(now, options.finishedHours) : null;
  const mineRows = options.mine ? filterMine(items, finishedCut) : items;
  const cutoff = options.staleDays === null ? null : staleCutoff(now, options.staleDays);
  const filtered = cutoff === null ? mineRows : mineRows.filter((item) => !isStalePullRequest(item, cutoff));
  const omittedStale = mineRows.length - filtered.length;
  const shown = options.includeIgnored ? filtered : filtered.filter((item) => !item.ignored);
  const omittedIgnored = filtered.length - shown.length;
  logger.info("list_done", {
    rows: items.length,
    shown: shown.length,
    mine: options.mine,
    stale_days: options.staleDays,
    finished_hours: options.finishedHours,
    include_ignored: options.includeIgnored,
    omitted_stale: omittedStale,
    omitted_ignored: omittedIgnored,
  });
  const stdout = options.json
    ? JSON.stringify(buildListEnvelope(
          deps.cliVersion,
          shown,
          options.mine ? [] : orphans,
          options.mine ? [] : unlinked,
          projectStatuses,
          { omittedIgnored, omittedStale, readAtMs: now },
        ), null, 2)
    : renderTable(
        shown,
        options.mine ? [] : orphans,
        options.mine ? [] : unlinked,
        omittedIgnored,
        omittedStale);
  return { stdout, warnings, items: shown, sourceFailures };
}
