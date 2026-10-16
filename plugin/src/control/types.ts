/** `outcome_unknown`: a mutation the daemon may have applied did not answer; the caller must look before retrying. */
export type ControlErrorCode = "unavailable" | "timeout" | "protocol_mismatch" | "invalid_response" | "origin_environment" | "command_failed" | "outcome_unknown";
export interface ControlError { readonly code: ControlErrorCode; readonly message: string; readonly cliCode?: string; readonly cliClass?: string }
export type ControlResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ControlError };

export interface ControlHost {
  /** Canonical `--host` route when dialable; a stable display key otherwise. */
  readonly route: string;
  readonly dialable: boolean;
  readonly name: string;
  readonly classification: "local" | "reachable_daemon" | "version_mismatch" | "unreachable" | "candidate";
  readonly daemonVersion: string | null;
  readonly address: string | null;
  readonly port: number | null;
}
/** The native conversation a session recovers from. `invalid` keeps core's ambiguous reference for the refusal. */
export type ControlNativeTarget =
  | { readonly status: "none" }
  | { readonly status: "verified"; readonly kind: "id" | "path"; readonly value: string }
  | { readonly status: "invalid"; readonly reason: string };
export interface ControlSession {
  readonly host: string; readonly id: string; readonly name: string | null; readonly agent: string;
  readonly cwd: string; readonly state: string; readonly activity: string | null;
  readonly runtimeState: string | null; readonly updatedAt: string;
  readonly projectId: string | null; readonly projectLabel: string | null;
  readonly branch: string | null; readonly worktreePath: string | null;
  readonly external: boolean; readonly canResume: boolean; readonly canFork: boolean;
  readonly nativeTarget: ControlNativeTarget; readonly nativeLastActivityAt: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly subagents: readonly ControlSubagent[];
  readonly subagentCount: number;
}
export interface ControlSubagent {
  readonly id: string; readonly parentId: string | null; readonly provider: string;
  readonly agentType: string | null; readonly lifecycle: string; readonly activity: string | null;
  readonly startedAtMs: number; readonly updatedAtMs: number; readonly finishedAtMs: number | null;
}
export interface ControlProject {
  readonly host: string; readonly id: string; readonly label: string; readonly repoRoot: string;
  readonly originUrl: string | null; readonly defaultBaseBranch: string | null;
}
export interface ControlWorktree { readonly path: string; readonly branch: string | null; readonly head: string | null; readonly sessionId: string | null }
export interface ControlProjectDetail { readonly project: ControlProject; readonly worktrees: readonly ControlWorktree[] }
export interface ControlNotification {
  readonly host: string; readonly id: string; readonly kind: string; readonly severity: string;
  readonly status: "unread" | "read" | "acknowledged" | "archived" | "deleted";
  readonly title: string; readonly body: string; readonly createdAt: string;
  readonly sessionId: string | null; readonly projectId: string | null;
}
export interface ControlHostCapabilities {
  readonly daemonVersion: string; readonly protocolVersion: number; readonly supportedAgents: readonly string[];
  readonly gitAvailable: boolean; readonly worktreeSupported: boolean;
  readonly terminalReadSupported: boolean; readonly outputReadSupported: boolean;
}
export interface ControlGovernance {
  readonly hostId: string;
  readonly enrollment: { readonly relayId: string; readonly status: string; readonly revision: number } | null;
  readonly owner: { readonly kind: "principal" | "team"; readonly id: string } | null;
  readonly ownerRevision: number | null;
  readonly quarantine: string | null;
  readonly approvalKeyReference: string;
}
export interface ControlScreen { readonly sessionId: string; readonly title: string | null; readonly progress: string | null; readonly visibleLines: readonly string[] }
/** Worker instance and runtime generation a session output cursor belongs to; the daemon rejects a cursor without it. */
export interface ControlRuntime { readonly workerInstanceId: string; readonly runtimeGeneration: string }
/** One bounded replay of a session's retained PTY output; the offsets are opaque cursors the daemon issues. */
export interface ControlOutput {
  readonly sessionId: string; readonly bytes: Uint8Array; readonly nextOffset: string; readonly runtimeEndOffset: string;
  readonly runtime: ControlRuntime;
  /** Whether the requested cursor had been evicted, so output between the cursor and the next replay is missing. */
  readonly gap: boolean; readonly hasMore: boolean; readonly timedOut: boolean;
}
/** Output replay request: `after` and `runtime` are the cursor and its runtime from the previous replay, both null for the newest retained tail. */
export interface ControlOutputRequest { readonly after: string | null; readonly runtime: ControlRuntime | null; readonly maxBytes: number; readonly waitMs: number }
export interface ControlSnapshotError { readonly host: string; readonly scope: "discovery" | "sessions" | "projects" | "notifications"; readonly error: ControlError }
export interface ControlSnapshot {
  readonly hosts: readonly ControlHost[]; readonly sessions: readonly ControlSession[];
  readonly projects: readonly ControlProject[];
  /** The notifications that still need the owner (unresolved actions); the activity list is read on demand. */
  readonly notifications: readonly ControlNotification[];
  readonly errors: readonly ControlSnapshotError[];
  /** Hosts whose notifications have not been read yet; their notifications are missing from the snapshot until they are. */
  readonly pendingNotifications: readonly string[];
}
export type ControlAction =
  | { readonly kind: "stop" | "remove" | "resume"; readonly host: string; readonly sessionId: string }
  | { readonly kind: "rename"; readonly host: string; readonly sessionId: string; readonly name: string | null }
  | { readonly kind: "fork"; readonly host: string; readonly sessionId: string; readonly name?: string; readonly cols: number; readonly rows: number }
  | { readonly kind: "metadata"; readonly host: string; readonly sessionId: string; readonly set?: Readonly<Record<string, string>>; readonly clear?: readonly string[] }
  | { readonly kind: "read" | "ack" | "archive"; readonly host: string; readonly notificationId: string };
export type ControlActionOutcome =
  | { readonly kind: "stop"; readonly stopped: boolean }
  | { readonly kind: "remove"; readonly removed: boolean; readonly stopped: boolean; readonly worktreesRemoved: number; readonly worktreesFailed: number }
  | { readonly kind: "resume" | "rename" | "fork"; readonly session: ControlSession }
  | { readonly kind: "metadata"; readonly session: ControlSession }
  | { readonly kind: "read" | "ack" | "archive"; readonly notification: ControlNotification };
export interface ControlClientOptions {
  readonly binary: string;
  readonly timeoutMs: number;
  readonly notificationsPageSize: number;
  /** Cap of the retry delay after the daemon event stream drops, in milliseconds. */
  readonly reconnectMaxMs: number;
  /** Socket of the local daemon for the SDK; null when the runtime directory cannot be resolved. */
  readonly localSocket: string | null;
  /** Environment of the CLI children; the process environment when absent. */
  readonly env?: Readonly<Record<string, string>>;
}
/** A notification that a daemon event changed; `record` is null when the event removed it. */
export interface ControlNotificationChange { readonly host: string; readonly id: string; readonly record: ControlNotification | null }

/** Scope of the activity list; `recent` is every notification but the archived and deleted ones. */
export type ControlActivityScope = "recent" | "unread" | "archived";

/**
 * Where an activity list continues. Each host that has records left keeps the records it has read and not yet shown
 * (newest first) and the daemon cursor of its next page; `done` means the host has no further page.
 */
export interface ControlActivityCursor {
  readonly hosts: Readonly<Record<string, { readonly buffered: readonly ControlNotification[]; readonly next: string | null; readonly done: boolean }>>;
}

/** One page of the activity list across hosts, globally newest first; `cursor` is null when the list is complete. */
export interface ControlActivityPage { readonly records: readonly ControlNotification[]; readonly cursor: ControlActivityCursor | null }

export interface ControlClient {
  refresh(): Promise<ControlSnapshot>;
  /** Calls the listener with each snapshot the event stream produces; returns the unsubscribe. */
  subscribe(listener: (snapshot: ControlSnapshot) => void): () => void;
  /** Closes the daemon connections. */
  close(): Promise<void>;
  inspectHost(host: string): Promise<ControlResult<ControlHostCapabilities>>;
  inspectGovernance(host: string): Promise<ControlResult<ControlGovernance>>;
  inspectSession(host: string, id: string): Promise<ControlResult<ControlSession>>;
  screen(host: string, id: string): Promise<ControlResult<ControlScreen>>;
  output(host: string, id: string, request: ControlOutputRequest): Promise<ControlResult<ControlOutput>>;
  showProject(host: string, reference: string): Promise<ControlResult<ControlProjectDetail>>;
  act(action: ControlAction): Promise<ControlResult<ControlActionOutcome>>;
  /** Calls the listener with each notification change the event stream carries; returns the unsubscribe. */
  subscribeNotifications(listener: (change: ControlNotificationChange) => void): () => void;
  /** One page of an activity scope across the hosts, newest first; `cursor` is null for the first page. */
  activity(scope: ControlActivityScope, cursor: ControlActivityCursor | null): Promise<ControlResult<ControlActivityPage>>;
  /** The first page of a session's notifications on its host. */
  sessionNotifications(host: string, sessionId: string): Promise<ControlResult<readonly ControlNotification[]>>;
}
