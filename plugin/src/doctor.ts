// `pohunek-work doctor`: verifies configuration, pohunek, project matching,
// GitHub authentication and the Linear keyring entry. Every failure mode has a
// distinct code and exit code. The optional launcher requirements are reported
// as advisory `warn` lines that never change the exit code. No secret value is
// read, kept or printed.

import { ConfigError, loadConfig as defaultLoadConfig } from "./config/index.ts";
import {
  createPohunekClient as defaultCreatePohunekClient,
  parseOriginRepo,
} from "./sources/pohunek.ts";
import { keyringEntryPresent as defaultKeyringEntryPresent } from "./sources/keyring.ts";
import { runLauncherChecks, type LauncherProbe } from "./launcher-doctor.ts";
import type { LinearConfig, PluginConfig, ProjectConfig } from "./types/config.ts";
import type { PohunekProject } from "./types/sources.ts";
import { exec as defaultExec, SpawnError, type Exec } from "./util/exec.ts";

export const DOCTOR_EXIT_CODES = {
  config_invalid: 10,
  pohunek_unreachable: 11,
  pohunek_origin_environment: 12,
  project_missing: 13,
  project_label_mismatch: 14,
  project_origin_mismatch: 15,
  github_unauthenticated: 16,
  linear_keyring_missing: 17,
  linear_keyring_unavailable: 18,
  pohunek_protocol: 19,
} as const;

export type DoctorFailureCode = keyof typeof DOCTOR_EXIT_CODES;
/** `warn` marks an advisory finding: the check counts as passed and the exit code is unaffected. */
export type DoctorCode = "ok" | "warn" | DoctorFailureCode;

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly code: DoctorCode;
  readonly message: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly exitCode: number;
}

export interface DoctorDeps {
  readonly configDir: string;
  readonly exec?: Exec;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly loadConfig?: typeof defaultLoadConfig;
  readonly createPohunekClient?: typeof defaultCreatePohunekClient;
  readonly keyringEntryPresent?: typeof defaultKeyringEntryPresent;
  /** Adds the launcher requirement checks; absent means they are not run. */
  readonly launcher?: LauncherProbe;
}

function pass(name: string, message: string): DoctorCheck {
  return { name, ok: true, code: "ok", message };
}

function advisory(name: string, message: string): DoctorCheck {
  return { name, ok: true, code: "warn", message };
}

function failed(name: string, code: DoctorFailureCode, message: string): DoctorCheck {
  return { name, ok: false, code, message };
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Names the issue source on every project line, whether the project passes or fails. */
function checkProject(project: ProjectConfig, registered: readonly PohunekProject[]): DoctorCheck {
  const check = checkRegistration(project.name, project.pohunekLabel, project.repo, registered);
  return { ...check, message: `${check.message} [issue source: ${project.issueSource.kind}]` };
}

function checkRegistration(
  name: string,
  label: string,
  repo: string,
  registered: readonly PohunekProject[],
): DoctorCheck {
  const checkName = `project ${name}`;
  const byLabel = registered.find((project) => project.label === label);
  if (byLabel === undefined) {
    const sameOrigin = registered.filter((project) => {
      const resolved = project.originUrl === null ? null : parseOriginRepo(project.originUrl);
      return resolved !== null && sameRepo(resolved, repo);
    });
    const [only] = sameOrigin;
    if (sameOrigin.length === 1 && only !== undefined) {
      return failed(
        checkName,
        "project_label_mismatch",
        `config expects pohunek label "${label}" but the project for ${repo} is registered as "${only.label}"; rename it back or rename the project file`,
      );
    }
    return failed(
      checkName,
      "project_missing",
      `no pohunek project with label "${label}"; see \`pohunek project list\``,
    );
  }
  const resolved = byLabel.originUrl === null ? null : parseOriginRepo(byLabel.originUrl);
  if (resolved === null || !sameRepo(resolved, repo)) {
    return failed(
      checkName,
      "project_origin_mismatch",
      `pohunek project "${label}" origin resolves to ${resolved ?? "no GitHub repository"}, config expects ${repo}`,
    );
  }
  return pass(checkName, `label "${label}" matches ${repo}`);
}

async function checkGithub(config: PluginConfig, run: Exec): Promise<DoctorCheck> {
  const name = "github auth";
  const { ghBin, timeoutMs } = config.global.github;
  try {
    const result = await run([ghBin, "auth", "status"], { timeoutMs });
    if (result.timedOut) {
      return failed(name, "github_unauthenticated", `${ghBin} auth status timed out after ${String(timeoutMs)} ms`);
    }
    if (result.exitCode !== 0) {
      return failed(name, "github_unauthenticated", `${ghBin} auth status exited with code ${String(result.exitCode)}; run \`gh auth login\``);
    }
    return pass(name, "gh is authenticated");
  } catch (error) {
    if (error instanceof SpawnError) {
      return failed(name, "github_unauthenticated", `cannot start ${ghBin}`);
    }
    throw error;
  }
}

async function checkKeyring(
  linear: LinearConfig,
  presence: typeof defaultKeyringEntryPresent,
  run: Exec,
): Promise<DoctorCheck> {
  const name = "linear keyring";
  const { keyringService, keyringKey } = linear;
  const entry = `service "${keyringService}", key "${keyringKey}"`;
  const result = await presence(linear, { exec: run });
  if (result.present) {
    return pass(name, `entry present (${entry})`);
  }
  if (result.kind === "not_found") {
    return failed(name, "linear_keyring_missing", `no keyring entry for ${entry}`);
  }
  return failed(
    name,
    "linear_keyring_unavailable",
    `keyring is ${result.kind === "locked" ? "locked" : "unavailable"}; entry ${entry} could not be checked`,
  );
}

async function launcherChecks(deps: DoctorDeps, config: PluginConfig | null): Promise<DoctorCheck[]> {
  if (deps.launcher === undefined) return [];
  const githubIssuePicker = config?.projects.some((project) => project.issueSource.kind === "github") ?? false;
  const found = await runLauncherChecks(deps.launcher, githubIssuePicker);
  return found.map((check) => (check.ok ? pass(check.name, check.message) : advisory(check.name, check.message)));
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const run = deps.exec ?? defaultExec;
  const load = deps.loadConfig ?? defaultLoadConfig;
  const createClient = deps.createPohunekClient ?? defaultCreatePohunekClient;
  const presence = deps.keyringEntryPresent ?? defaultKeyringEntryPresent;
  const checks: DoctorCheck[] = [];

  let config: PluginConfig;
  try {
    config = await load(deps.configDir);
  } catch (error) {
    if (error instanceof ConfigError) {
      checks.push(failed("config", "config_invalid", `${error.file}: key ${error.key}: ${error.message}`));
      // The launcher requirements do not depend on the plugin configuration.
      checks.push(...(await launcherChecks(deps, null)));
      return finish(checks);
    }
    throw error;
  }
  checks.push(pass("config", `${String(config.projects.length)} project file(s) loaded`));

  const client = createClient(config.global.pohunek, {
    exec: run,
    ...(deps.env === undefined ? {} : { env: deps.env }),
  });
  const [projects, sessions, notifications] = await Promise.all([
    client.listProjects(),
    client.listSessions(),
    client.listNotifications(),
  ]);
  // `list` needs all three calls, so an unreadable session or notification list is a pohunek failure too.
  const unreadable = sessions.ok ? notifications : sessions;
  if (projects.ok && !unreadable.ok) {
    checks.push(failed("pohunek", "pohunek_unreachable", `${unreadable.code}: ${unreadable.message}`));
  } else if (projects.ok) {
    checks.push(pass("pohunek", `reachable, ${String(projects.data.length)} project(s) registered`));
    for (const project of config.projects) {
      checks.push(checkProject(project, projects.data));
    }
  } else if (projects.code === "origin_environment") {
    checks.push(
      failed(
        "pohunek",
        "pohunek_origin_environment",
        "POHUNEK_SESSION_ID and POHUNEK_DAEMON_ID are inconsistent: set both or unset both; nothing was changed",
      ),
    );
  } else if (projects.code === "protocol_mismatch") {
    checks.push(failed("pohunek", "pohunek_protocol", projects.message));
  } else {
    checks.push(failed("pohunek", "pohunek_unreachable", `${projects.code}: ${projects.message}`));
  }

  checks.push(await checkGithub(config, run));
  if (config.projects.some((project) => project.issueSource.kind === "linear")) {
    const linear = config.global.linear;
    checks.push(
      linear === null
        ? failed("linear keyring", "config_invalid", "config.toml: [linear] is required by a project with issue_source = \"linear\"")
        : await checkKeyring(linear, presence, run),
    );
  } else {
    checks.push(pass("linear keyring", "not needed: no project uses issue_source = \"linear\""));
  }
  checks.push(...(await launcherChecks(deps, config)));
  return finish(checks);
}

function finish(checks: readonly DoctorCheck[]): DoctorReport {
  const firstFailure = checks.find((check) => !check.ok);
  const exitCode =
    firstFailure === undefined || firstFailure.code === "ok" || firstFailure.code === "warn" ? 0 : DOCTOR_EXIT_CODES[firstFailure.code];
  return { checks, exitCode };
}

export function formatDoctorReport(report: DoctorReport): string {
  return report.checks
    .map((check) => `${check.ok ? (check.code === "warn" ? "warn" : "ok  ") : "FAIL"} ${check.code} ${check.name}: ${check.message}`)
    .join("\n");
}
