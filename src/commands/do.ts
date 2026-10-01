// `pohunek-work do <key> <action>`: runs one write action on one row.
// Fresh data, typed refusals, the exact argv shown before anything runs.
import { displayArgv, executePlan, planLaunch } from "../actions/launch.ts";
import { resolveRow } from "../actions/resolve.ts";
import {
  ActionError,
  DO_CONTRACT_VERSION,
  type ActionPlan,
  type ActionResult,
  type LaunchAction,
} from "../actions/types.ts";
import type { Logger } from "../log.ts";
import type { ListDeps } from "./list.ts";
import type { PluginConfig } from "../types/config.ts";

export interface DoOptions {
  readonly key: string;
  readonly action: LaunchAction;
  readonly profile: string | null;
  readonly project: string | null;
  readonly dryRun: boolean;
  /** Skips the interactive confirmation. */
  readonly yes: boolean;
  readonly json: boolean;
}

export interface DoDeps extends Omit<ListDeps, "cliVersion"> {
  readonly cliVersion: string;
  /** Asks the owner to confirm the shown command; absent when there is no terminal. */
  readonly confirm: ((question: string) => Promise<boolean>) | null;
}

export interface DoOutput {
  readonly stdout: string;
  readonly warnings: readonly string[];
}

const SAFE_ARG = /^[A-Za-z0-9_./:=@%+,-]+$/;

/** Display only: quotes elements that a shell would split or interpret. */
function quote(arg: string): string {
  return SAFE_ARG.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function planText(plan: ActionPlan, argv: readonly string[]): string {
  return [
    `action:  ${plan.action}`,
    `key:     ${plan.key}`,
    `project: ${plan.project}`,
    `profile: ${plan.profile}`,
    ...(plan.branch === null ? [] : [`branch:  ${plan.branch}`]),
    ...(plan.cwd === null ? [] : [`cwd:     ${plan.cwd}`]),
    `command: ${argv.map(quote).join(" ")}`,
    "prompt (stdin):",
    ...plan.prompt.split("\n").map((line) => `  ${line}`),
  ].join("\n");
}

function planJson(plan: ActionPlan, argv: readonly string[]): Record<string, unknown> {
  return {
    action: plan.action,
    key: plan.key,
    project: plan.project,
    profile: plan.profile,
    branch: plan.branch,
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
    branch: result.branch,
    worktree_path: result.worktreePath,
    metadata: result.metadata,
  };
}

function envelope(cliVersion: string, ok: Record<string, unknown>): string {
  return JSON.stringify(
    { cli_version: cliVersion, protocol: { minimum: DO_CONTRACT_VERSION, maximum: DO_CONTRACT_VERSION }, ok },
    null,
    2,
  );
}

async function logged<T>(logger: Logger, options: DoOptions, body: () => Promise<T>): Promise<T> {
  logger.info("do_start", {
    key: options.key,
    action: options.action,
    dry_run: options.dryRun,
    confirmed_by: options.yes ? "yes" : "tty",
  });
  try {
    return await body();
  } catch (error) {
    if (error instanceof ActionError) {
      logger.error("do_refused", { key: options.key, action: options.action, code: error.code, message: error.message });
    }
    throw error;
  }
}

/** Throws `ActionError` for every refusal; returns the text for stdout otherwise. */
export async function runDo(config: PluginConfig, options: DoOptions, deps: DoDeps): Promise<DoOutput> {
  const { logger } = deps;
  return logged(logger, options, async () => {
    const { row, warnings, sessions } = await resolveRow(config, options.key, options.project, deps);
    const plan = await planLaunch(options.action, row, config, { profile: options.profile, sessions });
    const argv = displayArgv(config.global.pohunek.bin, plan);
    logger.info("do_plan", { key: plan.key, action: plan.action, profile: plan.profile, branch: plan.branch, cwd: plan.cwd, argv });

    if (options.dryRun) {
      const stdout = options.json
        ? envelope(deps.cliVersion, { dry_run: true, plan: planJson(plan, argv) })
        : `dry run: nothing was executed\n${planText(plan, argv)}`;
      return { stdout, warnings };
    }
    if (!options.yes) {
      if (deps.confirm === null) {
        throw new ActionError("confirmation_required", "no terminal to confirm on: pass --yes after reviewing --dry-run");
      }
      console.error(planText(plan, argv));
      if (!(await deps.confirm("Run this command?"))) {
        throw new ActionError("confirmation_required", "not confirmed; nothing was executed");
      }
    }
    const result = await executePlan(plan, deps.pohunek, config);
    logger.info("do_done", { key: plan.key, action: plan.action, profile: plan.profile, session_id: result.sessionId });
    const stdout = options.json
      ? envelope(deps.cliVersion, { dry_run: false, plan: planJson(plan, argv), result: resultJson(result) })
      : `started session ${result.sessionId} (${result.name ?? plan.name}) for ${plan.key}`;
    return { stdout, warnings };
  });
}
