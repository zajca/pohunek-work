// `pohunek-work setup [scripts|config|sway]`: installs the rofi/sway launcher
// scripts, the starter configuration and the sway drop-in into the per-user
// XDG locations. Local filesystem writes only; nothing here talks to pohunek.
import { installConfig, installScripts, installSway, type ConfigResult, type FileResult, type ScriptsResult, type SwayResult } from "../setup/install.ts";
import { resolveSetupPaths, type SetupPaths } from "../setup/paths.ts";
import { DEFAULT_SWAY_ISSUE_KEYBIND, DEFAULT_SWAY_KEYBIND, SETUP_CONTRACT_VERSION, SWAY_DROPIN_DIR } from "../setup/settings.ts";

export const SETUP_STEPS = ["all", "scripts", "config", "sway"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface SetupOptions {
  readonly step: SetupStep;
  readonly force: boolean;
  /** `sway` only: print the drop-in instead of writing it. */
  readonly print: boolean;
  readonly keybind: string;
  readonly issueKeybind: string;
  /** `sway` only: bind the issue picker for this project; without it no issue binding is generated. */
  readonly issueProject: string | null;
  readonly json: boolean;
}

export interface SetupDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly cliVersion: string;
}

export interface SetupOutput {
  readonly stdout: string;
}

interface SkippedStep {
  readonly step: "scripts" | "sway";
  readonly reason: string;
}

interface SwaySkipped {
  readonly step: "sway";
  readonly skipped: true;
  readonly reason: string;
}

/** Keybinds the options default to; one source for the command line and the full setup. */
export const DEFAULT_KEYBINDS = { keybind: DEFAULT_SWAY_KEYBIND, issueKeybind: DEFAULT_SWAY_ISSUE_KEYBIND } as const;

const SCRIPTS_SKIPPED_REASON =
  "the rofi launcher scripts need rofi and sway, which are Linux capabilities; run 'pohunek-work setup scripts' to install them anyway";
const SWAY_SKIPPED_REASON = "sway and rofi are optional Linux capabilities; nothing is installed for them on macOS";

/** sway and rofi exist on every platform but macOS. */
function platformHasSway(platform: NodeJS.Platform): boolean {
  return platform !== "darwin";
}

function scriptLine(file: FileResult): string {
  switch (file.outcome) {
    case "created":
    case "overwritten":
      return `installed script: ${file.path}`;
    case "unchanged":
      return `unchanged script: ${file.path}`;
    case "skipped":
      return `skipped (exists, differs; use --force to replace): ${file.path}`;
  }
}

function fileLine(file: FileResult): string {
  switch (file.outcome) {
    case "created":
      return `created: ${file.path}`;
    case "overwritten":
      return `overwritten: ${file.path}`;
    case "unchanged":
      return `unchanged: ${file.path}`;
    case "skipped":
      return `skipped (exists, differs; use --force to replace): ${file.path}`;
  }
}

function renderScripts(result: ScriptsResult): string[] {
  return [...result.files.map(scriptLine), ...result.removed.map((path) => `removed obsolete script: ${path}`)];
}

function renderConfig(result: ConfigResult): string[] {
  return result.files.map(fileLine);
}

function renderSway(paths: SetupPaths, result: SwayResult): string[] {
  if (result.printed) return [];
  const lines: string[] = [];
  switch (result.outcome) {
    case "created":
    case "overwritten":
      lines.push(`wrote sway drop-in: ${result.path}`);
      break;
    case "unchanged":
      lines.push(`unchanged sway drop-in: ${result.path}`);
      break;
    default:
      lines.push(`skipped (exists, differs; use --force to replace): ${result.path}`);
  }
  if (!result.include_present) {
    lines.push(`NOTE: add \`include ${paths.swayConfigDir}/${SWAY_DROPIN_DIR}/*\` to your sway config so the drop-in is loaded.`);
  }
  return lines;
}

function nextSteps(platform: NodeJS.Platform, paths: SetupPaths): string[] {
  if (!platformHasSway(platform)) {
    return [
      `Review ${paths.configDir}/launcher.conf - set 'linear_cli' if you use Linear.`,
      "Install the daemon as a launchd service with `pohunek service install`, or for development run `pohunek daemon start --dev-subprocess --detach`.",
      "Run `pohunek-work doctor` to check the launcher requirements and `pohunek doctor` for the runtime directory, worker executable and launchd domain.",
      "sway and rofi are optional Linux capabilities; `pohunek-work setup sway` is skipped on macOS.",
    ];
  }
  return [
    `Edit ${paths.configDir}/launcher.conf - set 'terminal' (and 'linear_cli' for Linear).`,
    "Pass a project id/label to launchers, for example `pohunek-launch-issue <project> <issue-id> [action]`.",
    `Bind the Linear issue picker with \`pohunek-work setup sway --force --issue-project <project>\` (${DEFAULT_SWAY_ISSUE_KEYBIND} by default); it needs a project.`,
    `Ensure your sway config has: include ${paths.swayConfigDir}/${SWAY_DROPIN_DIR}/*`,
    `Reload sway (swaymsg reload): ${DEFAULT_SWAY_KEYBIND} opens the session switcher.`,
    "Run `pohunek-work doctor` to verify rofi, swaymsg, python3, the terminal and the installed scripts.",
  ];
}

function envelope(cliVersion: string, ok: object): string {
  const body = { cli_version: cliVersion, protocol: { minimum: SETUP_CONTRACT_VERSION, maximum: SETUP_CONTRACT_VERSION }, ok };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function lines(text: readonly string[]): string {
  return text.length === 0 ? "" : `${text.join("\n")}\n`;
}

async function runSway(paths: SetupPaths, options: SetupOptions, deps: SetupDeps): Promise<string> {
  if (!platformHasSway(deps.platform)) {
    const skipped: SwaySkipped = { step: "sway", skipped: true, reason: SWAY_SKIPPED_REASON };
    return options.json ? envelope(deps.cliVersion, skipped) : `skipped sway: ${SWAY_SKIPPED_REASON}\n`;
  }
  const result = await installSway(paths, { ...options, env: deps.env });
  if (options.json) return envelope(deps.cliVersion, { step: "sway", ...result });
  return result.printed ? result.snippet : lines(renderSway(paths, result));
}

async function runAll(paths: SetupPaths, options: SetupOptions, deps: SetupDeps): Promise<string> {
  const hasSway = platformHasSway(deps.platform);
  const scripts = hasSway ? await installScripts(paths, options) : null;
  const config = await installConfig(paths, options);
  const sway = hasSway ? await installSway(paths, { ...options, print: false, ...DEFAULT_KEYBINDS, issueProject: null, env: deps.env }) : null;
  const skipped: SkippedStep[] = hasSway
    ? []
    : [
        { step: "scripts", reason: SCRIPTS_SKIPPED_REASON },
        { step: "sway", reason: SWAY_SKIPPED_REASON },
      ];
  const steps = nextSteps(deps.platform, paths);
  if (options.json) {
    return envelope(deps.cliVersion, {
      step: "all",
      ...(scripts === null ? {} : { scripts }),
      config,
      ...(sway === null ? {} : { sway }),
      skipped,
      next_steps: steps,
    });
  }
  const out = [
    ...(scripts === null ? [] : renderScripts(scripts)),
    ...renderConfig(config),
    ...(sway === null ? [] : renderSway(paths, sway)),
    ...skipped.map((entry) => `skipped ${entry.step}: ${entry.reason}`),
    "",
    "Next steps:",
    ...steps.map((step, index) => `  ${String(index + 1)}. ${step}`),
  ];
  return lines(out);
}

/**
 * Runs one setup step. Throws `SetupPathError` when the install locations cannot be
 * derived from the environment and `SetupIoError` when a file cannot be written.
 */
export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<SetupOutput> {
  const paths = resolveSetupPaths(deps.env);
  switch (options.step) {
    case "scripts": {
      const result = await installScripts(paths, options);
      return { stdout: options.json ? envelope(deps.cliVersion, { step: "scripts", ...result }) : lines(renderScripts(result)) };
    }
    case "config": {
      const result = await installConfig(paths, options);
      return { stdout: options.json ? envelope(deps.cliVersion, { step: "config", ...result }) : lines(renderConfig(result)) };
    }
    case "sway":
      return { stdout: await runSway(paths, options, deps) };
    case "all":
      return { stdout: await runAll(paths, options, deps) };
  }
}
