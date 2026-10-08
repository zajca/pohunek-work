import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  ActionsConfig,
  GlobalConfig,
  GithubConfig,
  GithubProjectStatus,
  IssueSignal,
  IdentityConfig,
  IssueSource,
  LinearConfig,
  LogConfig,
  NotifyConfig,
  PluginConfig,
  PohunekConfig,
  PolicyConfig,
  ProfilesConfig,
  ProjectConfig,
  ReviewsMode,
  TuiConfig,
  TuiInitialView,
  WatchConfig,
} from "../types/config.ts";
import { fitsLinearComplexity, LINEAR_MAX_COMPLEXITY } from "../util/linear-budget.ts";
import { estimateIssueSearchNodes, estimateRequestNodes, GITHUB_MAX_NODES } from "../util/github-budget.ts";
import { ConfigError } from "./errors.ts";
import {
  fail,
  readStringAllowEmpty,
  isTable,
  readAbsolutePath,
  readBoolean,
  readEnum,
  readHttpsUrl,
  readNonNegativeInt,
  readNonEmptyStringArray,
  readNonNegativeNumber,
  readPositiveInt,
  readRepo,
  readString,
  readStringArray,
  readStringMapTable,
  rejectUnknownKeys,
  requireTable,
  type KeyPath,
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

/** GitHub accepts 1 to 100 for every `first` argument. */
const GITHUB_MAX_PAGE_SIZE = 100;

function readGithubPageSize(table: Table, key: string, file: string, path: KeyPath): number {
  const value = readPositiveInt(table, key, file, path);
  if (value > GITHUB_MAX_PAGE_SIZE) {
    throw fail(file, [...path, key], `must not exceed ${GITHUB_MAX_PAGE_SIZE.toString()} (GitHub page size limit)`);
  }
  return value;
}

function parseGithub(root: Table, file: string): GithubConfig {
  const table = requireTable(root, "github", file);
  const path = ["github"];
  rejectUnknownKeys(table, [
    "endpoint",
    "gh_bin",
    "timeout_ms",
    "pull_request_page_size",
    "issue_page_size",
    "nested_page_size",
    "thread_comment_page_size",
    "merged_lookback_days",
  ], file, path);
  const config: GithubConfig = {
    endpoint: readHttpsUrl(table, "endpoint", file, path),
    ghBin: readAbsolutePath(table, "gh_bin", file, path),
    timeoutMs: readPositiveInt(table, "timeout_ms", file, path),
    pullRequestPageSize: readGithubPageSize(table, "pull_request_page_size", file, path),
    issuePageSize: readGithubPageSize(table, "issue_page_size", file, path),
    nestedPageSize: readGithubPageSize(table, "nested_page_size", file, path),
    threadCommentPageSize: readGithubPageSize(table, "thread_comment_page_size", file, path),
    mergedLookbackDays: readPositiveInt(table, "merged_lookback_days", file, path),
  };
  // The authored and the directly requested searches always run in one request. The worst case
  // includes the closing issue references (projects with a GitHub issue source) and the labels
  // (projects with an ignore label): a limit that depends on the project files would make the
  // global file valid or not by what the project files contain.
  if (estimateRequestNodes(config, 2, { closingReferences: true, pullRequestLabels: true }) > GITHUB_MAX_NODES) {
    throw fail(
      file,
      [...path, "pull_request_page_size"],
      `with nested_page_size and thread_comment_page_size exceeds the GitHub limit of ${GITHUB_MAX_NODES.toString()} nodes per request; lower the page sizes`,
    );
  }
  // The project items page is requested only by projects with a project signal; the worst case is
  // validated here for the same reason as above.
  if (estimateIssueSearchNodes(config, { projectItems: true }) > GITHUB_MAX_NODES) {
    throw fail(
      file,
      [...path, "issue_page_size"],
      `with nested_page_size (labels and project items) exceeds the GitHub limit of ${GITHUB_MAX_NODES.toString()} nodes per request; lower the page sizes`,
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
  const config: LinearConfig = {
    endpoint: readHttpsUrl(table, "endpoint", file, path),
    secretToolBin: readAbsolutePath(table, "secret_tool_bin", file, path),
    keyringService: readString(table, "keyring_service", file, path),
    keyringKey: readString(table, "keyring_key", file, path),
    timeoutMs: readPositiveInt(table, "timeout_ms", file, path),
    pageSize: readPositiveInt(table, "page_size", file, path),
  };
  if (!fitsLinearComplexity(config.pageSize, false)) throw linearPageSizeError(file, config.pageSize, false);
  return config;
}

function linearPageSizeError(file: string, pageSize: number, labels: boolean): ConfigError {
  const reason = labels ? "with the label page of a project with an ignore_label " : "";
  return fail(
    file,
    ["linear", "page_size"],
    `${pageSize.toString()} ${reason}exceeds Linear's query complexity limit of ${LINEAR_MAX_COMPLEXITY.toString()} points; lower page_size`,
  );
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
  return { pollIntervalSecs: readTimerValue(table, "poll_interval_secs", MS_PER_SECOND, file, path) };
}

function parseNotify(root: Table, file: string): NotifyConfig {
  const table = requireTable(root, "notify", file);
  const path = ["notify"];
  rejectUnknownKeys(table, ["command", "timeout_ms"], file, path);
  return {
    command: readAbsolutePath(table, "command", file, path),
    timeoutMs: readTimerValue(table, "timeout_ms", 1, file, path),
  };
}

function parseLog(root: Table, file: string): LogConfig {
  const table = requireTable(root, "log", file);
  const path = ["log"];
  rejectUnknownKeys(table, ["max_string_length"], file, path);
  return { maxStringLength: readPositiveInt(table, "max_string_length", file, path) };
}

/** One git ref segment of lowercase letters, digits, `-` and `_` (branch prefix, review segment). */
const BRANCH_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/;

function readBranchSegment(table: Table, key: string, file: string, path: readonly string[]): string {
  const value = readString(table, key, file, path);
  if (!BRANCH_SEGMENT.test(value)) {
    throw fail(file, [...path, key], "must be one branch segment of lowercase letters, digits, - and _");
  }
  return value;
}

/** Text before the issue number in a branch segment: lowercase letters, digits, `-` and `_`, possibly none. */
const ISSUE_NUMBER_PREFIX = /^[a-z0-9_-]*$/;

function readIssueNumberPrefix(table: Table, file: string, path: readonly string[]): string {
  const key = "issue_number_prefix";
  const value = readStringAllowEmpty(table, key, file, path);
  if (!ISSUE_NUMBER_PREFIX.test(value)) {
    throw fail(file, [...path, key], "must contain only lowercase letters, digits, - and _ (it may be empty)");
  }
  return value;
}

/** `pohunek session wait --timeout-ms` accepts 1 to 8000; the core CLI rejects any other value. */
const SESSION_WAIT_MAX_TIMEOUT_MS = 8000;

function readPromptDeliveryTimeout(table: Table, file: string, path: KeyPath): number {
  const key = "prompt_delivery_timeout_ms";
  const value = readPositiveInt(table, key, file, path);
  if (value > SESSION_WAIT_MAX_TIMEOUT_MS) {
    throw fail(file, [...path, key], `must not exceed ${SESSION_WAIT_MAX_TIMEOUT_MS.toString()} (pohunek session wait limit)`);
  }
  return value;
}

function parseActions(root: Table, file: string): ActionsConfig {
  const table = requireTable(root, "actions", file);
  const path = ["actions"];
  rejectUnknownKeys(
    table,
    [
      "branch_prefix",
      "review_branch_segment",
      "slug_max_length",
      "issue_number_prefix",
      "issue_body_max_length",
      "launch_timeout_ms",
      "launch_kill_margin_ms",
      "prompt_delivery_timeout_ms",
    ],
    file,
    path,
  );
  return {
    branchPrefix: readBranchSegment(table, "branch_prefix", file, path),
    reviewBranchSegment: readBranchSegment(table, "review_branch_segment", file, path),
    slugMaxLength: readPositiveInt(table, "slug_max_length", file, path),
    issueNumberPrefix: readIssueNumberPrefix(table, file, path),
    issueBodyMaxLength: readPositiveInt(table, "issue_body_max_length", file, path),
    launchTimeoutMs: readPositiveInt(table, "launch_timeout_ms", file, path),
    launchKillMarginMs: readPositiveInt(table, "launch_kill_margin_ms", file, path),
    promptDeliveryTimeoutMs: readPromptDeliveryTimeout(table, file, path),
  };
}

function parsePolicy(root: Table, file: string): PolicyConfig {
  const table = requireTable(root, "policy", file);
  const path = ["policy"];
  rejectUnknownKeys(table, ["delegable", "max_active_tasks", "daily_cost_ceiling_usd"], file, path);
  return {
    delegable: readStringArray(table, "delegable", file, path),
    maxActiveTasks: readNonNegativeInt(table, "max_active_tasks", file, path),
    dailyCostCeilingUsd: readNonNegativeNumber(table, "daily_cost_ceiling_usd", file, path),
  };
}

function parseProfiles(root: Table, file: string): ProfilesConfig {
  return readStringMapTable(requireTable(root, "profiles", file), file, ["profiles"]);
}

/** Longest delay setTimeout honours; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;
const MS_PER_SECOND = 1000;

function readTimerValue(table: Table, key: string, unitMs: number, file: string, path: KeyPath): number {
  const value = readPositiveInt(table, key, file, path);
  if (value * unitMs > MAX_TIMER_MS) {
    throw fail(file, [...path, key], `must not exceed ${Math.floor(MAX_TIMER_MS / unitMs).toString()} (timer limit)`);
  }
  return value;
}

const ISSUE_SOURCES: readonly IssueSource["kind"][] = ["linear", "github"];
const REVIEWS_MODES: readonly ReviewsMode[] = ["session", "external"];
const TUI_INITIAL_VIEWS: readonly TuiInitialView[] = ["mine", "all"];

/** A host name as `URL.hostname` returns it: lowercase labels, no port, no scheme. */
const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function parseTui(root: Table, file: string): TuiConfig {
  const table = requireTable(root, "tui", file);
  const path = ["tui"];
  rejectUnknownKeys(
    table,
    [
      "self_bin",
      "refresh_interval_secs",
      "list_timeout_ms",
      "stale_after_secs",
      "stale_pr_days",
      "initial_view",
      "bell_on_transition",
      "open_command",
      "open_url_hosts",
      "stderr_max_lines",
      "detail_min_width",
    ],
    file,
    path,
  );
  const openUrlHosts = readNonEmptyStringArray(table, "open_url_hosts", file, path);
  if (!openUrlHosts.every((host) => HOST_NAME.test(host))) {
    throw fail(file, [...path, "open_url_hosts"], "must contain only lowercase host names (no scheme, port or path)");
  }
  return {
    selfBin: readAbsolutePath(table, "self_bin", file, path),
    refreshIntervalSecs: readTimerValue(table, "refresh_interval_secs", MS_PER_SECOND, file, path),
    listTimeoutMs: readTimerValue(table, "list_timeout_ms", 1, file, path),
    staleAfterSecs: readTimerValue(table, "stale_after_secs", MS_PER_SECOND, file, path),
    stalePrDays: readPositiveInt(table, "stale_pr_days", file, path),
    initialView: readEnum(table, "initial_view", TUI_INITIAL_VIEWS, file, path),
    bellOnTransition: readBoolean(table, "bell_on_transition", file, path),
    openCommand: readAbsolutePath(table, "open_command", file, path),
    openUrlHosts,
    stderrMaxLines: readPositiveInt(table, "stderr_max_lines", file, path),
    detailMinWidth: readPositiveInt(table, "detail_min_width", file, path),
  };
}

function parseGlobal(root: Table, file: string): GlobalConfig {
  rejectUnknownKeys(
    root,
    ["identity", "github", "linear", "pohunek", "watch", "notify", "log", "actions", "policy", "profiles", "tui"],
    file,
    [],
  );
  return {
    identity: parseIdentity(root, file),
    github: parseGithub(root, file),
    linear: "linear" in root ? parseLinear(root, file) : null,
    pohunek: parsePohunek(root, file),
    watch: parseWatch(root, file),
    notify: parseNotify(root, file),
    log: parseLog(root, file),
    actions: parseActions(root, file),
    policy: parsePolicy(root, file),
    profiles: parseProfiles(root, file),
    tui: parseTui(root, file),
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

/** Keys that only an issue source of the given kind accepts. */
const LINEAR_ONLY_KEYS = ["linear_team", "paused_states"] as const;
const LABEL_KEYS = ["started_labels", "paused_labels"] as const;
const PROJECT_STATUS_KEYS = [
  "status_project_owner",
  "status_project_number",
  "status_field",
  "status_started_options",
  "status_paused_options",
] as const;
const GITHUB_ONLY_KEYS = ["issue_signal", ...LABEL_KEYS, ...PROJECT_STATUS_KEYS] as const;
const ISSUE_SIGNALS: readonly IssueSignal[] = ["labels", "project", "both"];

/** Same shape as the login check of the identity (a GitHub user or organization login). */
const PROJECT_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Names are compared case-insensitively, so two spellings of one name are a duplicate. */
function rejectDuplicateNames(names: readonly string[], file: string, path: readonly string[], key: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw fail(file, [...path, key], `must not list ${JSON.stringify(name)} twice`);
    seen.add(folded);
  }
}

function rejectOverlap(
  started: readonly string[],
  paused: readonly string[],
  file: string,
  path: readonly string[],
  startedKey: string,
  pausedKey: string,
): void {
  const both = paused.find((name) => started.some((other) => other.toLowerCase() === name.toLowerCase()));
  if (both !== undefined) {
    throw fail(file, [...path, pausedKey], `must not repeat ${JSON.stringify(both)} from ${startedKey}`);
  }
}

function rejectKeys(table: Table, keys: readonly string[], file: string, path: readonly string[], condition: string): void {
  for (const key of keys) {
    if (key in table) throw fail(file, [...path, key], `is only valid ${condition}`);
  }
}

function parseGithubProjectStatus(table: Table, file: string, path: readonly string[]): GithubProjectStatus {
  const owner = readString(table, "status_project_owner", file, path);
  if (!PROJECT_OWNER_PATTERN.test(owner)) {
    throw fail(file, [...path, "status_project_owner"], "must be a GitHub user or organization login");
  }
  const number = readPositiveInt(table, "status_project_number", file, path);
  const field = readString(table, "status_field", file, path);
  const startedOptions = readNonEmptyStringArray(table, "status_started_options", file, path);
  const pausedOptions = readStringArray(table, "status_paused_options", file, path);
  rejectDuplicateNames(startedOptions, file, path, "status_started_options");
  rejectDuplicateNames(pausedOptions, file, path, "status_paused_options");
  rejectOverlap(startedOptions, pausedOptions, file, path, "status_started_options", "status_paused_options");
  return { owner, number, field, startedOptions, pausedOptions };
}

function parseIssueSource(table: Table, file: string, path: readonly string[]): IssueSource {
  const kind = readEnum(table, "issue_source", ISSUE_SOURCES, file, path);
  if (kind === "github") {
    for (const key of LINEAR_ONLY_KEYS) {
      if (key in table) throw fail(file, [...path, key], 'is only valid with issue_source = "linear"');
    }
    const signal = readEnum(table, "issue_signal", ISSUE_SIGNALS, file, path);
    const usesLabels = signal !== "project";
    const usesProject = signal !== "labels";
    if (!usesLabels) rejectKeys(table, LABEL_KEYS, file, path, 'with issue_signal = "labels" or "both"');
    if (!usesProject) rejectKeys(table, PROJECT_STATUS_KEYS, file, path, 'with issue_signal = "project" or "both"');
    let startedLabels: readonly string[] = [];
    let pausedLabels: readonly string[] = [];
    if (usesLabels) {
      startedLabels = readNonEmptyStringArray(table, "started_labels", file, path);
      pausedLabels = readStringArray(table, "paused_labels", file, path);
      rejectDuplicateNames(startedLabels, file, path, "started_labels");
      rejectDuplicateNames(pausedLabels, file, path, "paused_labels");
      rejectOverlap(startedLabels, pausedLabels, file, path, "started_labels", "paused_labels");
    }
    const projectStatus = usesProject ? parseGithubProjectStatus(table, file, path) : null;
    return { kind, signal, startedLabels, pausedLabels, projectStatus };
  }
  rejectKeys(table, GITHUB_ONLY_KEYS, file, path, 'with issue_source = "github"');
  return {
    kind,
    team: readString(table, "linear_team", file, path),
    pausedStates: readStringArray(table, "paused_states", file, path),
  };
}

function parseProject(root: Table, name: string): ProjectConfig {
  const file = `${PROJECTS_DIR}/${name}${TOML_SUFFIX}`;
  rejectUnknownKeys(root, ["project", "policy", "profiles"], file, []);
  const table = requireTable(root, "project", file);
  const path = ["project"];
  rejectUnknownKeys(
    table,
    ["pohunek_label", "repo", "issue_source", "reviews", "branch_pattern", "ignored_checks", "policy_checks", "ai_reviewers", "linear_team", "paused_states", "issue_signal", "started_labels", "paused_labels", "status_project_owner", "status_project_number", "status_field", "status_started_options", "status_paused_options", "ignore_label"],
    file,
    path,
  );
  const issueSource = parseIssueSource(table, file, path);
  const pohunekLabel = readString(table, "pohunek_label", file, path);
  if (pohunekLabel !== name) {
    throw fail(file, [...path, "pohunek_label"], "must equal the file name without extension");
  }
  const branchPatternSource = readString(table, "branch_pattern", file, path);
  const ignoredChecks = readStringArray(table, "ignored_checks", file, path);
  const policyChecks = readStringArray(table, "policy_checks", file, path);
  const repeated = policyChecks.find((name, index) => policyChecks.indexOf(name) !== index);
  if (repeated !== undefined) {
    throw fail(file, [...path, "policy_checks"], `must not list ${JSON.stringify(repeated)} twice`);
  }
  const both = policyChecks.find((name) => ignoredChecks.includes(name));
  if (both !== undefined) {
    throw fail(file, [...path, "policy_checks"], `must not repeat ${JSON.stringify(both)} from ignored_checks`);
  }
  return {
    name,
    pohunekLabel,
    repo: readRepo(table, "repo", file, path),
    issueSource,
    reviews: readEnum(table, "reviews", REVIEWS_MODES, file, path),
    branchPattern: compileBranchPattern(branchPatternSource, file),
    branchPatternSource,
    ignoredChecks,
    policyChecks,
    aiReviewers: readStringArray(table, "ai_reviewers", file, path),
    ignoreLabel: "ignore_label" in table ? readString(table, "ignore_label", file, path) : null,
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
  if (global.linear === null) {
    const linearProject = projects.find((project) => project.issueSource.kind === "linear");
    if (linearProject !== undefined) {
      throw fail(
        GLOBAL_FILE,
        ["linear"],
        `is required because ${PROJECTS_DIR}/${linearProject.name}${TOML_SUFFIX} uses issue_source = "linear"`,
      );
    }
  }
  // Only a project with an ignore_label selects the label page of every issue.
  if (
    global.linear !== null &&
    projects.some((project) => project.issueSource.kind === "linear" && project.ignoreLabel !== null) &&
    !fitsLinearComplexity(global.linear.pageSize, true)
  ) {
    throw linearPageSizeError(GLOBAL_FILE, global.linear.pageSize, true);
  }
  return { configDir, global, projects };
}
