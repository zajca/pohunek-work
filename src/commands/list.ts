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
import type { ListItem, OrphanedSession, SourceStatus, SourceStatuses } from "../types/item.ts";
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

export async function runList(
  config: PluginConfig,
  options: ListOptions,
  deps: ListDeps,
): Promise<ListOutput> {
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

  const pohunek = pohunekStatus(sessionsResult, notificationsResult);
  const sessions: readonly PohunekSession[] = sessionsResult.ok ? sessionsResult.data : [];
  const notifications: readonly PohunekNotification[] = notificationsResult.ok ? notificationsResult.data : [];

  const { projects, warnings } = selectProjects(config, registry, options.project);
  for (const warning of warnings) logger.info("project_skipped", { warning });
  if (options.project !== null && projects.length === 0 && warnings.length === 0) {
    warnings.push(`project ${options.project}: no configuration file for this label`);
  }

  const items: ListItem[] = [];
  const orphans: OrphanedSession[] = [];
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
    const pullRequests: readonly PullRequest[] = github.ok ? github.data : [];
    const issues: readonly LinearIssue[] = linear.ok ? linear.data : [];
    const joined = joinItems({ project, issues, pullRequests, sessions, notifications, sources });
    for (const item of joined.items) {
      items.push(buildListItem(item, { sources, identity: global.identity, project }));
    }
    orphans.push(...joined.orphanedSessions);
  }

  const shown = options.mine ? filterMine(items) : items;
  logger.info("list_done", { rows: items.length, shown: shown.length, mine: options.mine });
  const stdout = options.json
    ? JSON.stringify(buildListEnvelope(deps.cliVersion, shown, options.mine ? [] : orphans), null, 2)
    : renderTable(shown, options.mine ? [] : orphans, new Set(sessions.filter(isLiveSession).map((s) => s.id)));
  return { stdout, warnings, items: shown };
}
