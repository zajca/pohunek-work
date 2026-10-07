import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { ftruncateSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOG_FILE_NAME,
  LOG_LOCK_FILE_NAME,
  LogFileError,
  rotatingFileLogger,
  startBackendFromEnv,
  type BackendLogEvent,
} from "@pohunek/backend";
import { createRotatingFileLogger, type LogFileIo } from "../src/log-files";
import { createFixtureRoot, startFixtureDaemon } from "@pohunek/testkit";

const SMALL_FILE_BYTES = 400;
/** A blocking open of a FIFO would return only after its late peer opens it. */
const FIFO_PEER_DELAY_MS = 2_000;
/** Rotating twenty small events in a fresh process takes well under this; below the per-test timeout. */
const HUGE_COUNT_ROTATION_BUDGET_MS = 4_000;
const LOG_HOLDER_SCRIPT = fileURLToPath(new URL("./support/log-holder.ts", import.meta.url));
/** Exit status `log-holder.ts` uses when the directory is refused. */
const HOLDER_REFUSED_EXIT_CODE = 3;
const LOG_FILES_MODULE = fileURLToPath(new URL("../src/log-files.ts", import.meta.url));

describe("rotating backend log files", () => {
  test("writes one JSON object per line into an owner-private file", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const logger = rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 3 });
      logger.log({ level: "info", event: "backend_server", lifecycle: "listening" });
      logger.log({ level: "error", event: "backend_startup", error_class: "Error" });

      const lines = (await readFile(join(dir, LOG_FILE_NAME), "utf8")).trimEnd().split("\n");
      expect(lines.length).toBe(2);
      const first = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
      expect(first["component"]).toBe("pohunek-backend");
      expect(first["event"]).toBe("backend_server");
      expect(typeof first["timestamp"]).toBe("string");
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, LOG_FILE_NAME))).mode & 0o777).toBe(0o600);
    });
  });

  test("rotates before the active file exceeds its bound and keeps the newest files", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const logger = rotatingFileLogger({ dir, maxFileBytes: SMALL_FILE_BYTES, maxFiles: 3 });
      for (let index = 0; index < 40; index += 1) {
        logger.log({ level: "info", event: `event_${String(index).padStart(2, "0")}` });
      }
      const names = (await readdir(dir)).sort();
      expect(names).toEqual([LOG_FILE_NAME, `${LOG_FILE_NAME}.1`, `${LOG_FILE_NAME}.2`, LOG_LOCK_FILE_NAME]);
      for (const name of names.filter((entry) => entry !== LOG_LOCK_FILE_NAME)) {
        expect((await stat(join(dir, name))).size <= SMALL_FILE_BYTES).toBe(true);
        expect((await stat(join(dir, name))).mode & 0o777).toBe(0o600);
      }
      // The newest event is in the active file; older ones are in higher suffixes.
      const active = await readFile(join(dir, LOG_FILE_NAME), "utf8");
      expect(active.includes("event_39")).toBe(true);
      const newestRotated = await readFile(join(dir, `${LOG_FILE_NAME}.1`), "utf8");
      const oldestRotated = await readFile(join(dir, `${LOG_FILE_NAME}.2`), "utf8");
      expect(newestRotated.includes("event_39")).toBe(false);
      expect(oldestRotated.includes("event_00")).toBe(false);
      expect(newestRotated.indexOf("event_") > -1 && oldestRotated.indexOf("event_") > -1).toBe(true);
    });
  });

  test("one file only truncates by replacement instead of growing", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const logger = rotatingFileLogger({ dir, maxFileBytes: SMALL_FILE_BYTES, maxFiles: 1 });
      for (let index = 0; index < 30; index += 1) {
        logger.log({ level: "info", event: `event_${String(index)}` });
      }
      expect((await readdir(dir)).sort()).toEqual([LOG_FILE_NAME, LOG_LOCK_FILE_NAME]);
      expect((await stat(join(dir, LOG_FILE_NAME))).size <= SMALL_FILE_BYTES).toBe(true);
    });
  });

  test("an event above the file bound is replaced by a fixed notice", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const logger = rotatingFileLogger({ dir, maxFileBytes: SMALL_FILE_BYTES, maxFiles: 2 });
      logger.log({ level: "info", event: "x".repeat(SMALL_FILE_BYTES * 2) });
      const content = await readFile(join(dir, LOG_FILE_NAME), "utf8");
      expect(content.includes("log_event_dropped")).toBe(true);
      expect(content.includes("xxxx")).toBe(false);
    });
  });

  test("an existing file is appended to and rotated files beyond the limit are pruned", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      await mkdir(dir, { mode: 0o700 });
      await writeFile(join(dir, LOG_FILE_NAME), '{"previous":true}\n', { mode: 0o600 });
      await writeFile(join(dir, `${LOG_FILE_NAME}.5`), "stale\n", { mode: 0o600 });
      await writeFile(join(dir, "unrelated.txt"), "keep\n", { mode: 0o600 });
      const logger = rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 });
      logger.log({ level: "info", event: "after_restart" });
      const names = (await readdir(dir)).sort();
      expect(names).toEqual([LOG_FILE_NAME, LOG_LOCK_FILE_NAME, "unrelated.txt"]);
      const content = await readFile(join(dir, LOG_FILE_NAME), "utf8");
      expect(content.startsWith('{"previous":true}\n')).toBe(true);
      expect(content.includes("after_restart")).toBe(true);
    });
  });

  test("a limit below the dropped-event notice is refused and the notice fits the smallest limit", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: 1, maxFiles: 2 }));

      let smallest = 0;
      for (let limit = 1; smallest === 0; limit += 1) {
        try {
          rotatingFileLogger({ dir, maxFileBytes: limit, maxFiles: 2 }).close();
          smallest = limit;
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(LogFileError);
        }
      }
      const logger = rotatingFileLogger({ dir, maxFileBytes: smallest, maxFiles: 2 });
      logger.log({ level: "info", event: "x".repeat(smallest) });
      logger.close();
      const content = await readFile(join(dir, LOG_FILE_NAME), "utf8");
      expect((JSON.parse(content) as { event?: string }).event).toBe("log_event_dropped");
    });
  });

  // Runs in a child process: a rotation that walks every index up to the
  // file count would block this test process instead of failing.
  test("rotation work follows the files present, not a huge file count", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const script = [
        `import { rotatingFileLogger } from ${JSON.stringify(LOG_FILES_MODULE)};`,
        `const logger = rotatingFileLogger({ dir: ${JSON.stringify(dir)}, maxFileBytes: ${String(SMALL_FILE_BYTES)}, maxFiles: Number.MAX_SAFE_INTEGER });`,
        `for (let index = 0; index < 20; index += 1) logger.log({ level: "info", event: "event_" + String(index) });`,
        "logger.close();",
      ].join("\n");
      const result = spawnSync(process.execPath, ["-e", script], { timeout: HUGE_COUNT_ROTATION_BUDGET_MS });
      expect(result.signal === null).toBe(true);
      expect(result.status).toBe(0);
      const names = await readdir(dir);
      expect(names.length > 2).toBe(true);
      expect(names.includes(`${LOG_FILE_NAME}.1`)).toBe(true);
    });
  });

  test("refuses a symlinked directory, a symlinked file, a shared directory and bad limits", async () => {
    await withRoot(async (root) => {
      const real = join(root, "real");
      await mkdir(real, { mode: 0o700 });
      await symlink(real, join(root, "link"));
      expectLogFileError(() => rotatingFileLogger({ dir: join(root, "link"), maxFileBytes: 4096, maxFiles: 2 }));

      const shared = join(root, "shared");
      await mkdir(shared, { mode: 0o755 });
      expectLogFileError(() => rotatingFileLogger({ dir: shared, maxFileBytes: 4096, maxFiles: 2 }));

      const linked = join(root, "linked-file");
      await mkdir(linked, { mode: 0o700 });
      await writeFile(join(root, "elsewhere"), "", { mode: 0o600 });
      await symlink(join(root, "elsewhere"), join(linked, LOG_FILE_NAME));
      expectLogFileError(() => rotatingFileLogger({ dir: linked, maxFileBytes: 4096, maxFiles: 2 }));
      expect(await readFile(join(root, "elsewhere"), "utf8")).toBe("");

      expectLogFileError(() => rotatingFileLogger({ dir: join(root, "limits"), maxFileBytes: 0, maxFiles: 2 }));
      expectLogFileError(() => rotatingFileLogger({ dir: join(root, "limits"), maxFileBytes: 10, maxFiles: 0 }));
    });
  });
});

describe("non-regular files in log slots", () => {
  test("a FIFO in the active or a rotated slot is refused without blocking", async () => {
    await withRoot(async (root) => {
      const activeDir = join(root, "active");
      await mkdir(activeDir, { mode: 0o700 });
      const activePeer = makeFifoWithLatePeer(join(activeDir, LOG_FILE_NAME));
      const rotatedDir = join(root, "rotated");
      await mkdir(rotatedDir, { mode: 0o700 });
      const rotatedPeer = makeFifoWithLatePeer(join(rotatedDir, `${LOG_FILE_NAME}.1`));
      try {
        const started = performance.now();
        const activeError = expectLogFileError(() =>
          rotatingFileLogger({ dir: activeDir, maxFileBytes: 4096, maxFiles: 2 }),
        );
        expectLogFileError(() => rotatingFileLogger({ dir: rotatedDir, maxFileBytes: 4096, maxFiles: 3 }));
        expect(performance.now() - started < FIFO_PEER_DELAY_MS).toBe(true);
        // The setup error carries the system cause, so a launchd start failure is actionable.
        expect(activeError.message.includes(activeDir)).toBe(true);
        expect(activeError.message.includes("ENXIO")).toBe(true);
      } finally {
        await Promise.all([stopPeer(activePeer), stopPeer(rotatedPeer)]);
      }
    });
  });

  test("a symlinked directory is refused behind a trailing slash or dot component", async () => {
    await withRoot(async (root) => {
      const target = join(root, "target");
      await mkdir(target, { mode: 0o700 });
      const big = "x".repeat(SMALL_FILE_BYTES * 3);
      await writeFile(join(target, LOG_FILE_NAME), big, { mode: 0o600 });
      await writeFile(join(target, `${LOG_FILE_NAME}.5`), "stale\n", { mode: 0o600 });
      await symlink(target, join(root, "link"));

      for (const dir of [`${join(root, "link")}/`, `${join(root, "link")}/.`, "relative/logs"]) {
        expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: SMALL_FILE_BYTES, maxFiles: 2 }));
      }
      expect((await readdir(target)).sort()).toEqual([LOG_FILE_NAME, `${LOG_FILE_NAME}.5`]);
      expect(await readFile(join(target, LOG_FILE_NAME), "utf8")).toBe(big);
    });
  });

  test("a symlink in a rotated slot is removed without touching its target", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      await mkdir(dir, { mode: 0o700 });
      const target = join(root, "target");
      await writeFile(target, "keep\n", { mode: 0o644 });
      await chmod(target, 0o644);
      await symlink(target, join(dir, `${LOG_FILE_NAME}.1`));
      const logger = rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 3 });
      logger.close();

      expect((await readdir(dir)).sort()).toEqual([LOG_FILE_NAME, LOG_LOCK_FILE_NAME]);
      expect(await readFile(target, "utf8")).toBe("keep\n");
      expect((await stat(target)).mode & 0o777).toBe(0o644);
    });
  });
});

describe("rotating log file failure handling", () => {
  test("a failing rotation reaches the fallback instead of the caller and recovers", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const received: BackendLogEvent[] = [];
      const logger = rotatingFileLogger({
        dir,
        maxFileBytes: SMALL_FILE_BYTES,
        maxFiles: 3,
        fallback: { log: (event): void => void received.push(event) },
      });
      logger.log({ level: "info", event: "first" });
      // A read-only directory makes the next rotation fail like a full disk would.
      await chmod(dir, 0o500);
      try {
        for (let index = 0; index < 10; index += 1) {
          logger.log({ level: "info", event: `during_failure_${String(index)}` });
        }
      } finally {
        await chmod(dir, 0o700);
      }
      const failures = received.filter((event) => event.event === "log_file_failed");
      expect(failures.length).toBe(1);
      expect(received.some((event) => event.event === "during_failure_9")).toBe(true);

      logger.log({ level: "info", event: "after_recovery" });
      const names = await readdir(dir);
      let found = false;
      for (const name of names) {
        if ((await readFile(join(dir, name), "utf8")).includes("after_recovery")) found = true;
      }
      expect(found).toBe(true);
    });
  });

  test("a partly written line is truncated away and the next event lands intact", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const received: BackendLogEvent[] = [];
      const io = tornWriteIo({ truncateFails: false });
      const logger = createRotatingFileLogger(
        { dir, maxFileBytes: 4096, maxFiles: 3, fallback: { log: (event): void => void received.push(event) } },
        io.io,
      );
      logger.log({ level: "info", event: "before" });
      io.tearNextWrite();
      logger.log({ level: "info", event: "torn" });
      logger.log({ level: "info", event: "after" });
      logger.close();

      expect(received.map((event) => event.event)).toEqual(["log_file_failed", "torn"]);
      expect((await readdir(dir)).sort()).toEqual([LOG_FILE_NAME, LOG_LOCK_FILE_NAME]);
      expect(await jsonEvents(join(dir, LOG_FILE_NAME))).toEqual(["before", "after"]);
    });
  });

  test("a torn line that cannot be truncated is left behind in a rotated file", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const received: BackendLogEvent[] = [];
      const io = tornWriteIo({ truncateFails: true });
      const logger = createRotatingFileLogger(
        { dir, maxFileBytes: 4096, maxFiles: 3, fallback: { log: (event): void => void received.push(event) } },
        io.io,
      );
      logger.log({ level: "info", event: "before" });
      io.tearNextWrite();
      logger.log({ level: "info", event: "torn" });
      logger.log({ level: "info", event: "after" });
      logger.close();

      expect(received.map((event) => event.event)).toEqual(["log_file_failed", "torn"]);
      expect(await jsonEvents(join(dir, LOG_FILE_NAME))).toEqual(["after"]);
      const rotated = await readFile(join(dir, `${LOG_FILE_NAME}.1`), "utf8");
      expect((JSON.parse(rotated.split("\n")[0] ?? "") as { event?: string }).event).toBe("before");
      expect(rotated.endsWith("\n")).toBe(false);
    });
  });

  test("events after close go to the fallback and close is idempotent", async () => {
    await withRoot((root) => {
      const received: BackendLogEvent[] = [];
      const logger = rotatingFileLogger({
        dir: join(root, "logs"),
        maxFileBytes: 4096,
        maxFiles: 2,
        fallback: { log: (event): void => void received.push(event) },
      });
      logger.close();
      logger.close();
      logger.log({ level: "info", event: "late" });
      expect(received.map((event) => event.event)).toEqual(["late"]);
      return Promise.resolve();
    });
  });

  test("files left above the bound or with loose modes are repaired at open", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      await mkdir(dir, { mode: 0o700 });
      const big = "x".repeat(SMALL_FILE_BYTES * 3);
      await writeFile(join(dir, LOG_FILE_NAME), big, { mode: 0o644 });
      await chmod(join(dir, LOG_FILE_NAME), 0o644);
      await writeFile(join(dir, `${LOG_FILE_NAME}.1`), big, { mode: 0o600 });
      await writeFile(join(dir, `${LOG_FILE_NAME}.2`), "small\n", { mode: 0o644 });
      await chmod(join(dir, `${LOG_FILE_NAME}.2`), 0o644);
      const logger = rotatingFileLogger({ dir, maxFileBytes: SMALL_FILE_BYTES, maxFiles: 3 });
      logger.close();

      expect((await stat(join(dir, LOG_FILE_NAME))).size).toBe(0);
      expect((await stat(join(dir, LOG_FILE_NAME))).mode & 0o777).toBe(0o600);
      expect((await readdir(dir)).sort()).toEqual([LOG_FILE_NAME, `${LOG_FILE_NAME}.2`, LOG_LOCK_FILE_NAME]);
      expect((await stat(join(dir, `${LOG_FILE_NAME}.2`))).mode & 0o777).toBe(0o600);
    });
  });
});

describe("log directory lock", () => {
  test("a second logger in this process is refused until the first closes", async () => {
    await withRoot((root) => {
      const dir = join(root, "logs");
      const first = rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 });
      const refused = expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }));
      expect(refused.message.includes(dir)).toBe(true);
      expect(refused.message.includes("another process holds")).toBe(true);

      first.close();
      const second = rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 });
      second.close();
      return Promise.resolve();
    });
  });

  test("a repeated close releases the lock once and never frees a later holder", async () => {
    await withRoot((root) => {
      const dir = join(root, "logs");
      const first = rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 });
      first.close();
      const second = rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 });
      // A second close of `first` must not close a descriptor number now owned by `second`.
      first.close();
      expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }));
      second.close();
      return Promise.resolve();
    });
  });

  test("a logger in another process blocks this one until that process closes it", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const holder = startHolder(dir);
      try {
        expect(await holder.firstLine).toBe("ready");
        const refused = expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }));
        expect(refused.message.includes(dir)).toBe(true);

        holder.child.stdin?.end();
        expect(await holder.exited).toEqual({ code: 0, signal: null });
        rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }).close();
      } finally {
        await stopPeer(holder.child);
      }
    });
  });

  test("a killed holder never blocks the next logger", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const holder = startHolder(dir);
      try {
        expect(await holder.firstLine).toBe("ready");
        expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }));

        holder.child.kill("SIGKILL");
        expect((await holder.exited).signal).toBe("SIGKILL");
        rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }).close();
      } finally {
        await stopPeer(holder.child);
      }
    });
  });

  test("a logger in another process is refused while this one holds the directory", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      const parent = rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 });
      const refusedHolder = startHolder(dir);
      try {
        const line = await refusedHolder.firstLine;
        expect(line.startsWith("refused ")).toBe(true);
        expect(line.includes(dir)).toBe(true);
        expect((await refusedHolder.exited).code).toBe(HOLDER_REFUSED_EXIT_CODE);

        parent.close();
        const accepted = startHolder(dir);
        try {
          expect(await accepted.firstLine).toBe("ready");
          accepted.child.stdin?.end();
          expect(await accepted.exited).toEqual({ code: 0, signal: null });
        } finally {
          await stopPeer(accepted.child);
        }
      } finally {
        parent.close();
        await stopPeer(refusedHolder.child);
      }
    });
  });

  test("the lock file is created owner-private and an existing loose one is tightened", async () => {
    await withRoot(async (root) => {
      const fresh = join(root, "fresh");
      rotatingFileLogger({ dir: fresh, maxFileBytes: 4096, maxFiles: 2 }).close();
      expect((await stat(join(fresh, LOG_LOCK_FILE_NAME))).mode & 0o777).toBe(0o600);

      const loose = join(root, "loose");
      await mkdir(loose, { mode: 0o700 });
      await writeFile(join(loose, LOG_LOCK_FILE_NAME), "", { mode: 0o644 });
      await chmod(join(loose, LOG_LOCK_FILE_NAME), 0o644);
      rotatingFileLogger({ dir: loose, maxFileBytes: 4096, maxFiles: 2 }).close();
      expect((await stat(join(loose, LOG_LOCK_FILE_NAME))).mode & 0o777).toBe(0o600);
    });
  });

  test("the lock file stays in the directory after close", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }).close();
      expect((await readdir(dir)).includes(LOG_LOCK_FILE_NAME)).toBe(true);
    });
  });

  test("a symlink in the lock slot is refused and its target is untouched", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      await mkdir(dir, { mode: 0o700 });
      const target = join(root, "target");
      await writeFile(target, "keep\n", { mode: 0o644 });
      await chmod(target, 0o644);
      await symlink(target, join(dir, LOG_LOCK_FILE_NAME));

      const refused = expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }));
      expect(refused.message.includes(dir)).toBe(true);
      expect(await readFile(target, "utf8")).toBe("keep\n");
      expect((await stat(target)).mode & 0o777).toBe(0o644);
      expect((await readdir(dir)).includes(LOG_FILE_NAME)).toBe(false);
    });
  });

  test("a directory in the lock slot is refused", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      await mkdir(join(dir, LOG_LOCK_FILE_NAME), { recursive: true, mode: 0o700 });
      const refused = expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }));
      // Opening a directory with O_CREAT fails with EISDIR before any type check.
      expect(refused.message.includes("EISDIR")).toBe(true);
      expect((await readdir(dir)).includes(LOG_FILE_NAME)).toBe(false);
    });
  });

  test("a FIFO in the lock slot is refused without blocking", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      await mkdir(dir, { mode: 0o700 });
      const peer = makeFifoWithLatePeer(join(dir, LOG_LOCK_FILE_NAME));
      try {
        const started = performance.now();
        const refused = expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 2 }));
        expect(performance.now() - started < FIFO_PEER_DELAY_MS).toBe(true);
        expect(refused.message.includes("not a regular file")).toBe(true);
      } finally {
        await stopPeer(peer);
      }
    });
  });

  test("a setup failure after the lock is taken releases the lock", async () => {
    await withRoot(async (root) => {
      const dir = join(root, "logs");
      await mkdir(dir, { mode: 0o700 });
      const rotated = join(dir, `${LOG_FILE_NAME}.1`);
      const peer = makeFifoWithLatePeer(rotated);
      try {
        expectLogFileError(() => rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 3 }));
      } finally {
        await stopPeer(peer);
      }
      await rm(rotated);
      rotatingFileLogger({ dir, maxFileBytes: 4096, maxFiles: 3 }).close();
    });
  });
});

describe("backend log destination", () => {
  test("a failed start is recorded in the configured log directory", async () => {
    const root = await createFixtureRoot("pk-log-");
    try {
      const logDir = join(root, "logs");
      let failed = false;
      try {
        await startBackendFromEnv({
          POHUNEK_BACKEND_BIND_HOST: "127.0.0.1",
          POHUNEK_BACKEND_PORT: "0",
          POHUNEK_BACKEND_ALLOW_LOOPBACK: "1",
          POHUNEK_BACKEND_DAEMON_SOCKET: join(root, "missing.sock"),
          POHUNEK_BACKEND_STATIC_DIR: root,
          POHUNEK_BACKEND_LOG_DIR: logDir,
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Real file operations whose next write, once armed, stores half of the line
 * and then fails like a disk filling up mid-write.
 */
function tornWriteIo(options: { readonly truncateFails: boolean }): {
  readonly io: LogFileIo;
  tearNextWrite(): void;
} {
  let armed = false;
  let tearing = false;
  return {
    io: {
      write(descriptor, bytes, offset): number {
        if (armed) {
          armed = false;
          tearing = true;
          const half = Math.floor((bytes.byteLength - offset) / 2);
          return writeSync(descriptor, bytes, offset, half);
        }
        if (tearing) {
          tearing = false;
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        }
        return writeSync(descriptor, bytes, offset);
      },
      truncate(descriptor, length): void {
        if (options.truncateFails) {
          throw Object.assign(new Error("input/output error"), { code: "EIO" });
        }
        ftruncateSync(descriptor, length);
      },
    },
    tearNextWrite(): void {
      armed = true;
    },
  };
}

async function jsonEvents(path: string): Promise<string[]> {
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  return lines.map((line) => (JSON.parse(line) as { event?: string }).event ?? "");
}

/**
 * Creates a FIFO and a helper process that opens it after `FIFO_PEER_DELAY_MS`.
 * A blocking open of the FIFO in the logger then returns late and fails the
 * elapsed-time check instead of freezing the suite.
 */
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
  /** First stdout line of the holder; rejects when it exits without printing one. */
  readonly firstLine: Promise<string>;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

/** Starts `support/log-holder.ts` on `dir`; it holds the directory until its stdin ends. */
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
  // A holder that is killed on purpose must not leave an unhandled rejection.
  firstLine.catch(() => undefined);
  return { child, firstLine, exited };
}

async function stopPeer(peer: ChildProcess): Promise<void> {
  if (peer.exitCode !== null || peer.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => peer.once("exit", () => resolve()));
  peer.kill();
  await exited;
}

function expectLogFileError(action: () => unknown): LogFileError {
  let failure: unknown;
  try {
    action();
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(LogFileError);
  return failure as LogFileError;
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pohunek-log-files-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
