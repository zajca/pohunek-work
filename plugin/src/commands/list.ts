// `pohunek-work list`: fetch every source once per project, join, evaluate
// the rules and render. Read-only: no pohunek mutation, no provider write.
import { isGithubProject, isLinearProject, issueSourceStatusKey } from "../config/issue-source.ts";
import { lookupUnlistedIssues } from "../issue-lookup.ts";
import { joinItems } from "../join.ts";
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
  type SourceStatus,
  type SourceStatuses,
  type UnlinkedSession,
  type WorkItem,
} from "../types/item.ts";
import type {
  Issue,
  MergedPullRequest,
  PohunekNotification,
  PohunekProject,
  PohunekSession,
  PullRequest,
  SourceResult,
} from "../types/sources.ts";
import type { Logger } from "../log.ts";
import { isLiveSession, parseOriginRepo, type PohunekClient } from "../sources/pohunek.ts";
import type { GithubSource } from "../sources/github.ts";
import type { LinearSource } from "../sources/linear.ts";

export interface ListOptions {
  readonly mine: boolean;
  /** Leaves out pull requests not updated for this many days that nothing runs for; null keeps all. */
  readonly staleDays: number | null;
  readonly json: boolean;
  /** Pohunek project label to restrict the listing to; null for every project. */
  readonly project: string | null;
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
  only: string | null,
): { projects: ProjectConfig[]; warnings: string[] } {
  const warnings: string[] = [];
  const projects: ProjectConfig[] = [];
  for (const project of config.projects) {
    if (only !== null && project.pohunekLabel !== only) continue;
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
}

/** Fetches every source once per selected project, joins and evaluates the rules. */
export async function collectRows(
  config: PluginConfig,
  onlyProject: string | null,
  deps: Omit<ListDeps, "cliVersion">,
): Promise<Collected> {
  const { logger } = deps;
  const global: GlobalConfig = config.global;
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

  const { projects, warnings } = selectProjects(config, registry, onlyProject);
  for (const warning of warnings) logger.info("project_skipped", { warning });
  if (onlyProject !== null && projects.length === 0 && warnings.length === 0) {
    warnings.push(`project ${onlyProject}: no configuration file for this label`);
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
    projectStatuses.push({ project: project.pohunekLabel, sources });
    if (sources.github !== "ok") sourceFailures.push(`${project.pohunekLabel} github: ${sources.github}`);
    if (sources.github_merged !== "ok") sourceFailures.push(`${project.pohunekLabel} github_merged: ${sources.github_merged}`);
    if (isSourceFailure(sources[issueSource])) sourceFailures.push(`${project.pohunekLabel} ${issueSource}: ${sources[issueSource]}`);
    const pullRequests: readonly PullRequest[] = github.ok ? github.data : [];
    const mergedPullRequests: readonly MergedPullRequest[] = merged.ok ? merged.data : [];
    const issues: readonly Issue[] = issueResult.ok ? issueResult.data : [];
    const joined = joinItems({ project, issues, pullRequests, mergedPullRequests, sessions, notifications, sources });
    const looked = await lookupUnlistedIssues(project, joined.items, sources, deps);
    if (looked.failure !== null) sourceFailures.push(`${project.pohunekLabel} ${issueSource} lookup: ${looked.failure}`);
    for (const item of looked.items) {
      rows.push({ item, project, listItem: buildListItem(item, { sources, identity: global.identity, project, profiles: global.profiles, sessions }) });
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
  return { rows, orphans, unlinked, projectStatuses, warnings, sourceFailures, sessions };
}

export async function runList(
  config: PluginConfig,
  options: ListOptions,
  deps: ListDeps,
): Promise<ListOutput> {
  const { logger } = deps;
  const collected = await collectRows(config, options.project, deps);
  const { orphans, unlinked, projectStatuses, warnings, sourceFailures, sessions } = collected;
  const items = collected.rows.map((row) => row.listItem);

  const mineRows = options.mine ? filterMine(items) : items;
  const cutoff = options.staleDays === null ? null : staleCutoff((deps.now ?? Date.now)(), options.staleDays);
  const shown = cutoff === null ? mineRows : mineRows.filter((item) => !isStalePullRequest(item, cutoff));
  logger.info("list_done", { rows: items.length, shown: shown.length, mine: options.mine, stale_days: options.staleDays });
  const stdout = options.json
    ? JSON.stringify(buildListEnvelope(
          deps.cliVersion,
          shown,
          options.mine ? [] : orphans,
          options.mine ? [] : unlinked,
          projectStatuses,
        ), null, 2)
    : renderTable(
        shown,
        options.mine ? [] : orphans,
        options.mine ? [] : unlinked,
        new Set(sessions.filter(isLiveSession).map((s) => s.id)));
  return { stdout, warnings, items: shown, sourceFailures };
}
