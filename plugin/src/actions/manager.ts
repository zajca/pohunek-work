// `pohunek-work manager start`: plans one manager session for a set of
// configured projects from fresh pohunek data. Every refusal happens here,
// before anything runs, so a dry run refuses exactly like a real run.
import { stat } from "node:fs/promises";
import { selectProjects } from "../commands/list.ts";
import { isLiveSession, ROLE_KEY, type PohunekClient } from "../sources/pohunek.ts";
import type { ManagerConfig, PluginConfig } from "../types/config.ts";
import type { PohunekSession, SourceFailure } from "../types/sources.ts";
import { metaArgs, requireProfileName, type SessionLaunch } from "./launch.ts";
import { readTemplate, renderTemplate } from "./prompt.ts";
import { ActionError } from "./types.ts";

/** Version of the `manager start --json` contract; bumped on any incompatible change. */
export const MANAGER_CONTRACT_VERSION = 1;

/** `work.role` of a manager session. */
const MANAGER_ROLE = "manager";
/** Session metadata key with the labels a manager covers, sorted and joined by `LABEL_SEPARATOR`, or `ALL_PROJECTS`. */
const PROJECTS_KEY = "work.manager.projects";
const ALL_PROJECTS = "*";
const LABEL_SEPARATOR = ",";
/** A label a manager can carry in its metadata, name and prompt: never the separator, the wildcard, a space or an option. */
const MANAGER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Core rejects a longer session name with `bad_request` (observed on the pinned release). */
const SESSION_NAME_MAX_BYTES = 128;
const SESSION_NAME_PREFIX = "manager:";

export interface ManagerStartOptions {
  /** Labels of `--project`, without duplicates; null for `--all`. */
  readonly projects: readonly string[] | null;
  /** `--profile`; overrides `[manager] profile`. */
  readonly profile: string | null;
}

/** Everything one manager launch will do, computed before anything runs. */
export interface ManagerPlan extends SessionLaunch {
  readonly all: boolean;
  /** Sorted labels of the requested projects; for `all`, the configured projects that pass the registration check now. */
  readonly projects: readonly string[];
  readonly profile: string;
  readonly cwd: string;
  readonly name: string;
  /** One line per configured project `all` leaves out. */
  readonly warnings: readonly string[];
}

/** The projects of a plan in words, for the prompt and the terminal. */
export function scopeOf(plan: Pick<ManagerPlan, "all" | "projects">): string {
  if (plan.all) return "every configured project";
  return `${plan.projects.length === 1 ? "project" : "projects"} ${plan.projects.join(", ")}`;
}

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

/** Null when `workdir` is an existing directory, otherwise why it is not; `doctor` reports the same finding. */
export async function workdirProblem(workdir: string): Promise<string | null> {
  try {
    if ((await stat(workdir)).isDirectory()) return null;
    return `[manager] workdir ${workdir} is not a directory`;
  } catch (error) {
    const code = errorCode(error);
    if (code === null) throw error;
    if (code === "ENOENT" || code === "ENOTDIR") return `[manager] workdir ${workdir} does not exist; create it, manager start does not`;
    return `[manager] workdir ${workdir} cannot be read (${code})`;
  }
}

function requireLabels(labels: readonly string[]): void {
  const invalid = labels.filter((label) => !MANAGER_LABEL.test(label));
  if (invalid.length > 0) {
    throw new ActionError(
      "invalid_value",
      `manager start refused: ${invalid.map((label) => JSON.stringify(label)).join(", ")} ${invalid.length === 1 ? "is not a project label" : "are not project labels"} a manager can carry (letters, digits, ., _ and -, starting with a letter or digit)`,
    );
  }
}

/** The labels a live manager covers; null for every project (`*`, or no project set at all). */
function coveredBy(session: PohunekSession): readonly string[] | null {
  const value = session.metadata[PROJECTS_KEY];
  return value === undefined || value === ALL_PROJECTS ? null : value.split(LABEL_SEPARATOR);
}

function overlaps(a: readonly string[] | null, b: readonly string[] | null): boolean {
  return a === null || b === null || a.some((label) => b.includes(label));
}

function requireNoOverlappingManager(sessions: readonly PohunekSession[], requested: readonly string[] | null): void {
  const overlapping = sessions.filter(
    (session) => isLiveSession(session) && session.metadata[ROLE_KEY] === MANAGER_ROLE && overlaps(coveredBy(session), requested),
  );
  if (overlapping.length === 0) return;
  const described = overlapping.map((session) => {
    const value = session.metadata[PROJECTS_KEY];
    return `${session.id} (${value === undefined ? `no ${PROJECTS_KEY}, so every project` : `${PROJECTS_KEY}=${JSON.stringify(value)}`})`;
  });
  throw new ActionError(
    "already_running",
    `manager start refused: live manager session ${described.join(", ")} overlaps the requested ${requested === null ? "--all (every configured project)" : `projects ${requested.join(", ")}`}; ` +
      `attach with: ${overlapping.map((session) => `pohunek attach ${session.id}`).join(" or ")}`,
  );
}

function unavailable(read: string, failure: SourceFailure): ActionError {
  return new ActionError("source_unavailable", `manager start refused: pohunek ${read} failed (${failure.code}: ${failure.message}); nothing was launched`);
}

function sessionName(all: boolean, projects: readonly string[]): string {
  const name = `${SESSION_NAME_PREFIX}${all ? ALL_PROJECTS : projects.join(LABEL_SEPARATOR)}`;
  if (Buffer.byteLength(name) > SESSION_NAME_MAX_BYTES) {
    throw new ActionError(
      "invalid_value",
      `manager start refused: the session name ${name} is longer than the ${SESSION_NAME_MAX_BYTES.toString()} bytes pohunek accepts; start managers for fewer projects or use --all`,
    );
  }
  return name;
}

/** Builds the plan; throws an `ActionError` and has no side effect otherwise. */
export async function planManagerStart(
  config: PluginConfig,
  manager: ManagerConfig,
  options: ManagerStartOptions,
  pohunek: PohunekClient,
): Promise<ManagerPlan> {
  const profile = requireProfileName(options.profile ?? manager.profile);
  const requested = options.projects === null ? null : [...options.projects].sort();
  if (requested !== null) requireLabels(requested);
  const workdir = await workdirProblem(manager.workdir);
  if (workdir !== null) throw new ActionError("precondition_failed", `manager start refused: ${workdir}`);

  // A launch needs both reads: without the registry no label can be checked, without the sessions no overlap.
  const [registry, sessions] = await Promise.all([pohunek.listProjects(), pohunek.listSessions()]);
  if (!registry.ok) throw unavailable("project list", registry);
  if (!sessions.ok) throw unavailable("session list", sessions);

  const { projects, warnings } = selectProjects(config, registry, requested);
  const selected = projects.map((project) => project.pohunekLabel).sort();
  if (requested !== null) {
    const problems = requested
      .filter((label) => !selected.includes(label))
      .map((label) => {
        const project = config.projects.find((candidate) => candidate.pohunekLabel === label);
        if (project === undefined) return `${label}: no project file for this label`;
        if (!registry.data.some((registered) => registered.label === label)) return `${label}: no pohunek project with this label`;
        return `${label}: origin_url does not resolve to ${project.repo}`;
      });
    if (problems.length > 0) {
      throw new ActionError("precondition_failed", `manager start refused: ${problems.join("; ")} (run doctor); nothing was launched`);
    }
  } else if (selected.length === 0) {
    throw new ActionError("precondition_failed", `manager start refused: no configured project is registered with pohunek under its label and origin (run doctor)${warnings.length > 0 ? `: ${warnings.join("; ")}` : ""}`);
  }
  requireNoOverlappingManager(sessions.data, requested);

  const all = requested === null;
  const name = sessionName(all, selected);
  const metadata = { [ROLE_KEY]: MANAGER_ROLE, [PROJECTS_KEY]: all ? ALL_PROJECTS : selected.join(LABEL_SEPARATOR) };
  const listCommand = ["pohunek-work", "list", "--mine", "--json", ...(all ? [] : selected.flatMap((label) => ["--project", label]))].join(" ");
  const prompt = renderTemplate(await readTemplate("work-manager"), { scope: scopeOf({ all, projects: selected }), list_command: listCommand });
  return {
    all,
    projects: selected,
    profile,
    cwd: manager.workdir,
    name,
    metadata,
    args: [
      "--cwd", manager.workdir,
      "--name", name,
      "--agent", profile,
      ...metaArgs(metadata),
      "--input-stdin",
      "--request-timeout-ms", String(config.global.actions.launchTimeoutMs),
    ],
    prompt,
    warnings: all ? warnings : [],
  };
}
