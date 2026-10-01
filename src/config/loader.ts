import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  GlobalConfig,
  GithubConfig,
  IdentityConfig,
  LinearConfig,
  LogConfig,
  NotifyConfig,
  PluginConfig,
  PohunekConfig,
  PolicyConfig,
  ProfilesConfig,
  ProjectConfig,
  WatchConfig,
} from "../types/config.ts";
import { estimateRequestNodes, GITHUB_MAX_NODES } from "../util/github-budget.ts";
import { ConfigError } from "./errors.ts";
import {
  fail,
  isTable,
  readAbsolutePath,
  readHttpsUrl,
  readNonNegativeNumber,
  readPositiveInt,
  readRepo,
  readString,
  readStringArray,
  readStringMapTable,
  rejectUnknownKeys,
  requireTable,
  type Table,
} from "./validate.ts";

export const GLOBAL_FILE = "config.toml";
export const PROJECTS_DIR = "projects";
const TOML_SUFFIX = ".toml";

async function readToml(path: string, label: string): Promise<Table> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ConfigError(label, "", `${label}: file not found at ${path}`);
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch {
    throw new ConfigError(label, "", `${label}: is not valid TOML`);
  }
  if (!isTable(parsed)) throw new ConfigError(label, "", `${label}: must contain a TOML table`);
  return parsed;
}

function parseIdentity(root: Table, file: string): IdentityConfig {
  const table = requireTable(root, "identity", file);
  const path = ["identity"];
  rejectUnknownKeys(table, ["github_login", "agent_identities", "review_teams"], file, path);
  return {
    githubLogin: readString(table, "github_login", file, path),
    agentIdentities: readStringArray(table, "agent_identities", file, path),
    reviewTeams: readStringArray(table, "review_teams", file, path),
  };
}

function parseGithub(root: Table, file: string): GithubConfig {
  const table = requireTable(root, "github", file);
  const path = ["github"];
  rejectUnknownKeys(table, [
    "endpoint",
    "gh_bin",
    "timeout_ms",
    "pull_request_page_size",
    "nested_page_size",
    "thread_comment_page_size",
  ], file, path);
  const config: GithubConfig = {
    endpoint: readHttpsUrl(table, "endpoint", file, path),
    ghBin: readAbsolutePath(table, "gh_bin", file, path),
    timeoutMs: readPositiveInt(table, "timeout_ms", file, path),
    pullRequestPageSize: readPositiveInt(table, "pull_request_page_size", file, path),
    nestedPageSize: readPositiveInt(table, "nested_page_size", file, path),
    threadCommentPageSize: readPositiveInt(table, "thread_comment_page_size", file, path),
  };
  // The authored and the directly requested searches always run in one request.
  if (estimateRequestNodes(config, 2) > GITHUB_MAX_NODES) {
    throw fail(
      file,
      [...path, "pull_request_page_size"],
      `with nested_page_size and thread_comment_page_size exceeds the GitHub limit of ${GITHUB_MAX_NODES.toString()} nodes per request; lower the page sizes`,
    );
  }
  return config;
}

function parseLinear(root: Table, file: string): LinearConfig {
  const table = requireTable(root, "linear", file);
  const path = ["linear"];
  rejectUnknownKeys(
    table,
    ["endpoint", "secret_tool_bin", "keyring_service", "keyring_key", "timeout_ms", "page_size"],
    file,
    path,
  );
  return {
    endpoint: readHttpsUrl(table, "endpoint", file, path),
    secretToolBin: readAbsolutePath(table, "secret_tool_bin", file, path),
    keyringService: readString(table, "keyring_service", file, path),
    keyringKey: readString(table, "keyring_key", file, path),
    timeoutMs: readPositiveInt(table, "timeout_ms", file, path),
    pageSize: readPositiveInt(table, "page_size", file, path),
  };
}

function parsePohunek(root: Table, file: string): PohunekConfig {
  const table = requireTable(root, "pohunek", file);
  const path = ["pohunek"];
  rejectUnknownKeys(table, ["bin", "timeout_ms", "notifications_page_size"], file, path);
  return {
    bin: readAbsolutePath(table, "bin", file, path),
    timeoutMs: readPositiveInt(table, "timeout_ms", file, path),
    notificationsPageSize: readPositiveInt(table, "notifications_page_size", file, path),
  };
}

function parseWatch(root: Table, file: string): WatchConfig {
  const table = requireTable(root, "watch", file);
  const path = ["watch"];
  rejectUnknownKeys(table, ["poll_interval_secs"], file, path);
  return { pollIntervalSecs: readPositiveInt(table, "poll_interval_secs", file, path) };
}

function parseNotify(root: Table, file: string): NotifyConfig {
  const table = requireTable(root, "notify", file);
  const path = ["notify"];
  rejectUnknownKeys(table, ["command"], file, path);
  return { command: readAbsolutePath(table, "command", file, path) };
}

function parseLog(root: Table, file: string): LogConfig {
  const table = requireTable(root, "log", file);
  const path = ["log"];
  rejectUnknownKeys(table, ["max_string_length"], file, path);
  return { maxStringLength: readPositiveInt(table, "max_string_length", file, path) };
}

function parsePolicy(root: Table, file: string): PolicyConfig {
  const table = requireTable(root, "policy", file);
  const path = ["policy"];
  rejectUnknownKeys(table, ["delegable", "max_active_tasks", "daily_cost_ceiling_usd"], file, path);
  return {
    delegable: readStringArray(table, "delegable", file, path),
    maxActiveTasks: readNonNegativeNumber(table, "max_active_tasks", file, path),
    dailyCostCeilingUsd: readNonNegativeNumber(table, "daily_cost_ceiling_usd", file, path),
  };
}

function parseProfiles(root: Table, file: string): ProfilesConfig {
  return readStringMapTable(requireTable(root, "profiles", file), file, ["profiles"]);
}

function parseGlobal(root: Table, file: string): GlobalConfig {
  rejectUnknownKeys(
    root,
    ["identity", "github", "linear", "pohunek", "watch", "notify", "log", "policy", "profiles"],
    file,
    [],
  );
  return {
    identity: parseIdentity(root, file),
    github: parseGithub(root, file),
    linear: parseLinear(root, file),
    pohunek: parsePohunek(root, file),
    watch: parseWatch(root, file),
    notify: parseNotify(root, file),
    log: parseLog(root, file),
    policy: parsePolicy(root, file),
    profiles: parseProfiles(root, file),
  };
}

// A named group `key` that is not preceded by an escaping backslash.
const KEY_GROUP = /(?<!\\)\(\?<key>/;

function compileBranchPattern(source: string, file: string): RegExp {
  const path = ["project", "branch_pattern"];
  const converted = source.replaceAll("(?P<", "(?<");
  let pattern: RegExp;
  try {
    pattern = new RegExp(converted);
  } catch {
    throw fail(file, path, "is not a valid regular expression");
  }
  if (!KEY_GROUP.test(converted)) throw fail(file, path, "must contain a named group (?P<key>...)");
  return pattern;
}

function parseProject(root: Table, name: string): ProjectConfig {
  const file = `${PROJECTS_DIR}/${name}${TOML_SUFFIX}`;
  rejectUnknownKeys(root, ["project", "policy", "profiles"], file, []);
  const table = requireTable(root, "project", file);
  const path = ["project"];
  rejectUnknownKeys(
    table,
    ["pohunek_label", "repo", "linear_team", "branch_pattern", "ignored_checks", "ai_reviewers", "paused_states"],
    file,
    path,
  );
  const pohunekLabel = readString(table, "pohunek_label", file, path);
  if (pohunekLabel !== name) {
    throw fail(file, [...path, "pohunek_label"], "must equal the file name without extension");
  }
  const branchPatternSource = readString(table, "branch_pattern", file, path);
  return {
    name,
    pohunekLabel,
    repo: readRepo(table, "repo", file, path),
    linearTeam: readString(table, "linear_team", file, path),
    branchPattern: compileBranchPattern(branchPatternSource, file),
    branchPatternSource,
    ignoredChecks: readStringArray(table, "ignored_checks", file, path),
    aiReviewers: readStringArray(table, "ai_reviewers", file, path),
    pausedStates: readStringArray(table, "paused_states", file, path),
    policy: "policy" in root ? parsePolicy(root, file) : null,
    profiles: "profiles" in root ? parseProfiles(root, file) : null,
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function listProjectNames(configDir: string): Promise<string[]> {
  const dir = join(configDir, PROJECTS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (isNotFound(error)) throw new ConfigError(PROJECTS_DIR, "", `${PROJECTS_DIR}: directory not found at ${dir}`);
    throw error;
  }
  const names = entries
    .filter((entry) => entry.endsWith(TOML_SUFFIX))
    .map((entry) => basename(entry, TOML_SUFFIX))
    .sort();
  if (names.length === 0) throw new ConfigError(PROJECTS_DIR, "", `${PROJECTS_DIR}: no *.toml project files in ${dir}`);
  return names;
}

export async function loadProjectConfig(configDir: string, name: string): Promise<ProjectConfig> {
  const label = `${PROJECTS_DIR}/${name}${TOML_SUFFIX}`;
  const root = await readToml(join(configDir, PROJECTS_DIR, `${name}${TOML_SUFFIX}`), label);
  return parseProject(root, name);
}

export async function loadConfig(configDir: string): Promise<PluginConfig> {
  const root = await readToml(join(configDir, GLOBAL_FILE), GLOBAL_FILE);
  const global = parseGlobal(root, GLOBAL_FILE);
  const names = await listProjectNames(configDir);
  const projects = await Promise.all(names.map((name) => loadProjectConfig(configDir, name)));
  return { configDir, global, projects };
}
