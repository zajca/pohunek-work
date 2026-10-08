import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_FILE_NAME, LOG_LOCK_FILE_NAME, LogFileError, rotatingFileLogger, startBackendFromEnv } from "@pohunek/backend";
import { createFixtureRoot, startFixtureDaemon } from "@pohunek/testkit";

const LOG_HOLDER_SCRIPT = fileURLToPath(new URL("./support/log-holder.ts", import.meta.url));
const FIFO_PEER_DELAY_MS = 2_000;

describe("backend log destination", () => {
  test("a failed start is recorded in the configured log directory", async () => {
    const root = await createFixtureRoot("pk-log-");
    try {
      const logDir = join(root, "logs");
      const socketPath = join(root, "daemon.sock");
      const daemon = await startFixtureDaemon({ listen: { unixSocketPath: socketPath } });
      try {
        let failed = false;
        try {
          await startBackendFromEnv({
            POHUNEK_BACKEND_BIND_HOST: "0.0.0.0",
            POHUNEK_BACKEND_PORT: "0",
            POHUNEK_BACKEND_DAEMON_SOCKET: socketPath,
            POHUNEK_BACKEND_STATIC_DIR: root,
            POHUNEK_BACKEND_LOG_DIR: logDir,
          });
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
      } finally {
        await daemon.close();
      }
      const lines = (await readFile(join(logDir, LOG_FILE_NAME), "utf8")).trimEnd().split("\n");
      const last = JSON.parse(lines[lines.length - 1] ?? "") as { event?: string; lifecycle?: string };
      expect(last.event).toBe("backend_startup");
      expect(last.lifecycle).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a configured log directory receives the backend lifecycle events", async () => {
    const root = await createFixtureRoot("pk-log-");
    try {
      const socketPath = join(root, "daemon.sock");
      const logDir = join(root, "logs");
      const daemon = await startFixtureDaemon({ listen: { unixSocketPath: socketPath } });
      try {
        const backend = await startBackendFromEnv({
          POHUNEK_BACKEND_BIND_HOST: "127.0.0.1",
          POHUNEK_BACKEND_PORT: "0",
          POHUNEK_BACKEND_ALLOW_LOOPBACK: "1",
          POHUNEK_BACKEND_DAEMON_SOCKET: socketPath,
          POHUNEK_BACKEND_STATIC_DIR: root,
          POHUNEK_BACKEND_LOG_DIR: logDir,
        });
        await backend.close();
      } finally {
        await daemon.close();
      }
      const lines = (await readFile(join(logDir, LOG_FILE_NAME), "utf8")).trimEnd().split("\n");
      const lifecycles = lines.map((line) => (JSON.parse(line) as { lifecycle?: string }).lifecycle);
      expect(lifecycles.includes("listening")).toBe(true);
      expect(lifecycles.includes("closed")).toBe(true);
      expect((await stat(logDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(logDir, LOG_FILE_NAME))).mode & 0o777).toBe(0o600);
      expect((await stat(join(logDir, LOG_LOCK_FILE_NAME))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlinked lock file is refused without changing its target", async () => {
    const root = await createFixtureRoot("pk-log-");
    try {
      const logDir = join(root, "logs");
      const target = join(root, "target");
      await mkdir(logDir, { mode: 0o700 });
      await writeFile(target, "keep\n", { mode: 0o644 });
      await chmod(target, 0o644);
      await symlink(target, join(logDir, LOG_LOCK_FILE_NAME));

      let failure: unknown;
      try {
        await startBackendFromEnv({
          POHUNEK_BACKEND_BIND_HOST: "127.0.0.1",
          POHUNEK_BACKEND_PORT: "0",
          POHUNEK_BACKEND_ALLOW_LOOPBACK: "1",
          POHUNEK_BACKEND_DAEMON_SOCKET: join(root, "missing.sock"),
          POHUNEK_BACKEND_STATIC_DIR: root,
          POHUNEK_BACKEND_LOG_DIR: logDir,
        });
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LogFileError);
      expect(await readFile(target, "utf8")).toBe("keep\n");
      expect((await stat(target)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a second process cannot take the log directory until its holder exits", async () => {
    const root = await createFixtureRoot("pk-log-");
    const logDir = join(root, "logs");
    const holder = startHolder(logDir);
    try {
      expect(await holder.firstLine).toBe("ready");
      let failure: unknown;
      try {
        rotatingFileLogger({ dir: logDir, maxFileBytes: 4096, maxFiles: 2 }).close();
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LogFileError);
      holder.child.stdin?.end();
      expect(await holder.exited).toEqual({ code: 0, signal: null });
      rotatingFileLogger({ dir: logDir, maxFileBytes: 4096, maxFiles: 2 }).close();
    } finally {
      await stopHolder(holder.child);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rotation bounds every file and retains the newest events", async () => {
    const root = await createFixtureRoot("pk-log-");
    try {
      const logDir = join(root, "logs");
      const maxFileBytes = 400;
      const logger = rotatingFileLogger({ dir: logDir, maxFileBytes, maxFiles: 3 });
      try {
        for (let index = 0; index < 40; index += 1) {
          logger.log({ level: "info", event: `event_${String(index).padStart(2, "0")}` });
        }
      } finally {
        logger.close();
      }
      const names = (await readdir(logDir)).sort();
      expect(names).toEqual([LOG_FILE_NAME, `${LOG_FILE_NAME}.1`, `${LOG_FILE_NAME}.2`, LOG_LOCK_FILE_NAME]);
      for (const name of names.filter((entry) => entry !== LOG_LOCK_FILE_NAME)) {
        expect((await stat(join(logDir, name))).size <= maxFileBytes).toBe(true);
        expect((await stat(join(logDir, name))).mode & 0o777).toBe(0o600);
      }
      expect((await readFile(join(logDir, LOG_FILE_NAME), "utf8")).includes("event_39")).toBe(true);
      expect((await readFile(join(logDir, `${LOG_FILE_NAME}.2`), "utf8")).includes("event_00")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("symlinked log paths cannot change their targets", async () => {
    const root = await createFixtureRoot("pk-log-");
    try {
      const targetDir = join(root, "target-dir");
      await mkdir(targetDir, { mode: 0o700 });
      await writeFile(join(targetDir, LOG_FILE_NAME), "keep\n", { mode: 0o600 });
      await symlink(targetDir, join(root, "link-dir"));
      expectRefusedLogger(`${join(root, "link-dir")}/`);
      expect(await readFile(join(targetDir, LOG_FILE_NAME), "utf8")).toBe("keep\n");

      const activeDir = join(root, "active");
      await mkdir(activeDir, { mode: 0o700 });
      const targetFile = join(root, "target-file");
      await writeFile(targetFile, "keep\n", { mode: 0o644 });
      await chmod(targetFile, 0o644);
      await symlink(targetFile, join(activeDir, LOG_FILE_NAME));
      expectRefusedLogger(activeDir);
      expect(await readFile(targetFile, "utf8")).toBe("keep\n");

      const rotatedDir = join(root, "rotated");
      await mkdir(rotatedDir, { mode: 0o700 });
      await symlink(targetFile, join(rotatedDir, `${LOG_FILE_NAME}.1`));
      rotatingFileLogger({ dir: rotatedDir, maxFileBytes: 4096, maxFiles: 3 }).close();
      expect((await readdir(rotatedDir)).includes(`${LOG_FILE_NAME}.1`)).toBe(false);
      expect(await readFile(targetFile, "utf8")).toBe("keep\n");
      expect((await stat(targetFile)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("FIFO log slots fail promptly and release the startup lock", async () => {
    const root = await createFixtureRoot("pk-log-");
    try {
      const activeDir = join(root, "active");
      const rotatedDir = join(root, "rotated");
      await mkdir(activeDir, { mode: 0o700 });
      await mkdir(rotatedDir, { mode: 0o700 });
      const active = makeFifoWithLatePeer(join(activeDir, LOG_FILE_NAME));
      const rotatedPath = join(rotatedDir, `${LOG_FILE_NAME}.1`);
      const rotated = makeFifoWithLatePeer(rotatedPath);
      try {
        const started = performance.now();
        expectRefusedLogger(activeDir);
        expectRefusedLogger(rotatedDir);
        expect(performance.now() - started < FIFO_PEER_DELAY_MS).toBe(true);
      } finally {
        await Promise.all([stopHolder(active), stopHolder(rotated)]);
      }
      await rm(rotatedPath);
      rotatingFileLogger({ dir: rotatedDir, maxFileBytes: 4096, maxFiles: 3 }).close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("closing an earlier logger again cannot release a later holder", async () => {
    const root = await createFixtureRoot("pk-log-");
    try {
      const logDir = join(root, "logs");
      const first = rotatingFileLogger({ dir: logDir, maxFileBytes: 4096, maxFiles: 2 });
      expectRefusedLogger(logDir);
      first.close();
      const second = rotatingFileLogger({ dir: logDir, maxFileBytes: 4096, maxFiles: 2 });
      try {
        first.close();
        expectRefusedLogger(logDir);
      } finally {
        second.close();
      }
      rotatingFileLogger({ dir: logDir, maxFileBytes: 4096, maxFiles: 2 }).close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function expectRefusedLogger(dir: string): void {
  let failure: unknown;
  try {
    rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 3 }).close();
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(LogFileError);
}

function makeFifoWithLatePeer(path: string): ChildProcess {
  const created = spawnSync("mkfifo", ["-m", "600", path]);
  if (created.status !== 0) {
    throw new Error(`mkfifo failed for ${path}`);
  }
  const delaySeconds = String(FIFO_PEER_DELAY_MS / 1000);
  return spawn("sh", ["-c", 'sleep "$1"; exec 3<>"$0"; sleep "$1"', path, delaySeconds], { stdio: "ignore" });
}

interface Holder {
  readonly child: ChildProcess;
  readonly firstLine: Promise<string>;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

function startHolder(dir: string): Holder {
  const child = spawn(process.execPath, [LOG_HOLDER_SCRIPT, dir], { stdio: ["pipe", "pipe", "inherit"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const firstLine = new Promise<string>((resolve, reject) => {
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end >= 0) {
        resolve(buffered.slice(0, end));
      }
    });
    child.once("error", reject);
    void exited.then(() => reject(new Error("holder exited without a first line")));
  });
  void firstLine.catch(() => undefined);
  return { child, firstLine, exited };
}

async function stopHolder(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}
