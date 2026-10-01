// `pohunek-work list`: fetch every source once per project, join, evaluate
// the rules and render. Read-only: no pohunek mutation, no provider write.
import { joinItems } from "../join.ts";
import {
  buildListEnvelope,
  buildListItem,
  filterMine,
  renderTable,
} from "../output/list.ts";
import type { GlobalConfig, PluginConfig, ProjectConfig } from "../types/config.ts";
import type {
  ListItem,
  ListProjectStatus,
  OrphanedSession,
  SourceStatus,
  SourceStatuses,
  UnlinkedSession,
  WorkItem,
} from "../types/item.ts";
import type {
  LinearIssue,
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
  readonly json: boolean;
  /** Pohunek project label to restrict the listing to; null for every project. */
  readonly project: string | null;
}

export interface ListDeps {
  readonly pohunek: PohunekClient;
  readonly github: GithubSource;
  readonly linear: LinearSource;
  readonly logger: Logger;
  readonly cliVersion: string;
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
      const [github, linear] = await Promise.all([
        deps.github.fetchPullRequests(project),
        deps.linear.fetchIssues(project),
      ]);
      logger.sourceResult(github);
      logger.sourceResult(linear);
      return { project, github, linear };
    }),
  );

  for (const { project, github, linear } of perProject) {
    const sources: SourceStatuses = {
      github: statusOf(github),
      linear: statusOf(linear),
      pohunek,
    };
    projectStatuses.push({ project: project.pohunekLabel, sources });
    if (sources.github !== "ok") sourceFailures.push(`${project.pohunekLabel} github: ${sources.github}`);
    if (sources.linear !== "ok") sourceFailures.push(`${project.pohunekLabel} linear: ${sources.linear}`);
    const pullRequests: readonly PullRequest[] = github.ok ? github.data : [];
    const issues: readonly LinearIssue[] = linear.ok ? linear.data : [];
    const joined = joinItems({ project, issues, pullRequests, sessions, notifications, sources });
    for (const item of joined.items) {
      rows.push({ item, project, listItem: buildListItem(item, { sources, identity: global.identity, project }) });
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

  const shown = options.mine ? filterMine(items) : items;
  logger.info("list_done", { rows: items.length, shown: shown.length, mine: options.mine });
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
