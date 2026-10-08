import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { startFixtureDaemon, type FixtureDaemonHandle } from "@pohunek/testkit";

const LOOPBACK_HOST = "127.0.0.1";
// A packaged backend should report readiness quickly even on a cold CI runner.
const STARTUP_TIMEOUT_MILLISECONDS = 10_000;
const EXPECTED_HTML_MARKER = "<!doctype html>";
// Active file of the backend log family; readiness lands here when a log directory is configured.
const LOG_FILE_NAME = "pohunek-backend.jsonl";
const LOG_DIR_ENV = "POHUNEK_BACKEND_LOG_DIR";
const LOG_POLL_INTERVAL_MILLISECONDS = 50;
// A refused or stopped backend must exit well within the startup budget.
const EXIT_TIMEOUT_MILLISECONDS = 10_000;

interface ReadyEvent {
  readonly event?: unknown;
  readonly lifecycle?: unknown;
  readonly url?: unknown;
}

async function main(): Promise<void> {
  const executable = process.argv[2];
  const staticAssetsDir = process.argv[3];
  if (executable === undefined || staticAssetsDir === undefined) {
    throw new Error("usage: bun run release/smoke.ts <backend-executable> <static-assets-dir>");
  }

  const root = await mkdtemp(join(tmpdir(), "pohunek-web-release-smoke-"));
  const socketPath = join(root, "daemon.sock");
  let daemon: FixtureDaemonHandle | undefined;
  let backend: ChildProcess | undefined;

  const spawnBackend = (extraEnv: NodeJS.ProcessEnv): ChildProcess =>
    spawn(resolve(executable), [], {
      env: {
        ...process.env,
        POHUNEK_BACKEND_ALLOW_LOOPBACK: "true",
        POHUNEK_BACKEND_BIND_HOST: LOOPBACK_HOST,
        POHUNEK_BACKEND_DAEMON_SOCKET: socketPath,
        POHUNEK_BACKEND_PORT: "0",
        POHUNEK_BACKEND_STATIC_DIR: resolve(staticAssetsDir),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  const extra: ChildProcess[] = [];

  try {
    daemon = await startFixtureDaemon({ listen: { unixSocketPath: socketPath } });
    backend = spawnBackend({});

    const url = await waitForReadyUrl(backend);
    const index = await fetch(`${url}/`);
    if (!index.ok || !(await index.text()).toLowerCase().includes(EXPECTED_HTML_MARKER)) {
      throw new Error(`packaged backend did not serve the compiled SPA (HTTP ${index.status})`);
    }

    const hosts = await fetch(`${url}/api/hosts`);
    if (!hosts.ok) {
      throw new Error(`packaged backend host discovery failed (HTTP ${hosts.status})`);
    }
    const payload = await hosts.json() as readonly { readonly host?: unknown }[];
    if (!payload.some((host) => host.host === "local")) {
      throw new Error("packaged backend did not discover its local fixture daemon");
    }

    await checkLogDirectoryLock(spawnBackend, join(root, "logs"), extra);
  } finally {
    await stopChild(backend);
    for (const child of extra) {
      await stopChild(child);
    }
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * With a log directory configured the backend logs to the file family under an
 * exclusive lock: a second backend on the directory must exit with an error
 * naming it, and the directory must be usable again once the holder stops.
 */
async function checkLogDirectoryLock(
  spawnBackend: (extraEnv: NodeJS.ProcessEnv) => ChildProcess,
  logDir: string,
  spawned: ChildProcess[],
): Promise<void> {
  const start = (): ChildProcess => {
    const child = spawnBackend({ [LOG_DIR_ENV]: logDir });
    spawned.push(child);
    return child;
  };
  const first = start();
  await waitForListeningEvents(first, logDir, 1);

  const refused = start();
  const stderr = collectStderr(refused);
  const code = await waitForExit(refused);
  if (code === 0 || code === null) {
    throw new Error(`second backend on a held log directory did not fail (exit ${String(code)})`);
  }
  if (!stderr().includes(logDir)) {
    throw new Error(`second backend error does not name the log directory: ${stderr()}`);
  }

  await stopChild(first);
  const third = start();
  await waitForListeningEvents(third, logDir, 2);
  await stopChild(third);
}

function collectStderr(child: ChildProcess): () => string {
  const chunks: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string): void => {
    chunks.push(chunk);
  });
  return (): string => chunks.join("");
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  const timer = setTimeout((): void => {
    child.kill("SIGKILL");
  }, EXIT_TIMEOUT_MILLISECONDS);
  try {
    const [code] = (await once(child, "exit")) as [number | null];
    if (child.signalCode === "SIGKILL") {
      throw new Error("backend did not exit before the timeout");
    }
    return code;
  } finally {
    clearTimeout(timer);
  }
}

/** Polls the active log file until it holds `count` `backend_server` `listening` events. */
async function waitForListeningEvents(child: ChildProcess, logDir: string, count: number): Promise<void> {
  const stderr = collectStderr(child);
  const deadline = Date.now() + STARTUP_TIMEOUT_MILLISECONDS;
  for (;;) {
    if (countListeningEvents(await readLogFile(join(logDir, LOG_FILE_NAME))) >= count) {
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`backend exited before logging readiness: ${stderr()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error("backend did not log readiness before the timeout");
    }
    await new Promise<void>((resolveDelay): void => {
      setTimeout(resolveDelay, LOG_POLL_INTERVAL_MILLISECONDS);
    });
  }
}

async function readLogFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function countListeningEvents(content: string): number {
  let count = 0;
  for (const line of content.split("\n")) {
    try {
      const event = JSON.parse(line) as ReadyEvent;
      if (event.event === "backend_server" && event.lifecycle === "listening") {
        count += 1;
      }
    } catch {
      // Blank or partly written lines are not events yet.
    }
  }
  return count;
}

function waitForReadyUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveReady, rejectReady): void => {
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (stdoutStream === null || stderrStream === null) {
      rejectReady(new Error("packaged backend smoke test requires piped stdout and stderr"));
      return;
    }

    const stdout = createInterface({ input: stdoutStream });
    const stderr: string[] = [];
    stderrStream.setEncoding("utf8");
    stderrStream.on("data", (chunk: string): void => {
      stderr.push(chunk);
    });

    const timeout = setTimeout((): void => {
      cleanup();
      rejectReady(new Error("packaged backend did not report readiness before the timeout"));
    }, STARTUP_TIMEOUT_MILLISECONDS);

    const cleanup = (): void => {
      clearTimeout(timeout);
      stdout.close();
      child.off("exit", onExit);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      rejectReady(
        new Error(`packaged backend exited before readiness (${code ?? "signal"}): ${stderr.join("")}`),
      );
    };

    child.once("exit", onExit);
    stdout.on("line", (line: string): void => {
      let event: ReadyEvent;
      try {
        event = JSON.parse(line) as ReadyEvent;
      } catch {
        return;
      }
      if (
        event.event === "backend_server"
        && event.lifecycle === "listening"
        && typeof event.url === "string"
      ) {
        cleanup();
        resolveReady(event.url);
      }
    });
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
}

void main().catch((error: unknown): void => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
