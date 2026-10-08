// `pohunek-work watch`: polls the list pipeline and sends one desktop
// notification for every row that becomes the owner's turn. The previous turn
// of each row is kept in memory only; a restart starts from a fresh baseline.
import { toAscii } from "../output/sanitize.ts";
import { rowId, transitionsToMe } from "../tui/rows.ts";
import type { NotifyConfig, PluginConfig } from "../types/config.ts";
import type { ListItem, TurnActor } from "../types/item.ts";
import { SpawnError, type Exec } from "../util/exec.ts";
import { collectRows, type ListDeps } from "./list.ts";

export interface WatchOptions {
  /** Pohunek project label to restrict the watch to; null for every project. */
  readonly project: string | null;
}

export interface WatchDeps extends Omit<ListDeps, "cliVersion" | "now"> {
  readonly exec: Exec;
  /** Resolves after the given milliseconds or when the signal aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Previous turn of every row; null until a poll saw every source answer. */
export type Baseline = ReadonlyMap<string, TurnActor> | null;

export interface TickResult {
  readonly baseline: Baseline;
  /** Row ids a notification was attempted for, in row order; stops at an abort. */
  readonly notified: readonly string[];
}

const APP_NAME = "pohunek-work";

/**
 * Key and reason only: issue and pull request titles are provider text and a
 * notification daemon may interpret markup in them.
 */
export function notificationArgv(notify: NotifyConfig, item: ListItem): readonly string[] {
  const summary = toAscii(`your turn: ${item.key}`);
  const body = toAscii(`${item.project}: ${item.on_turn.reason}`);
  return [notify.command, `--app-name=${APP_NAME}`, "--", summary, body];
}

/** Label of a project the watch is restricted to that no project file defines; null when it is known. */
export function unknownProject(config: PluginConfig, project: string | null): string | null {
  if (project === null) return null;
  return config.projects.some((p) => p.pohunekLabel === project) ? null : project;
}

async function notify(config: PluginConfig, item: ListItem, deps: WatchDeps): Promise<void> {
  const argv = notificationArgv(config.global.notify, item);
  const { logger } = deps;
  try {
    const result = await deps.exec(argv, { timeoutMs: config.global.notify.timeoutMs });
    if (result.timedOut || result.exitCode !== 0) {
      logger.error("watch_notify_failed", { key: item.key, exit_code: result.exitCode, timed_out: result.timedOut, stderr: result.stderr });
      return;
    }
    logger.info("watch_notified", { key: item.key, project: item.project, reason: item.on_turn.reason });
  } catch (error) {
    if (!(error instanceof SpawnError)) throw error;
    logger.error("watch_notify_failed", { key: item.key, error });
  }
}

/**
 * One poll. The baseline stays null until every source answered, so neither
 * the first poll nor a restart during an outage notifies for rows that were
 * already the owner's turn. A failed poll leaves the baseline untouched.
 */
export async function watchTick(
  config: PluginConfig,
  options: WatchOptions,
  deps: WatchDeps,
  baseline: Baseline,
  signal: AbortSignal,
): Promise<TickResult> {
  const { logger } = deps;
  const collected = await collectRows(config, options.project, deps);
  for (const warning of collected.warnings) logger.error("watch_warning", { warning });
  // Ignored rows never stay in the baseline, even on a partial poll, so a row that loses the label while it is the owner's turn is new to it and notifies once.
  const listed = collected.rows.map((row) => row.listItem);
  const items = listed.filter((item) => !item.ignored);
  const complete = collected.sourceFailures.length === 0;
  const next = transitionsToMe(baseline, items, complete);
  let nextBaseline: Baseline = baseline === null && !complete ? null : next.baseline;
  if (nextBaseline !== null) {
    const pruned = new Map(nextBaseline);
    for (const item of listed) if (item.ignored) pruned.delete(rowId(item));
    nextBaseline = pruned;
  }
  const marked = items.filter((item) => next.marked.has(rowId(item)));
  logger.info("watch_tick", { rows: items.length, notify: marked.length, complete, baselined: nextBaseline !== null });
  const notified: string[] = [];
  for (const item of marked) {
    if (signal.aborted) break;
    notified.push(rowId(item));
    await notify(config, item, deps);
  }
  return { baseline: nextBaseline, notified };
}

/** Polls every `[watch] poll_interval_secs` until `signal` aborts. */
export async function runWatch(
  config: PluginConfig,
  options: WatchOptions,
  deps: WatchDeps,
  signal: AbortSignal,
): Promise<void> {
  const intervalMs = config.global.watch.pollIntervalSecs * 1000;
  let baseline: Baseline = null;
  while (!signal.aborted) {
    try {
      baseline = (await watchTick(config, options, deps, baseline, signal)).baseline;
    } catch (error) {
      deps.logger.error("watch_tick_failed", { error: error instanceof Error ? error : String(error) });
    }
    await deps.sleep(intervalMs, signal);
  }
}
