// `pohunek-work manager start`: shows the plan of one manager session and
// launches it once confirmed, verified the same way `do` verifies its sessions.
import { displayArgv, launchVerified } from "../actions/launch.ts";
import { MANAGER_CONTRACT_VERSION, planManagerStart, scopeOf, type ManagerPlan, type ManagerStartOptions } from "../actions/manager.ts";
import { ActionError, type ActionResult } from "../actions/types.ts";
import type { Logger } from "../log.ts";
import type { PohunekClient } from "../sources/pohunek.ts";
import type { ManagerConfig, PluginConfig } from "../types/config.ts";
import { commandLine, confirmPlan, display, envelope, type Confirm } from "./plan-output.ts";

export interface ManagerStartCommandOptions extends ManagerStartOptions {
  readonly dryRun: boolean;
  /** Skips the interactive confirmation. */
  readonly yes: boolean;
  readonly json: boolean;
}

export interface ManagerDeps {
  readonly pohunek: PohunekClient;
  readonly logger: Logger;
  readonly cliVersion: string;
  readonly confirm: Confirm;
}

export interface ManagerOutput {
  readonly stdout: string;
  readonly warnings: readonly string[];
}

function planText(plan: ManagerPlan, argv: readonly string[]): string {
  return [
    "action:   manager start",
    `projects: ${plan.all ? `* (every configured project; registered now: ${plan.projects.join(", ")})` : plan.projects.join(", ")}`,
    `profile:  ${plan.profile}`,
    `cwd:      ${plan.cwd}`,
    `command:  ${commandLine(argv)}`,
    "prompt (stdin):",
    ...plan.prompt.split("\n").map((line) => `  ${line}`),
  ].join("\n");
}

function planJson(plan: ManagerPlan, argv: readonly string[]): Record<string, unknown> {
  return {
    all: plan.all,
    projects: plan.projects,
    skipped: plan.skipped,
    profile: plan.profile,
    cwd: plan.cwd,
    name: plan.name,
    metadata: plan.metadata,
    argv,
    prompt: plan.prompt,
  };
}

function resultJson(result: ActionResult): Record<string, unknown> {
  return {
    session_id: result.sessionId,
    name: result.name,
    metadata: result.metadata,
    ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }),
  };
}

function skippedWarnings(plan: ManagerPlan): string[] {
  return plan.skipped.map((skipped) => `project ${skipped.project}: ${skipped.reason}; left out (run doctor)`);
}

/**
 * Plans again from fresh reads right before the launch: a confirmation may have waited long enough for
 * another terminal to start a manager, so it authorizes only the exact argv and prompt that were shown.
 */
async function requireUnchangedPlan(
  config: PluginConfig,
  manager: ManagerConfig,
  options: ManagerStartCommandOptions,
  deps: ManagerDeps,
  shown: { readonly argv: readonly string[]; readonly prompt: string },
): Promise<ManagerPlan> {
  const fresh = await planManagerStart(config, manager, options, deps.pohunek);
  const argv = displayArgv(config.global.pohunek.bin, fresh);
  const changes = [
    ...(commandLine(argv) === commandLine(shown.argv) ? [] : [`the command is now ${commandLine(argv)} instead of ${commandLine(shown.argv)}`]),
    ...(fresh.prompt === shown.prompt ? [] : ["the prompt differs from the one shown"]),
  ];
  if (changes.length > 0) {
    throw new ActionError("precondition_failed", `manager start refused: the plan changed after it was shown (${changes.join("; ")}); nothing was launched, review the plan again`);
  }
  return fresh;
}

async function start(config: PluginConfig, manager: ManagerConfig, options: ManagerStartCommandOptions, deps: ManagerDeps): Promise<ManagerOutput> {
  const { logger } = deps;
  const plan = await planManagerStart(config, manager, options, deps.pohunek);
  const argv = displayArgv(config.global.pohunek.bin, plan);
  logger.info("manager_plan", { all: plan.all, projects: [...plan.projects], profile: plan.profile, cwd: plan.cwd, argv });
  if (options.dryRun) {
    const stdout = options.json
      ? envelope(deps.cliVersion, MANAGER_CONTRACT_VERSION, { dry_run: true, plan: planJson(plan, argv) })
      : display(`dry run: nothing was executed\n${planText(plan, argv)}`);
    return { stdout, warnings: skippedWarnings(plan) };
  }
  await confirmPlan(options.yes, deps.confirm, planText(plan, argv));
  const confirmed = await requireUnchangedPlan(config, manager, options, deps, { argv, prompt: plan.prompt });
  const result = await launchVerified(confirmed, deps.pohunek, config);
  logger.info("manager_done", { all: plan.all, projects: [...plan.projects], profile: plan.profile, session_id: result.sessionId, warnings: [...result.warnings] });
  const stdout = options.json
    ? envelope(deps.cliVersion, MANAGER_CONTRACT_VERSION, { dry_run: false, plan: planJson(plan, argv), result: resultJson(result) })
    : display(`started session ${result.sessionId} (${result.name ?? plan.name}) for ${scopeOf(plan)}; attach with: pohunek attach ${result.sessionId}`);
  return { stdout, warnings: [...skippedWarnings(plan), ...result.warnings.map((kind) => `pohunek launch warning: ${kind}`)] };
}

/** Throws `ActionError` for every refusal; returns the text for stdout otherwise. */
export async function runManagerStart(
  config: PluginConfig,
  manager: ManagerConfig,
  options: ManagerStartCommandOptions,
  deps: ManagerDeps,
): Promise<ManagerOutput> {
  const { logger } = deps;
  logger.info("manager_start", {
    projects: options.projects === null ? null : [...options.projects],
    all: options.projects === null,
    profile: options.profile,
    dry_run: options.dryRun,
    confirmed_by: options.yes ? "yes" : "tty",
  });
  try {
    return await start(config, manager, options, deps);
  } catch (error) {
    if (error instanceof ActionError) logger.error("manager_refused", { code: error.code, message: error.message });
    throw error;
  }
}
