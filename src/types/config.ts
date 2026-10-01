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
}

export interface PolicyConfig {
  readonly delegable: readonly string[];
  readonly maxActiveTasks: number;
  readonly dailyCostCeilingUsd: number;
}

/** Action name to pohunek agent profile name. */
export type ProfilesConfig = Readonly<Record<string, string>>;

export interface GlobalConfig {
  readonly identity: IdentityConfig;
  readonly github: GithubConfig;
  readonly linear: LinearConfig;
  readonly pohunek: PohunekConfig;
  readonly watch: WatchConfig;
  readonly notify: NotifyConfig;
  readonly log: LogConfig;
  readonly policy: PolicyConfig;
  readonly profiles: ProfilesConfig;
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
  /** GitHub logins of AI reviewer accounts; compared case-insensitively, `[bot]` suffix ignored. */
  readonly aiReviewers: readonly string[];
  readonly policy: PolicyConfig | null;
  readonly profiles: ProfilesConfig | null;
}

export interface PluginConfig {
  readonly configDir: string;
  readonly global: GlobalConfig;
  readonly projects: readonly ProjectConfig[];
}
