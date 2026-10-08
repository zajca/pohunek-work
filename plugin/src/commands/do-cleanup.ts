// `pohunek-work do <key> cleanup`: reads the evidence, shows the plan, and
// removes a finished session only with `--yes` and every check holding.
import { executeCleanup, planCleanup, type CleanupPlan, type CleanupResult } from "../actions/cleanup.ts";
import { resolveRow } from "../actions/resolve.ts";
import { ActionError, DO_CONTRACT_VERSION } from "../actions/types.ts";
import { toAsciiLines } from "../output/sanitize.ts";
import type { PluginConfig } from "../types/config.ts";
import type { DoDeps, DoOptions, DoOutput } from "./do.ts";

const SAFE_ARG = /^[A-Za-z0-9_./:=@%+,-]+$/;

function commandLine(argv: readonly string[]): string {
  return argv.map((arg) => (SAFE_ARG.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(" ");
}

/** Terminal text in strict ASCII: file names, branches and session ids are provider text. */
function display(text: string): string {
  return toAsciiLines(text).join("\n");
}

/** Provider text in the text output, escaped so a newline cannot forge a plan line. */
function esc(value: string | null): string {
  return JSON.stringify(value);
}

function planText(plan: CleanupPlan): string {
  const { inventory } = plan;
  return [
    "action:  cleanup",
    `key:     ${plan.key}`,
    `project: ${plan.project}`,
    `session: ${esc(plan.sessionId)} (${esc(plan.state)})`,
    `worktree: ${esc(plan.worktreePath)}`,
    `branch:  ${esc(plan.branch)}`,
    `eligible: ${plan.eligible ? "yes" : "no"}`,
    "checks:",
    ...plan.checks.map((c) => `  [${c.ok ? "ok" : "FAIL"}] ${c.name}: ${c.detail}`),
    "inventory:",
    `  ahead/behind: ${inventory.ahead === null || inventory.behind === null ? "not measured" : `${String(inventory.ahead)}/${String(inventory.behind)}`}`,
    `  diff base: ${inventory.base === null ? "not read" : esc(inventory.base)}`,
    `  diff size: ${inventory.diffBytes === null ? "not read" : `${String(inventory.diffBytes)} bytes`}`,
    `  sharers: ${inventory.sharers.length === 0 ? "none" : inventory.sharers.map((s) => `${esc(s.sessionId)} (${esc(s.state)})`).join(", ")}`,
    `  ignored files that are lost with the worktree (${String(inventory.ignored.length)}):`,
    ...inventory.ignored.map((path) => `    ${esc(path)}`),
    `stop:    ${commandLine(plan.stopArgv)} (only while the session runs)`,
    `remove:  ${commandLine(plan.removeArgv)}`,
  ].join("\n");
}

function planJson(plan: CleanupPlan): Record<string, unknown> {
  return {
    action: plan.action,
    key: plan.key,
    project: plan.project,
    session_id: plan.sessionId,
    worktree_path: plan.worktreePath,
    branch: plan.branch,
    eligible: plan.eligible,
    checks: plan.checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
    inventory: {
      ignored: plan.inventory.ignored,
      ahead: plan.inventory.ahead,
      behind: plan.inventory.behind,
      base: plan.inventory.base,
      diff_bytes: plan.inventory.diffBytes,
      sharers: plan.inventory.sharers.map((s) => ({ session_id: s.sessionId, state: s.state })),
    },
    stop_argv: plan.stopArgv,
    remove_argv: plan.removeArgv,
  };
}

function resultJson(result: CleanupResult): Record<string, unknown> {
  return {
    session_id: result.sessionId,
    stopped: result.stopped,
    removed: result.removed,
    worktrees_removed: result.worktreesRemoved,
    verified_absent: result.verifiedAbsent,
  };
}

function envelope(cliVersion: string, ok: Record<string, unknown>): string {
  return JSON.stringify({ cli_version: cliVersion, protocol: { minimum: DO_CONTRACT_VERSION, maximum: DO_CONTRACT_VERSION }, ok }, null, 2);
}

/** There is no interactive confirmation: the owner reviews `--dry-run`, then passes `--yes`. */
export async function runCleanup(config: PluginConfig, options: DoOptions, deps: DoDeps): Promise<DoOutput> {
  const { logger } = deps;
  // Refused before any read: a run without --yes fetches and reads nothing.
  if (!options.dryRun && !options.yes) {
    throw new ActionError("confirmation_required", "cleanup removes the worktree for good: review --dry-run, then pass --yes");
  }
  const { row, warnings, sessions } = await resolveRow(config, options.key, options.project, options.includeIgnored, deps);
  const cleanupDeps = { pohunek: deps.pohunek, exec: deps.exec };
  const plan = await planCleanup(row, sessions, config, cleanupDeps);
  logger.info("do_plan", {
    key: plan.key,
    action: plan.action,
    session_id: plan.sessionId,
    eligible: plan.eligible,
    failed_checks: plan.checks.filter((c) => !c.ok).map((c) => c.name),
    stop_argv: [...plan.stopArgv],
    remove_argv: [...plan.removeArgv],
  });

  if (options.dryRun) {
    const stdout = options.json
      ? envelope(deps.cliVersion, { dry_run: true, plan: planJson(plan) })
      : display(`dry run: nothing was executed\n${planText(plan)}`);
    return { stdout, warnings };
  }
  const result = await executeCleanup(plan, cleanupDeps, config);
  logger.info("do_done", {
    key: plan.key,
    action: plan.action,
    session_id: result.sessionId,
    stopped: result.stopped,
    worktrees_removed: result.worktreesRemoved,
  });
  const stdout = options.json
    ? envelope(deps.cliVersion, { dry_run: false, plan: planJson(plan), result: resultJson(result) })
    : display(`removed session ${result.sessionId} and its worktree (${String(result.worktreesRemoved)} removed); it is no longer listed`);
  return { stdout, warnings };
}
