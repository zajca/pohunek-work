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
  /** Page size of the issue search of a project whose issues come from GitHub. */
  readonly issuePageSize: number;
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
  /** Text before the number in the second branch segment of a GitHub issue (`<prefix>/<this><n>/<slug>`); may be empty. */
  readonly issueNumberPrefix: string;
  /** Longest issue body, in characters, that reaches the prompt of a GitHub issue; the rest is cut and marked. */
  readonly issueBodyMaxLength: number;
  /** Time the daemon may take to answer `pohunek session new`, which creates a worktree. */
  readonly launchTimeoutMs: number;
  /** Extra time after `launchTimeoutMs` before the plugin ends the pohunek process itself. */
  readonly launchKillMarginMs: number;
  /** Time `do` waits for a new session to start working on its prompt before it reports the launch as unverified; 1 to 8000 (the bound of `pohunek session wait --timeout-ms`). */
  readonly promptDeliveryTimeoutMs: number;
  /** Absolute path of the git binary `cleanup` reads worktrees with. */
  readonly gitBin: string;
  /** Time one local git command of `cleanup` may take (rev-parse, status, ls-files, symbolic-ref, rev-list); the fetch uses `cleanupTimeoutMs`. */
  readonly gitTimeoutMs: number;
  /** Remote whose branch a cleaned-up worktree branch must match (one remote name). */
  readonly cleanupRemote: string;
  /** Time `cleanup` allows one pohunek call (stop, rm, diff) and the git fetch. */
  readonly cleanupTimeoutMs: number;
  /** Uncommitted or untracked entries a branch-holder refusal names before it says "and N more". */
  readonly holderEntriesListed: number;
  /** Characters of one git- or pohunek-derived string (path, check detail) kept in a branch-holder refusal. */
  readonly holderEntryMaxLength: number;
}

/** Command `cleanup` runs in the session worktree before the session is removed. */
export interface TeardownConfig {
  /** Absolute program path followed by its arguments; run without a shell. */
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface PolicyConfig {
  readonly delegable: readonly string[];
  readonly maxActiveTasks: number;
  readonly dailyCostCeilingUsd: number;
}

/** Action name to pohunek agent profile name. */
export type ProfilesConfig = Readonly<Record<string, string>>;

export type TuiInitialView = "mine" | "all";
/** How `attach` opens a session: in this terminal, or in a window started by `attach_command`. */
export type TuiAttachMode = "inline" | "window";

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
  /** Optional executable that copies stdin to the clipboard. */
  readonly clipboardCommand?: string;
  /** Hosts `o` may open; compared exactly against the URL host name. */
  readonly openUrlHosts: readonly string[];
  /** Child stderr lines kept for display. */
  readonly stderrMaxLines: number;
  /** Columns from which the session detail sits beside the list; narrower terminals show it full screen. */
  readonly detailMinWidth: number;
  /** Interval of the full session and notification reconcile, in seconds. */
  readonly sessionReconcileSecs: number;
  /** Cap of the retry backoff after the daemon event subscription drops, in seconds. */
  readonly reconnectMaxSecs: number;
  /** Output limit of a captured action child, in bytes. */
  readonly actionCaptureBytes: number;
  /** Longest wait of one live output read at the end of a session's output, in milliseconds. */
  readonly outputWaitMs: number;
  /** Inline attaches in this terminal; window attaches in the terminal that `attachCommand` starts. */
  readonly attachMode: TuiAttachMode;
  /** Window mode: the terminal's argv template, split with POSIX quoting; placeholders are filled per attach. */
  readonly attachCommand?: readonly string[];
  /** Window mode: a terminal that exits within this many milliseconds is a failed launch. */
  readonly attachLaunchCheckMs?: number;
  /** Inline mode: typed characters that detach as Ctrl-] does; when absent the attach child inherits the terminal. */
  readonly detachSequence?: string;
  /** Bytes of a session's retained output requested per live read. */
  readonly outputMaxBytes: number;
  /** Longest gap between two presses on one list row that still counts as a double click, in milliseconds. */
  readonly doubleClickMs: number;
}


/** `pohunek-work manager start`: where the manager session runs and which agent it starts. */
export interface ManagerConfig {
  /** pohunek agent profile of the manager session; `--profile` overrides it. */
  readonly profile: string;
  /** Absolute path of the directory every manager session runs in; it never holds a project checkout. */
  readonly workdir: string;
}

/** The shared cache of GitHub and Linear source results in the state directory. */
export interface CacheConfig {
  /** A result read from the provider is served to every caller for this long without a new read. */
  readonly maxAgeMs: number;
  /** A lock its holder has not refreshed for this long is abandoned and taken over; a live holder refreshes it every `lockPollMs`. */
  readonly lockTimeoutMs: number;
  /** Pause between two checks of a lock by a waiter, and between two refreshes of a lock by its holder; below `lockTimeoutMs`. */
  readonly lockPollMs: number;
  /** Back-off after a rate-limit response that names no reset time. */
  readonly fallbackBackoffMs: number;
  /** How long a process waits for another process's write transaction on the cache database before it reports the cache busy. */
  readonly busyTimeoutMs: number;
}

export interface GlobalConfig {
  readonly identity: IdentityConfig;
  readonly github: GithubConfig;
  readonly cache: CacheConfig;
  /** Present only when the global file has a `[linear]` table; required whenever a project uses Linear. */
  readonly linear: LinearConfig | null;
  readonly pohunek: PohunekConfig;
  readonly watch: WatchConfig;
  readonly notify: NotifyConfig;
  readonly log: LogConfig;
  readonly actions: ActionsConfig;
  readonly policy: PolicyConfig;
  readonly profiles: ProfilesConfig;
  readonly tui: TuiConfig;
  /** Present only when the global file has a `[manager]` table; only `manager start` requires it. */
  readonly manager: ManagerConfig | null;
}

/** Issues of a project come from Linear. */
export interface LinearIssueSource {
  readonly kind: "linear";
  /** Linear team key whose issues are listed. */
  readonly team: string;
  /** Linear state names whose issues without a pull request are left out of the table. */
  readonly pausedStates: readonly string[];
}

/** Which signal marks a GitHub issue as started or paused. */
export type IssueSignal = "labels" | "project" | "both";

/** A single-select field of a GitHub Project whose option names mark an issue as started or paused. */
export interface GithubProjectStatus {
  /** Login of the user or organization that owns the Project; compared case-insensitively. */
  readonly owner: string;
  readonly number: number;
  /** Exact name of the single-select field. */
  readonly field: string;
  /** Option names that mark an assigned issue as started; never empty. */
  readonly startedOptions: readonly string[];
  /** Option names that pause an assigned issue; may be empty. */
  readonly pausedOptions: readonly string[];
}

/**
 * Issues of a project are the open GitHub issues of `repo` assigned to the owner that the configured
 * signal marks as started or paused. `startedLabels` is non-empty exactly when `signal` includes
 * `labels`, and `projectStatus` is non-null exactly when it includes `project`.
 */
export interface GithubIssueSource {
  readonly kind: "github";
  readonly signal: IssueSignal;
  /** Labels that mark an assigned issue as started. */
  readonly startedLabels: readonly string[];
  /** Labels that pause an assigned issue; may be empty. */
  readonly pausedLabels: readonly string[];
  readonly projectStatus: GithubProjectStatus | null;
}

export type IssueSource = LinearIssueSource | GithubIssueSource;

/** `[project] reviews`: `session` launches a pohunek review session, `external` leaves reviews to the project's own pipeline. */
export type ReviewsMode = "session" | "external";

export interface ProjectConfig {
  /** File name without extension; equals `pohunekLabel`. */
  readonly name: string;
  readonly pohunekLabel: string;
  /** `owner/name` of the GitHub repository. */
  readonly repo: string;
  readonly issueSource: IssueSource;
  /** Who reviews the project's pull requests: a pohunek review session or an external pipeline. */
  readonly reviews: ReviewsMode;
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
  /**
   * Login of the review bot that is asked again for a review after a force-push (rebase); null when the
   * project file says `review_bot = "none"`, which turns the request off.
   */
  readonly reviewBot: string | null;
  /**
   * Label that parks a pull request or issue: rows carrying it are hidden from `list` and refused
   * by `do`. Compared case-insensitively. Null when the key is absent, which turns the feature off.
   */
  readonly ignoreLabel: string | null;
  readonly policy: PolicyConfig | null;
  readonly profiles: ProfilesConfig | null;
  /** Null when the project has no `[teardown]` table, which turns the teardown step off. */
  readonly teardown: TeardownConfig | null;
}

export interface PluginConfig {
  readonly configDir: string;
  readonly global: GlobalConfig;
  readonly projects: readonly ProjectConfig[];
}

/** A project whose issues come from Linear. */
export type LinearProject = ProjectConfig & { readonly issueSource: LinearIssueSource };

/** A project whose issues come from GitHub. */
export type GithubProject = ProjectConfig & { readonly issueSource: GithubIssueSource };
