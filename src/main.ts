#!/usr/bin/env bun
// Command line entry point: `pohunek-work list`, `do` and `doctor`.
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config/index.ts";
import { ActionError, LAUNCH_ACTIONS, type LaunchAction } from "./actions/types.ts";
import { runDo } from "./commands/do.ts";
import { runList } from "./commands/list.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { createLogger } from "./log.ts";
import { reportError, EXIT_ERROR } from "./cli-errors.ts";
import { resolveConfigDir, resolveLogDir } from "./paths.ts";
import { createGithubSource } from "./sources/github.ts";
import { createLinearSource } from "./sources/linear.ts";
import { createPohunekClient } from "./sources/pohunek.ts";
import pkg from "../package.json" with { type: "json" };

const USAGE = `usage:
  pohunek-work list [--mine] [--json] [--project <label>]
  pohunek-work do <key> <implement|babysit> [--profile <name>] [--project <label>] [--dry-run] [--yes] [--json]
  pohunek-work doctor

exit codes: 0 ok, 2 error, 3 list printed with at least one source unavailable;
doctor exits with the code of its first failed check (see doctor output)`;

/** `list` printed rows but at least one source did not answer, so rows may be `unknown` or missing. */
const EXIT_PARTIAL = 3;

class UsageError extends Error {}

function parseListArgs(argv: readonly string[]): { mine: boolean; json: boolean; project: string | null } {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: {
        mine: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        project: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals.join(" ")}`);
    return { mine: values.mine, json: values.json, project: values.project ?? null };
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
    return reportError(options.json, "configuration", "config_invalid", error.message);
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
      linear: createLinearSource(config.global.linear),
      logger,
      cliVersion: pkg.version,
    });
    for (const warning of output.warnings) console.error(warning);
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
    const known = LAUNCH_ACTIONS.find((name) => name === action);
    if (known === undefined) throw new UsageError(`unknown action: ${action} (known: ${LAUNCH_ACTIONS.join(", ")})`);
    if (values["dry-run"] && values.yes) throw new UsageError("--dry-run and --yes exclude each other");
    return {
      key,
      action: known,
      profile: values.profile ?? null,
      project: values.project ?? null,
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
  readonly action: LaunchAction;
  readonly profile: string | null;
  readonly project: string | null;
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
    return reportError(options.json, "configuration", "config_invalid", error.message);
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
      linear: createLinearSource(config.global.linear),
      logger,
      cliVersion: pkg.version,
      confirm: terminalConfirm(),
    });
    for (const warning of output.warnings) console.error(warning);
    console.log(output.stdout);
    return 0;
  } catch (error) {
    if (error instanceof ActionError) return reportError(options.json, "action", error.code, error.message);
    logger.error("do_failed", { error: error instanceof Error ? error : String(error) });
    throw error;
  } finally {
    await logger.close();
    const logFailure = logger.failure();
    if (logFailure !== null) console.error(`log write failed: ${logFailure.message}`);
  }
}

async function doctorCommand(argv: readonly string[]): Promise<number> {
  if (argv.length > 0) throw new UsageError(`doctor takes no arguments: ${argv.join(" ")}`);
  const report = await runDoctor({ configDir: resolveConfigDir() });
  console.log(formatDoctorReport(report));
  return report.exitCode;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const json = argv.includes("--json");
  try {
    switch (command) {
      case "list":
        return await listCommand(rest);
      case "do":
        return await doCommand(rest);
      case "doctor":
        return await doctorCommand(rest);
      default:
        throw new UsageError(command === undefined ? "missing command" : `unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      if (json) return reportError(true, "usage", "usage", `${error.message}\n${USAGE}`);
      console.error(`${error.message}\n${USAGE}`);
      return EXIT_ERROR;
    }
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return reportError(json, "internal", "internal_error", `unexpected failure: ${message}`);
  }
}

process.exitCode = await main(process.argv.slice(2));
