// `pohunek-work do <key> <action>`: runs one write action on one row.
// Fresh data, typed refusals, the exact argv shown before anything runs.
import { executeAttach, planAttach } from "../actions/attach.ts";
import { executeReady, planReady } from "../actions/github.ts";
import { displayArgv, executePlan, planLaunch } from "../actions/launch.ts";
import { resolveRow } from "../actions/resolve.ts";
import {
  ActionError,
  DO_CONTRACT_VERSION,
  isLaunchAction,
  type ActionPlan,
  type ActionResult,
  type AttachPlan,
  type DoAction,
  type ReadyPlan,
} from "../actions/types.ts";
import type { Logger } from "../log.ts";
import { toAsciiLines } from "../output/sanitize.ts";
import type { Exec } from "../util/exec.ts";
import type { ListDeps } from "./list.ts";
import type { PluginConfig } from "../types/config.ts";

export interface DoOptions {
  readonly key: string;
  readonly action: DoAction;
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
  /** Runs non-pohunek commands (`gh`). */
  readonly exec: Exec;
  /** Stdin and stdout are a terminal, so `attach` can hand it over. */
  readonly terminal: boolean;
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

function commandLine(argv: readonly string[]): string {
  return argv.map(quote).join(" ");
}

function planText(plan: ActionPlan, argv: readonly string[]): string {
  return [
    `action:  ${plan.action}`,
    `key:     ${plan.key}`,
    `project: ${plan.project}`,
    `profile: ${plan.profile}`,
    ...(plan.branch === null ? [] : [`branch:  ${plan.branch}`]),
    ...(plan.baseBranch === null ? [] : [`from:    ${plan.baseBranch} (fetched from origin)`]),
    ...(plan.expectedHead === null ? [] : [`head:    ${plan.expectedHead} (checked after the launch)`]),
    ...(plan.cwd === null ? [] : [`cwd:     ${plan.cwd}`]),
    `command: ${commandLine(argv)}`,
    "prompt (stdin):",
    ...plan.prompt.split("\n").map((line) => `  ${line}`),
  ].join("\n");
}

/**
 * Text for the terminal in strict ASCII: the plan carries provider text (titles
 * in the prompt, branch names, session names). JSON output and the prompt sent
 * on stdin stay unchanged.
 */
function display(text: string): string {
  return toAsciiLines(text).join("\n");
}

function planJson(plan: ActionPlan, argv: readonly string[]): Record<string, unknown> {
  return {
    action: plan.action,
    key: plan.key,
    project: plan.project,
    profile: plan.profile,
    branch: plan.branch,
    // Only review plans have a base branch and an expected head; other launch plans omit both keys.
    ...(plan.baseBranch === null ? {} : { base_branch: plan.baseBranch }),
    ...(plan.expectedHead === null ? {} : { expected_head: plan.expectedHead }),
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
    ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }),
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

/** Shows the plan and asks unless `--yes`; refuses without a terminal or an explicit yes. */
async function confirmPlan(options: DoOptions, deps: DoDeps, text: string): Promise<void> {
  if (options.yes) return;
  if (deps.confirm === null) {
    throw new ActionError("confirmation_required", "no terminal to confirm on: pass --yes after reviewing --dry-run");
  }
  console.error(display(text));
  if (!(await deps.confirm("Run this command?"))) {
    throw new ActionError("confirmation_required", "not confirmed; nothing was executed");
  }
}

async function runLaunch(config: PluginConfig, options: DoOptions, deps: DoDeps, action: ActionPlan["action"]): Promise<DoOutput> {
  const { logger } = deps;
  const { row, warnings, sessions } = await resolveRow(config, options.key, options.project, deps);
  const plan = await planLaunch(action, row, config, { profile: options.profile, sessions, github: deps.github });
  const argv = displayArgv(config.global.pohunek.bin, plan);
  logger.info("do_plan", { key: plan.key, action: plan.action, profile: plan.profile, branch: plan.branch, cwd: plan.cwd, argv });

  if (options.dryRun) {
    const stdout = options.json
      ? envelope(deps.cliVersion, { dry_run: true, plan: planJson(plan, argv) })
      : display(`dry run: nothing was executed\n${planText(plan, argv)}`);
    return { stdout, warnings };
  }
  await confirmPlan(options, deps, planText(plan, argv));
  const result = await executePlan(plan, deps.pohunek, config);
  logger.info("do_done", { key: plan.key, action: plan.action, profile: plan.profile, session_id: result.sessionId, warnings: [...result.warnings] });
  const stdout = options.json
    ? envelope(deps.cliVersion, { dry_run: false, plan: planJson(plan, argv), result: resultJson(result) })
    : display(`started session ${result.sessionId} (${result.name ?? plan.name}) for ${plan.key}`);
  return { stdout, warnings: [...warnings, ...result.warnings.map((kind) => `pohunek launch warning: ${kind}`)] };
}

function readyText(plan: ReadyPlan): string {
  return [
    "action:  ready",
    `key:     ${plan.key}`,
    `project: ${plan.project}`,
    `pull request: ${plan.pullRequest}`,
    `command: ${commandLine(plan.argv)}`,
    `verify:  ${commandLine(plan.verifyArgv)}`,
  ].join("\n");
}

function readyJson(plan: ReadyPlan): Record<string, unknown> {
  return {
    action: plan.action,
    key: plan.key,
    project: plan.project,
    pull_request: plan.pullRequest,
    argv: plan.argv,
    verify_argv: plan.verifyArgv,
  };
}

async function runReady(config: PluginConfig, options: DoOptions, deps: DoDeps): Promise<DoOutput> {
  const { logger } = deps;
  const { row, warnings } = await resolveRow(config, options.key, options.project, deps);
  const plan = planReady(row, config);
  logger.info("do_plan", { key: plan.key, action: plan.action, argv: [...plan.argv], verify_argv: [...plan.verifyArgv] });
  if (options.dryRun) {
    const stdout = options.json
      ? envelope(deps.cliVersion, { dry_run: true, plan: readyJson(plan) })
      : display(`dry run: nothing was executed\n${readyText(plan)}`);
    return { stdout, warnings };
  }
  await confirmPlan(options, deps, readyText(plan));
  await executeReady(plan, deps.exec, config);
  logger.info("do_done", { key: plan.key, action: plan.action, pull_request: plan.pullRequest, is_draft: false });
  const stdout = options.json
    ? envelope(deps.cliVersion, { dry_run: false, plan: readyJson(plan), result: { pull_request: plan.pullRequest, is_draft: false } })
    : display(`${plan.pullRequest} is ready for review (re-read: not a draft)`);
  return { stdout, warnings };
}

function attachText(plan: AttachPlan): string {
  return [
    "action:  attach",
    `key:     ${plan.key}`,
    `project: ${plan.project}`,
    `session: ${plan.sessionId}`,
    `command: ${commandLine(plan.argv)}`,
  ].join("\n");
}

/** Not a write, so there is no confirmation: the terminal goes to the session until the owner detaches. */
async function runAttach(config: PluginConfig, options: DoOptions, deps: DoDeps): Promise<DoOutput> {
  const { logger } = deps;
  const { row, warnings } = await resolveRow(config, options.key, options.project, deps);
  const plan = planAttach(row, config);
  logger.info("do_plan", { key: plan.key, action: plan.action, session_id: plan.sessionId, argv: [...plan.argv] });
  if (options.dryRun) {
    const stdout = options.json
      ? envelope(deps.cliVersion, {
          dry_run: true,
          plan: { action: plan.action, key: plan.key, project: plan.project, session_id: plan.sessionId, argv: plan.argv },
        })
      : display(`dry run: nothing was executed\n${attachText(plan)}`);
    return { stdout, warnings };
  }
  if (!deps.terminal) {
    throw new ActionError("no_terminal", "attach needs a terminal on stdin and stdout");
  }
  for (const warning of warnings) console.error(display(warning));
  await executeAttach(plan, deps.pohunek);
  logger.info("do_done", { key: plan.key, action: plan.action, session_id: plan.sessionId });
  return { stdout: display(`detached from session ${plan.sessionId}`), warnings: [] };
}

/** Throws `ActionError` for every refusal; returns the text for stdout otherwise. */
export async function runDo(config: PluginConfig, options: DoOptions, deps: DoDeps): Promise<DoOutput> {
  return logged(deps.logger, options, async () => {
    const { action } = options;
    if (action === "merge") {
      // D10: merging is never delegated; nothing is read or run.
      throw new ActionError("not_supported", "merge is not supported: merging stays manual (merge on GitHub yourself)");
    }
    if (action === "ready") return runReady(config, options, deps);
    if (action === "attach") return runAttach(config, options, deps);
    if (isLaunchAction(action)) return runLaunch(config, options, deps, action);
    throw new ActionError("not_supported", `unknown action ${String(action)}`);
  });
}
