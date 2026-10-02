// `pohunek-work tui`: wiring of the full-screen view. Runs the pure reducer,
// draws its frames and executes its effects (children, timers, bell, quit).
// It never imports the list pipeline: data comes from `self_bin list --json`.
import type { Logger } from "../log.ts";
import { toAscii } from "../output/sanitize.ts";
import type { TuiConfig } from "../types/config.ts";
import type { Exec } from "../util/exec.ts";
import { openUrl, runHandover, runList, runPreview, type DetachedSpawn, type ForegroundSpawn } from "../tui/children.ts";
import { decodeDoEnvelope } from "../tui/decode.ts";
import { initialState, start, update, MS_PER_SECOND, type Effect, type Event, type Settings, type State } from "../tui/model.ts";
import type { Terminal } from "../tui/terminal.ts";
import { view } from "../tui/view.ts";

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TuiDeps {
  readonly config: TuiConfig;
  readonly cliVersion: string;
  readonly logger: Logger;
  readonly terminal: Terminal;
  readonly exec: Exec;
  readonly now: () => number;
  readonly timers: Timers;
  /** Runs `do` children on the terminal (handover). */
  readonly spawnForeground: ForegroundSpawn;
  /** Starts the URL opener. */
  readonly spawnDetached: DetachedSpawn;
  /** Prints an internal error after the terminal is restored. */
  readonly report: (message: string) => void;
}

/** Exit code of a TUI ended by an internal error (the terminal is restored first). */
export const EXIT_TUI_ERROR = 2;

export function settingsFrom(config: TuiConfig, cliVersion: string): Settings {
  return {
    selfBin: config.selfBin,
    cliVersion,
    refreshIntervalMs: config.refreshIntervalSecs * MS_PER_SECOND,
    staleAfterMs: config.staleAfterSecs * MS_PER_SECOND,
    stalePrDays: config.stalePrDays,
    initialView: config.initialView,
    bellOnTransition: config.bellOnTransition,
    stderrMaxLines: config.stderrMaxLines,
    detailMinWidth: config.detailMinWidth,
    openUrlHosts: config.openUrlHosts,
  };
}

function sourceFailures(event: Extract<Event, { kind: "listDone" }>): number {
  if (event.outcome?.kind !== "ok") return 0;
  return event.outcome.payload.projects.reduce(
    (sum, project) => sum + Object.values(project.sources).filter((code) => code !== "ok").length,
    0,
  );
}

/** Resolves with the exit code once the owner quits or an internal error ends the TUI. */
export async function runTui(deps: TuiDeps): Promise<number> {
  const { terminal, logger, timers, now } = deps;
  let state: State = initialState(settingsFrom(deps.config, deps.cliVersion), terminal.size(), now());
  let refreshTimer: unknown = null;
  let wakeTimer: unknown = null;
  let finish: (code: number) => void = () => undefined;
  // Written from callbacks, so it lives in an object the flow analysis does not narrow.
  const failed: { message: string | null } = { message: null };
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const clear = (handle: unknown): null => {
    if (handle !== null) timers.clearTimeout(handle);
    return null;
  };

  const fail = (error: unknown): void => {
    logger.error("tui_error", { error: error instanceof Error ? error : String(error) });
    failed.message ??= error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    finish(EXIT_TUI_ERROR);
  };

  const apply = ([next, effects]: readonly [State, readonly Effect[]]): void => {
    state = next;
    terminal.draw(view(state));
    for (const effect of effects) execute(effect);
  };

  const dispatch = (event: Event): void => {
    try {
      apply(update(state, event));
    } catch (error) {
      fail(error);
    }
  };

  function execute(effect: Effect): void {
    switch (effect.kind) {
      case "list": {
        refreshTimer = clear(refreshTimer);
        runList(deps.exec, effect.argv, deps.config.listTimeoutMs, now).then((result) => {
          const event = { kind: "listDone", run: result.run, outcome: result.outcome, now: now() } as const;
          logger.info("refresh_done", {
            duration_ms: result.durationMs,
            exit_code: result.run.exitCode,
            timed_out: result.run.timedOut,
            outcome: result.outcome?.kind ?? (result.run.spawnError === null ? "no_output" : "spawn_failed"),
            items: result.outcome?.kind === "ok" ? result.outcome.payload.items.length : null,
            source_failures: sourceFailures(event),
          });
          dispatch(event);
        }).catch(fail);
        return;
      }
      case "preview":
        runPreview(deps.exec, effect.argv, deps.config.listTimeoutMs).then(({ run, outcome }) => {
          logger.info("preview", {
            action: effect.action,
            argv: [...effect.argv],
            exit_code: run.exitCode,
            timed_out: run.timedOut,
            outcome: outcome?.kind ?? (run.spawnError === null ? "no_output" : "spawn_failed"),
          });
          dispatch({ kind: "previewDone", row: effect.row, action: effect.action, run, outcome });
        }).catch(fail);
        return;
      case "handover":
        logger.info("handover_start", { key: effect.key, action: effect.action, mode: effect.mode, argv: [...effect.argv] });
        runHandover(terminal, deps.spawnForeground, effect.mode, effect.argv).then((exit) => {
          const decoded = effect.mode === "write" && exit.stdout.trim() !== "" ? decodeDoEnvelope(exit.stdout) : null;
          logger.info("handover_end", {
            key: effect.key,
            action: effect.action,
            exit_code: exit.exitCode,
            signal: exit.signal,
            spawn_error: exit.spawnError,
            refusal: decoded?.kind === "error" ? decoded.err.code : null,
          });
          dispatch({ kind: "handoverDone", mode: effect.mode, row: effect.row, key: effect.key, action: effect.action, exit, now: now() });
        }).catch(fail);
        return;
      case "open": {
        const error = openUrl(deps.spawnDetached, deps.config.openCommand, effect.href);
        logger.info("open_url", { key: effect.key, host: effect.host, error });
        dispatch({ kind: "openDone", error });
        return;
      }
      case "schedule":
        refreshTimer = clear(refreshTimer);
        refreshTimer = timers.setTimeout(() => {
          refreshTimer = null;
          dispatch({ kind: "timer", now: now() });
        }, effect.delayMs);
        return;
      case "wake":
        wakeTimer = clear(wakeTimer);
        wakeTimer = timers.setTimeout(() => {
          wakeTimer = null;
          dispatch({ kind: "tick", now: now() });
        }, Math.max(0, effect.at - now()));
        return;
      case "bell":
        terminal.bell();
        return;
      case "quit":
        finish(0);
        return;
    }
  }

  logger.info("tui_start", { self_bin: deps.config.selfBin, initial_view: deps.config.initialView });
  terminal.start({
    onKey: (key) => {
      dispatch({ kind: "key", key, now: now() });
    },
    onResize: (size) => {
      dispatch({ kind: "resize", size });
    },
    onSignal: (signal) => {
      logger.info("terminal_restore", { reason: signal });
      // The process exits right after this; queued log lines are written first.
      return logger.close();
    },
  });
  try {
    apply(start(state));
    return await finished;
  } catch (error) {
    fail(error);
    return EXIT_TUI_ERROR;
  } finally {
    refreshTimer = clear(refreshTimer);
    wakeTimer = clear(wakeTimer);
    terminal.restore();
    logger.info("terminal_restore", { reason: "exit" });
    if (failed.message !== null) deps.report(`pohunek-work tui: internal error: ${toAscii(failed.message)}`);
  }
}
