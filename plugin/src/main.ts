#!/usr/bin/env bun
// Command line entry point: `pohunek-work list`, `do`, `doctor`, `setup`, `tui` and `watch`.
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config/index.ts";
import { ActionError, DO_ACTIONS, DO_CONTRACT_VERSION, isLaunchAction, type DoAction } from "./actions/types.ts";
import { runDo } from "./commands/do.ts";
import { runList } from "./commands/list.ts";
import { DEFAULT_KEYBINDS, runSetup, SETUP_STEPS, type SetupOptions, type SetupStep } from "./commands/setup.ts";
import { ISSUE_PICKER_SOURCES, SETUP_CONTRACT_VERSION } from "./setup/settings.ts";
import { LIST_CONTRACT_VERSION } from "./types/item.ts";
import { SetupIoError } from "./setup/install.ts";
import { SetupPathError } from "./setup/paths.ts";
import { EXIT_TUI_ERROR, runTui } from "./commands/tui.ts";
import { runWatch, unknownProject } from "./commands/watch.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { createTerminal } from "./tui/terminal.ts";
import { spawnDetached, spawnForeground } from "./tui/children.ts";
import { createLogger } from "./log.ts";
import { reportError, EXIT_ERROR } from "./cli-errors.ts";
import { resolveConfigDir, resolveLogDir } from "./paths.ts";
import { createGithubSource } from "./sources/github.ts";
import { createLinearSource } from "./sources/linear.ts";
import { createPohunekClient } from "./sources/pohunek.ts";
import { exec } from "./util/exec.ts";
import { sleep } from "./util/sleep.ts";
import { toAscii } from "./output/sanitize.ts";
import pkg from "../package.json" with { type: "json" };

const USAGE = `usage:
  pohunek-work list [--mine] [--stale-days <n>] [--finished-hours <n>] [--include-ignored] [--json] [--project <label>]
  pohunek-work do <key> <implement|babysit|fix-ci|rebase|review> [--profile <name>] [--project <label>] [--include-ignored] [--dry-run] [--yes] [--json]
  pohunek-work do <key> ready [--project <label>] [--include-ignored] [--dry-run] [--yes] [--json]
  pohunek-work do <key> attach [--project <label>] [--include-ignored] [--dry-run [--json]]
  pohunek-work doctor
  pohunek-work setup [--force] [--json]
  pohunek-work setup scripts [--force] [--json]
  pohunek-work setup config [--force] [--json]
  pohunek-work setup sway [--force] [--print] [--keybind <key>] [--issue-project <project> --issue-source <linear|github>] [--issue-keybind <key>] [--json]
  pohunek-work tui
  pohunek-work watch [--project <label>]

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

function parseListArgs(argv: readonly string[]): { mine: boolean; staleDays: number | null; finishedHours: number | null; includeIgnored: boolean; json: boolean; project: string | null } {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        mine: { type: "boolean", default: false },
        "stale-days": { type: "string" },
        "finished-hours": { type: "string" },
        "include-ignored": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        project: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals.join(" ")}`);
    return { mine: values.mine, staleDays: parseStaleDays(values["stale-days"]), finishedHours: parseFinishedHours(values["finished-hours"], values.mine), includeIgnored: values["include-ignored"], json: values.json, project: values.project ?? null };
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(error instanceof Error ? error.message : "invalid arguments");
  }
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
      github: createGithubSource(config.global),
      linear: config.global.linear === null ? null : createLinearSource(config.global.linear),
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
        project: { type: "string" },
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
    if (values.profile !== undefined && !isLaunchAction(known)) throw new UsageError(`--profile does not apply to ${known}`);
    // attach hands the terminal to the session, so there is no JSON result to print afterwards.
    if (known === "attach" && values.json && !values["dry-run"]) throw new UsageError("attach takes --json only with --dry-run");
    return {
      key,
      action: known,
      profile: values.profile ?? null,
      project: values.project ?? null,
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
    const output = await runDo(config, options, {
      pohunek: createPohunekClient(config.global.pohunek),
      github: createGithubSource(config.global),
      linear: config.global.linear === null ? null : createLinearSource(config.global.linear),
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
    if (!sway && (values.print || values.keybind !== undefined || values["issue-keybind"] !== undefined || values["issue-project"] !== undefined || values["issue-source"] !== undefined)) {
      throw new UsageError("--print, --keybind, --issue-keybind, --issue-project and --issue-source apply to `setup sway` only");
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
  if (argv.length > 0) throw new UsageError(`doctor takes no arguments: ${argv.join(" ")}`);
  const report = await runDoctor({ configDir: resolveConfigDir(), launcher: { env: process.env, platform: process.platform } });
  console.log(formatDoctorReport(report));
  return report.exitCode;
}

async function tuiCommand(argv: readonly string[]): Promise<number> {
  if (argv.length > 0) throw new UsageError(`tui takes no arguments: ${argv.join(" ")}`);
  let config;
  try {
    config = await loadConfig(resolveConfigDir());
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return reportError(false, LIST_CONTRACT_VERSION, "configuration", "config_invalid", error.message);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return reportError(false, LIST_CONTRACT_VERSION, "usage", "no_terminal", "tui needs a terminal on stdin and stdout");
  }
  const logger = createLogger({
    logDir: resolveLogDir(),
    command: "tui",
    maxStringLength: config.global.log.maxStringLength,
  });
  const terminal = createTerminal(process.stdin, process.stdout, process);
  // Safety net for an error outside the reducer's own handling: the terminal must never stay in raw mode.
  const onFatal = (error: unknown): void => {
    terminal.restore();
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`pohunek-work tui: internal error: ${toAscii(message)}`);
    process.exit(EXIT_TUI_ERROR);
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  try {
    return await runTui({
      config: config.global.tui,
      cliVersion: pkg.version,
      logger,
      terminal,
      exec,
      spawnForeground,
      spawnDetached,
      now: () => Date.now(),
      timers: { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); } },
      report: (message) => {
        console.error(message);
      },
    });
  } finally {
    await logger.close();
    const logFailure = logger.failure();
    if (logFailure !== null) console.error(`log write failed: ${logFailure.message}`);
  }
}

function parseWatchArgs(argv: readonly string[]): { project: string | null } {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: { project: { type: "string" } },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals.join(" ")}`);
    return { project: values.project ?? null };
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
  const unknown = unknownProject(config, options.project);
  if (unknown !== null) {
    return reportError(false, LIST_CONTRACT_VERSION, "usage", "unknown_project", `no project file for label ${JSON.stringify(unknown)}`);
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
      github: createGithubSource(config.global),
      linear: config.global.linear === null ? null : createLinearSource(config.global.linear),
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
  const contract = command === "do" ? DO_CONTRACT_VERSION : command === "setup" ? SETUP_CONTRACT_VERSION : LIST_CONTRACT_VERSION;
  try {
    switch (command) {
      case "list":
        return await listCommand(rest);
      case "do":
        return await doCommand(rest);
      case "doctor":
        return await doctorCommand(rest);
      case "setup":
        return await setupCommand(rest);
      case "tui":
        return await tuiCommand(rest);
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
if (process.argv[2] === "tui") process.exit(exitCode);
process.exitCode = exitCode;
