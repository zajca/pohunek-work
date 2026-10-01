#!/usr/bin/env bun
// Command line entry point: `pohunek-work list` and `pohunek-work doctor`.
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config/index.ts";
import { runList } from "./commands/list.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { createLogger } from "./log.ts";
import { buildErrorEnvelope } from "./output/list.ts";
import { resolveConfigDir, resolveLogDir } from "./paths.ts";
import { createGithubSource } from "./sources/github.ts";
import { createLinearSource } from "./sources/linear.ts";
import { createPohunekClient } from "./sources/pohunek.ts";
import pkg from "../package.json" with { type: "json" };

const USAGE = `usage:
  pohunek-work list [--mine] [--json] [--project <label>]
  pohunek-work doctor`;

/** Exit code of a failed command; the pohunek CLI uses the same value for errors. */
const EXIT_ERROR = 2;

async function listCommand(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      mine: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      project: { type: "string" },
    },
    strict: true,
  });
  const json = values.json;
  let config;
  try {
    config = await loadConfig(resolveConfigDir());
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    if (json) {
      const err = { class: "configuration", code: "config_invalid", msg: error.message };
      console.log(JSON.stringify(buildErrorEnvelope(pkg.version, err), null, 2));
    } else {
      console.error(error.message);
    }
    return EXIT_ERROR;
  }

  const logger = createLogger({
    logDir: resolveLogDir(),
    command: "list",
    maxStringLength: config.global.log.maxStringLength,
  });
  logger.info("list_start", { mine: values.mine, json, project: values.project ?? null });
  const output = await runList(
    config,
    { mine: values.mine, json, project: values.project ?? null },
    {
      pohunek: createPohunekClient(config.global.pohunek),
      github: createGithubSource(config.global),
      linear: createLinearSource(config.global.linear),
      logger,
      cliVersion: pkg.version,
    },
  );
  await logger.close();
  for (const warning of output.warnings) console.error(warning);
  const logFailure = logger.failure();
  if (logFailure !== null) console.error(`log write failed: ${logFailure.message}`);
  console.log(output.stdout);
  return 0;
}

async function doctorCommand(): Promise<number> {
  const report = await runDoctor({ configDir: resolveConfigDir() });
  console.log(formatDoctorReport(report));
  return report.exitCode;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "list":
      return listCommand(rest);
    case "doctor":
      return doctorCommand();
    default:
      console.error(USAGE);
      return EXIT_ERROR;
  }
}

process.exitCode = await main(process.argv.slice(2));
