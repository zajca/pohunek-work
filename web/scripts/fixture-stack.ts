import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  DEFAULT_DAEMON_RETRY_INTERVAL_SECONDS,
  DEFAULT_DAEMON_WAIT_SECONDS,
  DEFAULT_DISCOVER_INTERVAL_SECONDS,
  DEFAULT_STATIC_ASSETS_DIR,
  externalPeerSelector,
  startBackend,
  type BackendLogger,
} from "@pohunek/backend";
import type { HostRecord, NotificationRecord, ProjectInfo, SessionInfo } from "@pohunek/protocol";
import {
  createFixtureRoot,
  startFixtureDaemon,
  type FixtureDaemonHandle,
  type FixtureProject,
} from "@pohunek/testkit";

export const FIXTURE_LOOPBACK_HOST = "127.0.0.1";
export const FIXTURE_LOCAL_HOST = "local";
const FIXTURE_PEER_NAME = "fixture-peer";
export const FIXTURE_PEER_HOST = `netbird:${externalPeerSelector(FIXTURE_PEER_NAME)}`;
export const FIXTURE_LOCAL_SESSION_ID = "s-local-seed";
export const FIXTURE_LOCAL_RECOVERY_ID = "fixture-local-conversation";
export const FIXTURE_LOCAL_NATIVE_ACTIVITY = "2026-07-22T11:15:00Z";
export const FIXTURE_PEER_SESSION_ID = "s-peer-seed";
export const FIXTURE_NOTIFICATION_ID = "n-local-seed";
export const FIXTURE_EXTERNAL_SESSION_ID = "s-external-seed";
export const FIXTURE_UNKNOWN_ACTIVE_SESSION_ID = "s-unknown-active-seed";
export const FIXTURE_UNKNOWN_PERSISTED_SESSION_ID = "s-unknown-persisted-seed";
export const FIXTURE_LEGACY_BASELESS_SESSION_ID = "s-legacy-baseless-seed";
export const FIXTURE_PROJECT_ID = "p-local-seed";
export const FIXTURE_OWNED_WORKTREE_PATH = "/tmp/pohunek-testkit/local-worktree";

const FIXTURE_ROOT_PREFIX = "pk-fe-";
const FIXTURE_LOCAL_SOCKET_FILENAME = "daemon.sock";
const FIXTURE_LOCAL_DAEMON_VERSION = "0.0.0-testkit-local";
const FIXTURE_PEER_DAEMON_VERSION = "0.0.0-testkit-peer";
const FIXTURE_TIMESTAMP = "2026-07-22T12:00:00Z";
const FIXTURE_TERMINAL_COLS = 100;
const FIXTURE_TERMINAL_ROWS = 30;
const FIXTURE_LOCAL_PID = 42_001;
const FIXTURE_PEER_PID = 42_002;
const DYNAMIC_PORT = 0;
const PACKAGED_BACKEND_STARTUP_TIMEOUT_MS = 10_000;
const PACKAGED_BACKEND_STOP_TIMEOUT_MS = 5_000;

const silentLogger: BackendLogger = {
  log(): void {},
};

export interface FixtureStackOptions {
  readonly staticAssetsDir?: string;
  readonly logger?: BackendLogger;
  readonly packagedBackend?: {
    readonly executable: string;
    readonly staticAssetsDir: string;
  };
}

interface FixtureBackendHandle {
  readonly url: string;
  close(): Promise<void>;
}

export interface FixtureStackHandle {
  readonly root: string;
  readonly local: FixtureDaemonHandle;
  readonly peer: FixtureDaemonHandle;
  readonly backend: FixtureBackendHandle;
  close(): Promise<void>;
}

/** Starts the complete two-host backend fixture used by dev mode and browser tests. */
export async function startFixtureStack(options: FixtureStackOptions = {}): Promise<FixtureStackHandle> {
  const root = await createFixtureRoot(FIXTURE_ROOT_PREFIX);
  const socketPath = join(root, FIXTURE_LOCAL_SOCKET_FILENAME);
  let peer: FixtureDaemonHandle | undefined;
  let local: FixtureDaemonHandle | undefined;
  let backend: FixtureBackendHandle | undefined;

  try {
    peer = await startFixtureDaemon({
      listen: { tcp: { host: FIXTURE_LOOPBACK_HOST, port: DYNAMIC_PORT } },
      daemonVersion: FIXTURE_PEER_DAEMON_VERSION,
      initialSessions: [peerSession()],
    });
    const peerAddress = requireTcpAddress(peer, FIXTURE_PEER_HOST);

    local = await startFixtureDaemon({
      listen: {
        unixSocketPath: socketPath,
        tcp: { host: FIXTURE_LOOPBACK_HOST, port: DYNAMIC_PORT },
      },
      daemonVersion: FIXTURE_LOCAL_DAEMON_VERSION,
      host: { discoveredHosts: [peerHostRecord(peerAddress.port)] },
      initialSessions: [
        localSession(),
        externalSession(),
        unknownActiveSession(),
        unknownPersistedSession(),
        legacyBaselessSession(),
      ],
      initialNotifications: [localNotification()],
      initialProjects: [localProject()],
    });

    backend = options.packagedBackend === undefined
      ? await startBackend(
        {
          bindHost: FIXTURE_LOOPBACK_HOST,
          port: DYNAMIC_PORT,
          allowLoopbackBind: true,
          daemonSocketPath: socketPath,
          derivedRuntime: undefined,
          logFiles: undefined,
          discoverIntervalSeconds: DEFAULT_DISCOVER_INTERVAL_SECONDS,
          daemonWaitSeconds: DEFAULT_DAEMON_WAIT_SECONDS,
          daemonRetryIntervalSeconds: DEFAULT_DAEMON_RETRY_INTERVAL_SECONDS,
          staticAssetsDir: options.staticAssetsDir ?? DEFAULT_STATIC_ASSETS_DIR,
        },
        options.logger ?? silentLogger,
      )
      : await startPackagedBackend(options.packagedBackend, socketPath);
  } catch (error: unknown) {
    await closeStartedResources(backend, local, peer, root);
    throw error;
  }

  let closeTask: Promise<void> | undefined;
  return {
    root,
    local,
    peer,
    backend,
    close: (): Promise<void> => {
      closeTask ??= closeStartedResources(backend, local, peer, root);
      return closeTask;
    },
  };
}

function peerHostRecord(port: number): HostRecord {
  return {
    name: FIXTURE_PEER_NAME,
    fqdn: `${FIXTURE_PEER_NAME}.test.invalid`,
    address: FIXTURE_LOOPBACK_HOST,
    port,
    overlay: "netbird",
    peer_id: FIXTURE_PEER_NAME,
    classification: "reachable_daemon",
    daemon_version: FIXTURE_PEER_DAEMON_VERSION,
  };
}

function localSession(): SessionInfo {
  return {
    ...baseLocalSession(),
    native_session_id: FIXTURE_LOCAL_RECOVERY_ID,
    native_last_activity_at: FIXTURE_LOCAL_NATIVE_ACTIVITY,
  };
}

function baseLocalSession(): SessionInfo {
  return {
    id: FIXTURE_LOCAL_SESSION_ID,
    capabilities: { resume: true, fork: true },
    name: "Local coding session",
    agent: "codex",
    agent_base: "codex",
    cwd: "/tmp/pohunek-testkit/local",
    cwd_source: "launch",
    pid: FIXTURE_LOCAL_PID,
    runtime: {
      state: "live",
      runtime_generation: "1",
      worker_id: `worker-${FIXTURE_LOCAL_SESSION_ID}`,
      worker_instance_id: `runtime-${FIXTURE_LOCAL_SESSION_ID}`,
      started_at: FIXTURE_TIMESTAMP,
      last_connected_at: FIXTURE_TIMESTAMP,
    },
    cols: FIXTURE_TERMINAL_COLS,
    rows: FIXTURE_TERMINAL_ROWS,
    state: "running",
    state_source: "report",
    activity: "working",
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function peerSession(): SessionInfo {
  return {
    id: FIXTURE_PEER_SESSION_ID,
    capabilities: { resume: false, fork: false },
    name: "Peer shell session",
    agent: "shell",
    agent_base: "shell",
    cwd: "/tmp/pohunek-testkit/peer",
    cwd_source: "launch",
    pid: FIXTURE_PEER_PID,
    cols: FIXTURE_TERMINAL_COLS,
    rows: FIXTURE_TERMINAL_ROWS,
    state: "running",
    state_source: "process",
    activity: "idle",
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function externalSession(): SessionInfo {
  return {
    ...baseLocalSession(),
    id: FIXTURE_EXTERNAL_SESSION_ID,
    name: "Observed external session",
    external: true,
    pid: FIXTURE_LOCAL_PID + 2,
  };
}

function unknownActiveSession(): SessionInfo {
  return {
    ...baseLocalSession(),
    id: FIXTURE_UNKNOWN_ACTIVE_SESSION_ID,
    name: "Unknown active agent session",
    active_agent: "future-profile",
    active_agent_base: "future-agent",
    pid: FIXTURE_LOCAL_PID + 3,
    updated_at: "2026-07-22T11:59:00Z",
  };
}

function unknownPersistedSession(): SessionInfo {
  return {
    ...baseLocalSession(),
    id: FIXTURE_UNKNOWN_PERSISTED_SESSION_ID,
    name: "Unknown persisted agent session",
    agent: "future-profile",
    agent_base: "future-agent",
    pid: FIXTURE_LOCAL_PID + 4,
    updated_at: "2026-07-22T11:58:00Z",
  };
}

function legacyBaselessSession(): SessionInfo {
  const session = {
    ...baseLocalSession(),
    id: FIXTURE_LEGACY_BASELESS_SESSION_ID,
    name: "Legacy baseless profile session",
    agent: "legacy-profile",
    pid: FIXTURE_LOCAL_PID + 5,
    updated_at: "2026-07-22T11:57:00Z",
  };
  delete (session as Partial<SessionInfo>).agent_base;
  return session;
}

function localProject(): FixtureProject {
  const project: ProjectInfo = {
    id: FIXTURE_PROJECT_ID,
    label: "Fixture project",
    repo_root: "/tmp/pohunek-testkit/project",
    git_common_dir: "/tmp/pohunek-testkit/project/.git",
    default_base_branch: "main",
    source: "manual",
    is_bare: false,
    added_at: FIXTURE_TIMESTAMP,
    last_used_at: FIXTURE_TIMESTAMP,
  };
  return {
    project,
    worktrees: [
      { path: project.repo_root, branch: "main", head: "fixture-head", bare: false, locked: false, owned: false },
      { path: FIXTURE_OWNED_WORKTREE_PATH, branch: "feature/test", head: "fixture-worktree-head", bare: false, locked: false, owned: true },
    ],
  };
}

function localNotification(): NotificationRecord {
  return {
    id: FIXTURE_NOTIFICATION_ID,
    source: {
      provider: "pohunek-testkit",
      provider_event: "approval_required",
      host_local_source_id: "fixture-local-approval",
    },
    kind: "approval_required",
    severity: "action_required",
    status: "unread",
    title: "Approval required",
    body: "The local fixture session is waiting for an operator decision.",
    session_id: FIXTURE_LOCAL_SESSION_ID,
    agent_kind: "codex",
    created_at: FIXTURE_TIMESTAMP,
  };
}

function requireTcpAddress(
  daemon: FixtureDaemonHandle,
  host: string,
): { readonly host: string; readonly port: number } {
  const address = daemon.tcpAddress;
  if (address === undefined) {
    throw new Error(`fixture daemon '${host}' did not expose a TCP address`);
  }
  return address;
}

async function closeStartedResources(
  backend: FixtureBackendHandle | undefined,
  local: FixtureDaemonHandle | undefined,
  peer: FixtureDaemonHandle | undefined,
  root: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const close of [
    backend === undefined ? undefined : (): Promise<void> => backend.close(),
    local === undefined ? undefined : (): Promise<void> => local.close(),
    peer === undefined ? undefined : (): Promise<void> => peer.close(),
    (): Promise<void> => rm(root, { recursive: true, force: true }),
  ]) {
    if (close === undefined) {
      continue;
    }
    try {
      await close();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to close the frontend fixture stack cleanly");
  }
}

async function startPackagedBackend(
  packaged: NonNullable<FixtureStackOptions["packagedBackend"]>,
  daemonSocketPath: string,
): Promise<FixtureBackendHandle> {
  const child = spawn(packaged.executable, [], {
    env: {
      ...process.env,
      POHUNEK_BACKEND_ALLOW_LOOPBACK: "true",
      POHUNEK_BACKEND_BIND_HOST: FIXTURE_LOOPBACK_HOST,
      POHUNEK_BACKEND_DAEMON_SOCKET: daemonSocketPath,
      POHUNEK_BACKEND_LOG_DIR: undefined,
      POHUNEK_BACKEND_PORT: String(DYNAMIC_PORT),
      POHUNEK_BACKEND_STATIC_DIR: packaged.staticAssetsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  const errors: string[] = [];
  stderr.on("line", (line: string): void => { errors.push(line); });

  try {
    const url = await new Promise<string>((resolveReady, rejectReady): void => {
      const timeout = setTimeout((): void => {
        cleanup();
        rejectReady(new Error(`packaged backend did not become ready: ${errors.join("\n")}`));
      }, PACKAGED_BACKEND_STARTUP_TIMEOUT_MS);
      const cleanup = (): void => {
        clearTimeout(timeout);
        stdout.off("line", onLine);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onLine = (line: string): void => {
        try {
          const event = JSON.parse(line) as { event?: unknown; lifecycle?: unknown; url?: unknown };
          if (event.event === "backend_server" && event.lifecycle === "listening" && typeof event.url === "string") {
            cleanup();
            resolveReady(event.url);
          }
        } catch {
          // Other output is not a readiness event.
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        rejectReady(error);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        rejectReady(new Error(`packaged backend exited before readiness (code=${String(code)}, signal=${String(signal)}): ${errors.join("\n")}`));
      };
      stdout.on("line", onLine);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    return { url, close: (): Promise<void> => stopPackagedBackend(child) };
  } catch (error: unknown) {
    await stopPackagedBackend(child);
    throw error;
  } finally {
    stdout.close();
    stderr.close();
    child.stdout.resume();
    child.stderr.resume();
  }
}

async function stopPackagedBackend(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  const timeout = setTimeout((): void => { child.kill("SIGKILL"); }, PACKAGED_BACKEND_STOP_TIMEOUT_MS);
  try {
    child.kill("SIGTERM");
    await exited;
  } finally {
    clearTimeout(timeout);
  }
}
