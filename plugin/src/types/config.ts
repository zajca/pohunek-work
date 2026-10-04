// Validated plugin configuration. Every key is required; the loader in
// src/config/ rejects a missing, mistyped or unknown key with file and key names.

export interface IdentityConfig {
  readonly githubLogin: string;
  readonly agentIdentities: readonly string[];
  readonly reviewTeams: readonly string[];
}

export interface GithubConfig {
  readonly endpoint: string;
  /** Absolute path of the `gh` binary used for `gh auth token`. */
  readonly ghBin: string;
  readonly timeoutMs: number;
  /** Page size of the top-level pull request connections. */
  readonly pullRequestPageSize: number;
  /** Page size of connections nested in a pull request (reviews, threads, timeline, checks). */
  readonly nestedPageSize: number;
  /** Page size of the comments nested in a review thread. */
  readonly threadCommentPageSize: number;
  /** Only pull requests merged within this many days are looked up to explain an issue without an open pull request. */
  readonly mergedLookbackDays: number;
}

export interface LinearConfig {
  readonly endpoint: string;
  /** Absolute path of the `secret-tool` binary used to read the keyring entry. */
  readonly secretToolBin: string;
  readonly keyringService: string;
  readonly keyringKey: string;
  readonly timeoutMs: number;
  readonly pageSize: number;
}

export interface PohunekConfig {
  readonly bin: string;
  readonly timeoutMs: number;
  readonly notificationsPageSize: number;
}

export interface WatchConfig {
  readonly pollIntervalSecs: number;
}

export interface LogConfig {
  /** Longest string value kept in a log line; longer values are truncated. */
  readonly maxStringLength: number;
}

export interface NotifyConfig {
  readonly command: string;
  /** Longest time the notification command may run before it is killed. */
  readonly timeoutMs: number;
}

export interface ActionsConfig {
  /** First branch segment of a launched issue branch (`<prefix>/<KEY>/<slug>`). */
  readonly branchPrefix: string;
  /** Second segment of a review branch (`<prefix>/<segment>/<number>-<head sha>`). */
  readonly reviewBranchSegment: string;
  /** Longest slug taken from the issue title. */
  readonly slugMaxLength: number;
  /** Time the daemon may take to answer `pohunek session new`, which creates a worktree. */
  readonly launchTimeoutMs: number;
  /** Extra time after `launchTimeoutMs` before the plugin ends the pohunek process itself. */
  readonly launchKillMarginMs: number;
}

export interface PolicyConfig {
  readonly delegable: readonly string[];
  readonly maxActiveTasks: number;
  readonly dailyCostCeilingUsd: number;
}

/** Action name to pohunek agent profile name. */
export type ProfilesConfig = Readonly<Record<string, string>>;

export type TuiInitialView = "mine" | "all";

export interface TuiConfig {
  /** Absolute path of the `pohunek-work` binary the TUI runs `list` and `do` with. */
  readonly selfBin: string;
  /** Pause between the end of one refresh and the start of the next. */
  readonly refreshIntervalSecs: number;
  /** Timeout of the `list` and preview children; their process group is killed. */
  readonly listTimeoutMs: number;
  /** Data age that is shown as `STALE`. */
  readonly staleAfterSecs: number;
  /** Days without a change after which a pull request nothing runs for can be hidden (`h`). */
  readonly stalePrDays: number;
  readonly initialView: TuiInitialView;
  /** Terminal bell when a row becomes the owner's turn. */
  readonly bellOnTransition: boolean;
  /** Absolute path of the URL opener (`o`). */
  readonly openCommand: string;
  /** Hosts `o` may open; compared exactly against the URL host name. */
  readonly openUrlHosts: readonly string[];
  /** Child stderr lines kept for display. */
  readonly stderrMaxLines: number;
  /** Columns below which the detail pane is shown full screen on Tab. */
  readonly detailMinWidth: number;
}

export interface GlobalConfig {
  readonly identity: IdentityConfig;
  readonly github: GithubConfig;
  readonly linear: LinearConfig;
  readonly pohunek: PohunekConfig;
  readonly watch: WatchConfig;
  readonly notify: NotifyConfig;
  readonly log: LogConfig;
  readonly actions: ActionsConfig;
  readonly policy: PolicyConfig;
  readonly profiles: ProfilesConfig;
  readonly tui: TuiConfig;
}

export interface ProjectConfig {
  /** File name without extension; equals `pohunekLabel`. */
  readonly name: string;
  readonly pohunekLabel: string;
  /** `owner/name` of the GitHub repository. */
  readonly repo: string;
  readonly linearTeam: string;
  /** Compiled `branch_pattern`; always has a named group `key`. */
  readonly branchPattern: RegExp;
  /** Source text of `branch_pattern` as written in the file. */
  readonly branchPatternSource: string;
  /** Exact check names (CheckRun name or StatusContext context) that never raise rule 5. */
  readonly ignoredChecks: readonly string[];
  /**
   * Exact check names an agent cannot fix (e.g. a required-label check): a failure
   * raises rule 5 for the owner but never `fix-ci`. Disjoint from `ignoredChecks`.
   */
  readonly policyChecks: readonly string[];
  /** GitHub logins of AI reviewer accounts; compared case-insensitively, `[bot]` suffix ignored. */
  readonly aiReviewers: readonly string[];
  /** Linear state names whose issues without a pull request are left out of the table. */
  readonly pausedStates: readonly string[];
  readonly policy: PolicyConfig | null;
  readonly profiles: ProfilesConfig | null;
}

export interface PluginConfig {
  readonly configDir: string;
  readonly global: GlobalConfig;
  readonly projects: readonly ProjectConfig[];
}
