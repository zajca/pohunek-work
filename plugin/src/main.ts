#!/usr/bin/env bun
// Command line entry point: `pohunek-work list`, `do`, `doctor`, `manager`, `setup`, `tui` and `watch`.
import { resolveDaemonSocket } from "@pohunek/sdk";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config/index.ts";
import { ActionError, DO_ACTIONS, DO_CONTRACT_VERSION, isLaunchAction, type DoAction } from "./actions/types.ts";
import { runDo } from "./commands/do.ts";
import { MANAGER_CONTRACT_VERSION } from "./actions/manager.ts";
import { runManagerStart, type ManagerStartCommandOptions } from "./commands/manager.ts";
import { runList, type ListDeps } from "./commands/list.ts";
import { DEFAULT_KEYBINDS, runSetup, SETUP_STEPS, type SetupOptions, type SetupStep } from "./commands/setup.ts";
import { ISSUE_PICKER_SOURCES, SETUP_CONTRACT_VERSION } from "./setup/settings.ts";
import { LIST_CONTRACT_VERSION } from "./types/item.ts";
import { SetupIoError } from "./setup/install.ts";
import { SetupPathError } from "./setup/paths.ts";
import { runInkTui, type InkTuiOptions } from "./ink/app.tsx";
import { NotificationAnnouncer } from "./ink/notices.ts";
import { runWatch, unknownProjects } from "./commands/watch.ts";
import { DOCTOR_CONTRACT_VERSION, formatDoctorJson, formatDoctorReport, runDoctor } from "./doctor.ts";
import { createLogger } from "./log.ts";
import { reportError, EXIT_ERROR } from "./cli-errors.ts";
import { resolveConfigDir, resolveLogDir, resolveStateDir } from "./paths.ts";
import { createSharedCache } from "./cache/shared-cache.ts";
import type { PluginConfig } from "./types/config.ts";
import { cachedGithubSource, cachedLinearSource } from "./sources/cached.ts";
import { createGithubSource } from "./sources/github.ts";
import { createLinearSource } from "./sources/linear.ts";
import { createPohunekClient } from "./sources/pohunek.ts";
import { exec } from "./util/exec.ts";
import { sleep } from "./util/sleep.ts";
import { toAscii } from "./output/sanitize.ts";
import pkg from "../package.json" with { type: "json" };
// Bundled into the program text, so a compiled binary prints the guide without a source tree.
import managerGuide from "../prompts/manager-guide.md" with { type: "text" };

const USAGE = `usage:
  pohunek-work list [--mine] [--stale-days <n>] [--finished-hours <n>] [--include-ignored] [--refresh] [--json] [--project <label>]...
  pohunek-work do <key> <implement|babysit|fix-ci|rebase|review> [--profile <name>] [--project <label>] [--include-ignored] [--dry-run] [--yes] [--json]
  pohunek-work do <key> ready [--project <label>] [--include-ignored] [--dry-run] [--yes] [--json]
  pohunek-work do <key> attach [--project <label>] [--include-ignored] [--dry-run [--json]]
  pohunek-work do <key> cleanup [--project <label>] [--include-ignored] [--dry-run] [--yes] [--json]
  pohunek-work doctor [--json]
  pohunek-work manager guide
  pohunek-work manager start (--project <label>... | --all) [--profile <name>] [--dry-run] [--yes] [--json]
  pohunek-work setup [--force] [--json]
  pohunek-work setup scripts [--force] [--json]
  pohunek-work setup config [--force] [--json]
  pohunek-work setup sway [--force] [--print] [--keybind <key>] [--new-session-keybind <key>] [--issue-project <project> --issue-source <linear|github>] [--issue-keybind <key>] [--json]
  pohunek-work tui [--attach inline|window]
  pohunek-work new-session [--attach inline|window]
  pohunek-work watch [--project <label>]...

--project on list, watch and manager start repeats to select several projects; do takes one.
merge is not an action: merging stays manual.
exit codes: 0 ok, 2 error, 3 list printed with at least one source unavailable;
doctor exits with the code of its first failed check (see doctor output)`;

/** `list` printed rows but at least one source did not answer, so rows may be `unknown` or missing. */
const EXIT_PARTIAL = 3;

class UsageError extends Error {}

function parseStaleDays(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new UsageError(`--stale-days needs a positive whole number of days, got ${JSON.stringify(value)}`);
  return Number(value);
}

function parseFinishedHours(value: string | undefined, mine: boolean): number | null {
  if (value === undefined) return null;
  if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new UsageError(`--finished-hours needs a positive whole number of hours, got ${JSON.stringify(value)}`);
  if (!mine) throw new UsageError("--finished-hours needs --mine");
  return Number(value);
}

/** The labels of every `--project`, without duplicates; null when none was given. */
function projectSelection(labels: readonly string[] | undefined): string[] | null {
  return labels === undefined ? null : [...new Set(labels)];
}

function parseListArgs(argv: readonly string[]): { mine: boolean; staleDays: number | null; finishedHours: number | null; includeIgnored: boolean; refresh: boolean; json: boolean; projects: string[] | null } {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        mine: { type: "boolean", default: false },
        "stale-days": { type: "string" },
        "finished-hours": { type: "string" },
        "include-ignored": { type: "boolean", default: false },
        refresh: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        project: { type: "string", multiple: true },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals.join(" ")}`);
    return { mine: values.mine, staleDays: parseStaleDays(values["stale-days"]), finishedHours: parseFinishedHours(values["finished-hours"], values.mine), includeIgnored: values["include-ignored"], refresh: values.refresh, json: values.json, projects: projectSelection(values.project) };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

/**
 * The GitHub and Linear sources read through the shared cache of the state directory. `refresh` bypasses
 * the max age for this process; the cache still coalesces it with the other processes reading at the same time.
 */
function cachedSources(config: PluginConfig, refresh: boolean): Pick<ListDeps, "github" | "linear"> {
  const cache = createSharedCache({ stateDir: resolveStateDir(), config: config.global.cache, refresh });
  return {
    github: cachedGithubSource(createGithubSource(config.global), config.global, { cache }),
    linear:
      config.global.linear === null
        ? null
        : cachedLinearSource(createLinearSource(config.global.linear), config.global.linear, { cache }),
  };
}

async function listCommand(argv: readonly string[]): Promise<number> {
  const options = parseListArgs(argv);
  let config;
  try {
    config = await loadConfig(resolveConfigDir());
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return reportError(options.json, LIST_CONTRACT_VERSION, "configuration", "config_invalid", error.message);
  }

  const logger = createLogger({
    logDir: resolveLogDir(),
    command: "list",
    maxStringLength: config.global.log.maxStringLength,
  });
  logger.info("list_start", { ...options });
  try {
    const output = await runList(config, options, {
      pohunek: createPohunekClient(config.global.pohunek),
      ...cachedSources(config, options.refresh),
      logger,
      cliVersion: pkg.version,
    });
    for (const warning of output.warnings) console.error(toAscii(warning));
    for (const failure of output.sourceFailures) console.error(`source unavailable: ${failure}`);
    console.log(output.stdout);
    return output.sourceFailures.length > 0 ? EXIT_PARTIAL : 0;
  } catch (error) {
    logger.error("list_failed", { error: error instanceof Error ? error : String(error) });
    throw error;
  } finally {
    await logger.close();
    const logFailure = logger.failure();
    if (logFailure !== null) console.error(`log write failed: ${logFailure.message}`);
  }
}

function parseDoArgs(argv: readonly string[]): DoArgs {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        profile: { type: "string" },
        // Parsed as a list so a repeated --project is refused instead of keeping the last one.
        project: { type: "string", multiple: true },
        "include-ignored": { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const [key, action, ...extra] = positionals;
    if (key === undefined || action === undefined) throw new UsageError("do needs a key and an action");
    if (extra.length > 0) throw new UsageError(`unexpected argument: ${extra.join(" ")}`);
    const known = DO_ACTIONS.find((name) => name === action);
    if (known === undefined) throw new UsageError(`unknown action: ${action} (known: ${DO_ACTIONS.join(", ")})`);
    if (values["dry-run"] && values.yes) throw new UsageError("--dry-run and --yes exclude each other");
    const [project, ...moreProjects] = values.project ?? [];
    if (moreProjects.length > 0) throw new UsageError("do takes one --project");
    if (values.profile !== undefined && !isLaunchAction(known)) throw new UsageError(`--profile does not apply to ${known}`);
    // attach hands the terminal to the session, so there is no JSON result to print afterwards.
    if (known === "attach" && values.json && !values["dry-run"]) throw new UsageError("attach takes --json only with --dry-run");
    return {
      key,
      action: known,
      profile: values.profile ?? null,
      project: project ?? null,
      includeIgnored: values["include-ignored"],
      dryRun: values["dry-run"],
      yes: values.yes,
      json: values.json,
    };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

interface DoArgs {
  readonly key: string;
  readonly action: DoAction;
  readonly profile: string | null;
  readonly project: string | null;
  readonly includeIgnored: boolean;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly json: boolean;
}

/** Reads one answer line from the terminal; null when stdin is not a terminal. */
function terminalConfirm(): ((question: string) => Promise<boolean>) | null {
  if (!process.stdin.isTTY) return null;
  return async (question) => {
    process.stderr.write(`${question} [y/N] `);
    for await (const line of console) {
      return /^y(es)?$/i.test(line.trim());
    }
    return false;
  };
}

async function doCommand(argv: readonly string[]): Promise<number> {
  const options = parseDoArgs(argv);
  let config;
  try {
    config = await loadConfig(resolveConfigDir());
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return reportError(options.json, DO_CONTRACT_VERSION, "configuration", "config_invalid", error.message);
  }

  const logger = createLogger({
    logDir: resolveLogDir(),
    command: "do",
    maxStringLength: config.global.log.maxStringLength,
  });
  try {
    // `do` acts on the picture it reads, so it refreshes past the max age (still coalesced with other readers).
    const output = await runDo(config, options, {
      pohunek: createPohunekClient(config.global.pohunek),
      ...cachedSources(config, true),
      logger,
      cliVersion: pkg.version,
      confirm: terminalConfirm(),
      exec,
      terminal: process.stdin.isTTY && process.stdout.isTTY,
    });
    for (const warning of output.warnings) console.error(toAscii(warning));
    console.log(output.stdout);
    return 0;
  } catch (error) {
    if (error instanceof ActionError) return reportError(options.json, DO_CONTRACT_VERSION, "action", error.code, error.message);
    logger.error("do_failed", { error: error instanceof Error ? error : String(error) });
    throw error;
  } finally {
    await logger.close();
    const logFailure = logger.failure();
    if (logFailure !== null) console.error(`log write failed: ${logFailure.message}`);
  }
}

function parseSetupArgs(argv: readonly string[]): SetupOptions {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        force: { type: "boolean", default: false },
        print: { type: "boolean", default: false },
        keybind: { type: "string" },
        "new-session-keybind": { type: "string" },
        "issue-keybind": { type: "string" },
        "issue-project": { type: "string" },
        "issue-source": { type: "string" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    const [sub, ...extra] = positionals;
    if (extra.length > 0) throw new UsageError(`unexpected argument: ${extra.join(" ")}`);
    const step: SetupStep | undefined = sub === undefined ? "all" : SETUP_STEPS.find((name) => name === sub && name !== "all");
    if (step === undefined) throw new UsageError(`unknown setup step: ${String(sub)} (known: ${SETUP_STEPS.filter((name) => name !== "all").join(", ")})`);
    const sway = step === "sway";
    if (!sway && (values.print || values.keybind !== undefined || values["new-session-keybind"] !== undefined || values["issue-keybind"] !== undefined || values["issue-project"] !== undefined || values["issue-source"] !== undefined)) {
      throw new UsageError("--print, --keybind, --new-session-keybind, --issue-keybind, --issue-project and --issue-source apply to `setup sway` only");
    }
    if (values["issue-keybind"] !== undefined && values["issue-project"] === undefined) {
      throw new UsageError("--issue-keybind needs --issue-project: the issue picker is bound for one project");
    }
    if (values["issue-project"] === "") throw new UsageError("--issue-project needs a project");
    if (values["issue-project"] !== undefined && values["issue-source"] === undefined) {
      throw new UsageError(`--issue-project needs --issue-source <${ISSUE_PICKER_SOURCES.join("|")}>: the picker has no default source`);
    }
    if (values["issue-source"] !== undefined && values["issue-project"] === undefined) {
      throw new UsageError("--issue-source needs --issue-project: the issue picker is bound for one project");
    }
    const issueSource = values["issue-source"] === undefined ? null : ISSUE_PICKER_SOURCES.find((name) => name === values["issue-source"]);
    if (issueSource === undefined) {
      throw new UsageError(`unknown --issue-source ${JSON.stringify(values["issue-source"])} (known: ${ISSUE_PICKER_SOURCES.join(", ")})`);
    }
    if (values.print && values.force) throw new UsageError("--print and --force exclude each other");
    return {
      step,
      force: values.force,
      print: values.print,
      keybind: values.keybind ?? DEFAULT_KEYBINDS.keybind,
      newSessionKeybind: values["new-session-keybind"] ?? DEFAULT_KEYBINDS.newSessionKeybind,
      issueKeybind: values["issue-keybind"] ?? DEFAULT_KEYBINDS.issueKeybind,
      issueProject: values["issue-project"] ?? null,
      issueSource,
      json: values.json,
    };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

async function setupCommand(argv: readonly string[]): Promise<number> {
  const options = parseSetupArgs(argv);
  try {
    const output = await runSetup(options, { env: process.env, platform: process.platform, cliVersion: pkg.version });
    process.stdout.write(output.stdout);
    return 0;
  } catch (error) {
    if (error instanceof SetupPathError) return reportError(options.json, SETUP_CONTRACT_VERSION, "configuration", "setup_paths", error.message);
    if (error instanceof SetupIoError) return reportError(options.json, SETUP_CONTRACT_VERSION, "action", "setup_io", error.message);
    throw error;
  }
}

async function doctorCommand(argv: readonly string[]): Promise<number> {
  const unexpected = argv.filter((arg) => arg !== "--json");
  if (unexpected.length > 0) throw new UsageError(`doctor takes only --json: ${unexpected.join(" ")}`);
  const report = await runDoctor({ configDir: resolveConfigDir(), launcher: { env: process.env, platform: process.platform } });
  console.log(argv.includes("--json") ? formatDoctorJson(report, pkg.version) : formatDoctorReport(report));
  return report.exitCode;
}

function parseManagerStartArgs(argv: readonly string[]): ManagerStartCommandOptions {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        project: { type: "string", multiple: true },
        all: { type: "boolean", default: false },
        profile: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        yes: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals.join(" ")}`);
    const projects = projectSelection(values.project);
    if (projects !== null && values.all) throw new UsageError("--project and --all exclude each other");
    // No implicit "every project": the owner names the set or asks for all of them.
    if (projects === null && !values.all) throw new UsageError("manager start needs --project <label> (repeatable) or --all");
    if (values["dry-run"] && values.yes) throw new UsageError("--dry-run and --yes exclude each other");
    return { projects, profile: values.profile ?? null, dryRun: values["dry-run"], yes: values.yes, json: values.json };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

async function managerStartCommand(argv: readonly string[]): Promise<number> {
  const options = parseManagerStartArgs(argv);
  let config;
  try {
    config = await loadConfig(resolveConfigDir());
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return reportError(options.json, MANAGER_CONTRACT_VERSION, "configuration", "config_invalid", error.message);
  }
  const manager = config.global.manager;
  if (manager === null) {
    return reportError(options.json, MANAGER_CONTRACT_VERSION, "configuration", "config_invalid", "config.toml: [manager] is required by manager start: set its profile and workdir keys");
  }

  const logger = createLogger({
    logDir: resolveLogDir(),
    command: "manager",
    maxStringLength: config.global.log.maxStringLength,
  });
  try {
    const output = await runManagerStart(config, manager, options, {
      pohunek: createPohunekClient(config.global.pohunek),
      logger,
      cliVersion: pkg.version,
      confirm: terminalConfirm(),
    });
    for (const warning of output.warnings) console.error(toAscii(warning));
    console.log(output.stdout);
    return 0;
  } catch (error) {
    if (error instanceof ActionError) return reportError(options.json, MANAGER_CONTRACT_VERSION, "action", error.code, error.message);
    logger.error("manager_failed", { error: error instanceof Error ? error : String(error) });
    throw error;
  } finally {
    await logger.close();
    const logFailure = logger.failure();
    if (logFailure !== null) console.error(`log write failed: ${logFailure.message}`);
  }
}

async function managerCommand(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "start") return managerStartCommand(rest);
  if (sub !== "guide") throw new UsageError(sub === undefined ? "manager needs a subcommand (known: guide, start)" : `unknown manager subcommand: ${sub} (known: guide, start)`);
  if (rest.length > 0) throw new UsageError(`manager guide takes no arguments: ${rest.join(" ")}`);
  process.stdout.write(managerGuide);
  return 0;
}
/** Socket of the local daemon: POHUNEK_SOCKET_PATH when the environment names one, else the runtime directory's. */
function resolveLocalSocket(): string | null {
  const named = process.env["POHUNEK_SOCKET_PATH"];
  if (named !== undefined && named !== "") return named;
  try {
    return resolveDaemonSocket({ platform: process.platform === "darwin" ? "macos" : "linux", effectiveUid: process.getuid?.() ?? 0 }, process.env);
  } catch {
    return null;
  }
}

async function terminalUiCommand(mode: InkTuiOptions["mode"], argv: readonly string[]): Promise<number> {
  const command = mode === "main" ? "tui" : "new-session";
  let values: { attach?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: [...argv], strict: true, allowPositionals: true, options: { attach: { type: "string" } } }));
  } catch (error) {
    if (argv.includes("--attach")) throw new UsageError("--attach takes inline or window");
    throw new UsageError(`${command} takes no arguments: ${argv.join(" ")} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (positionals.length > 0) throw new UsageError(`${command} takes no arguments: ${positionals.join(" ")}`);
  if (values.attach !== undefined && values.attach !== "inline" && values.attach !== "window") {
    throw new UsageError(`--attach takes inline or window, got ${JSON.stringify(values.attach)}`);
  }
  let config;
  try {
    config = await loadConfig(resolveConfigDir());
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return reportError(false, LIST_CONTRACT_VERSION, "configuration", "config_invalid", error.message);
  }
  const attachMode = values.attach ?? config.global.tui.attachMode;
  const attachCommand = config.global.tui.attachCommand;
  if (attachMode === "window" && attachCommand === undefined) {
    return reportError(false, LIST_CONTRACT_VERSION, "configuration", "config_invalid", `${command}: window attach needs attach_command in the [tui] table of config.toml`);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return reportError(false, LIST_CONTRACT_VERSION, "usage", "no_terminal", `${command} needs a terminal on stdin and stdout`);
  }
  const logger = createLogger({
    logDir: resolveLogDir(),
    command,
    maxStringLength: config.global.log.maxStringLength,
  });
  const announcer = mode === "main" ? new NotificationAnnouncer(config.global.notify, logger) : null;
  const noticeTasks = new Set<Promise<void>>();
  const opened: { line: string | null } = { line: null };
  try {
    const code = await runInkTui({
      mode,
      selfBin: config.global.tui.selfBin,
      pohunekBin: config.global.pohunek.bin,
      timeoutMs: config.global.pohunek.timeoutMs,
      listTimeoutMs: config.global.tui.listTimeoutMs,
      launchTimeoutMs: config.global.actions.launchTimeoutMs,
      launchKillMarginMs: config.global.actions.launchKillMarginMs,
      notificationsPageSize: config.global.pohunek.notificationsPageSize,
      reconnectMaxMs: config.global.tui.reconnectMaxSecs * 1000,
      refreshIntervalMs: config.global.tui.refreshIntervalSecs * 1000,
      sessionReconcileMs: config.global.tui.sessionReconcileSecs * 1000,
      actionCaptureBytes: config.global.tui.actionCaptureBytes,
      outputWaitMs: config.global.tui.outputWaitMs,
      outputMaxBytes: config.global.tui.outputMaxBytes,
      doubleClickMs: config.global.tui.doubleClickMs,
      detailMinWidth: config.global.tui.detailMinWidth,
      attachMode,
      ...(config.global.tui.detachSequence === undefined ? {} : { detachSequence: config.global.tui.detachSequence }),
      ...(attachCommand === undefined || config.global.tui.attachLaunchCheckMs === undefined ? {} : {
        attachCommand,
        attachLaunchCheckMs: config.global.tui.attachLaunchCheckMs,
      }),
      localSocket: resolveLocalSocket(),
      initialView: config.global.tui.initialView,
      stalePrDays: config.global.tui.stalePrDays,
      openUrlHosts: config.global.tui.openUrlHosts,
      openCommand: config.global.tui.openCommand,
      ...(config.global.tui.clipboardCommand === undefined ? {} : { clipboardCommand: config.global.tui.clipboardCommand }),
      onSnapshot: (snapshot) => {
        if (announcer === null) return;
        const task = announcer.announce(snapshot).catch((error: unknown) => {
          logger.error("tui_notice_failed", { error: error instanceof Error ? error : String(error) });
        });
        noticeTasks.add(task);
        void task.finally(() => { noticeTasks.delete(task); });
      },
      log: (event, detail) => { logger.info(event, detail === undefined ? {} : { detail }); },
      onWindowOpened: (line) => { opened.line = line; },
    });
    // Printed after the screen is restored, so the launching terminal shows where the session went.
    if (opened.line !== null) console.log(opened.line);
    return code;
  } finally {
    await Promise.allSettled([...noticeTasks]);
    await logger.close();
    const logFailure = logger.failure();
    if (logFailure !== null) console.error(`log write failed: ${logFailure.message}`);
  }
}

function parseWatchArgs(argv: readonly string[]): { projects: string[] | null } {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { project: { type: "string", multiple: true } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals.join(" ")}`);
    return { projects: projectSelection(values.project) };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
}

async function watchCommand(argv: readonly string[]): Promise<number> {
  const options = parseWatchArgs(argv);
  let config;
  try {
    config = await loadConfig(resolveConfigDir());
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return reportError(false, LIST_CONTRACT_VERSION, "configuration", "config_invalid", error.message);
  }
  const unknown = unknownProjects(config, options.projects);
  if (unknown.length > 0) {
    const labels = unknown.map((label) => JSON.stringify(label)).join(", ");
    return reportError(false, LIST_CONTRACT_VERSION, "usage", "unknown_project", `no project file for ${unknown.length === 1 ? "label" : "labels"} ${labels}`);
  }
  const logger = createLogger({
    logDir: resolveLogDir(),
    command: "watch",
    maxStringLength: config.global.log.maxStringLength,
  });
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  logger.info("watch_start", { ...options, poll_interval_secs: config.global.watch.pollIntervalSecs });
  console.error(`watching every ${String(config.global.watch.pollIntervalSecs)} s; stop with SIGINT or SIGTERM`);
  try {
    await runWatch(config, options, {
      pohunek: createPohunekClient(config.global.pohunek),
      ...cachedSources(config, false),
      logger,
      exec,
      sleep,
    }, controller.signal);
    logger.info("watch_stop");
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await logger.close();
    const logFailure = logger.failure();
    if (logFailure !== null) console.error(`log write failed: ${logFailure.message}`);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const json = argv.includes("--json");
  const contract =
    command === "do" ? DO_CONTRACT_VERSION
    : command === "manager" ? MANAGER_CONTRACT_VERSION
    : command === "setup" ? SETUP_CONTRACT_VERSION
    : command === "doctor" ? DOCTOR_CONTRACT_VERSION
    : LIST_CONTRACT_VERSION;
  try {
    switch (command) {
      case "list":
        return await listCommand(rest);
      case "do":
        return await doCommand(rest);
      case "doctor":
        return await doctorCommand(rest);
      case "manager":
        return await managerCommand(rest);
      case "setup":
        return await setupCommand(rest);
      case "tui":
        return await terminalUiCommand("main", rest);
      case "new-session":
        return await terminalUiCommand("new-session", rest);
      case "watch":
        return await watchCommand(rest);
      default:
        throw new UsageError(command === undefined ? "missing command" : `unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      if (json) return reportError(true, contract, "usage", "usage", `${error.message}\n${USAGE}`);
      console.error(`${error.message}\n${USAGE}`);
      return EXIT_ERROR;
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return reportError(json, contract, "internal", "internal_error", `unexpected failure: ${message}`);
  }
}

const exitCode = await main(process.argv.slice(2));
// A list child still running when the owner quits the TUI must not keep the
// process alive until its timeout; it runs in its own process group and ends on its own.
if (process.argv[2] === "tui" || process.argv[2] === "new-session") process.exit(exitCode);
process.exitCode = exitCode;
