import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  BackendConfigError,
  loadBackendConfig,
  startBackend,
  type BackendHandle,
  type BackendLogger,
} from "@pohunek/backend";
import type { RuntimePathContext } from "@pohunek/sdk";
import { startFixtureDaemon, type FixtureDaemonHandle } from "@pohunek/testkit";

const TEST_RUNTIME_DIR = "/tmp/pohunek-backend-config-runtime";

function baseEnv(): NodeJS.ProcessEnv {
  return {
    POHUNEK_BACKEND_BIND_HOST: "100.64.0.10",
    POHUNEK_BACKEND_PORT: "8080",
    XDG_RUNTIME_DIR: TEST_RUNTIME_DIR,
    POHUNEK_BACKEND_DAEMON_WAIT: "0",
  };
}

describe("runtime directory created by the daemon", () => {
  test("a missing runtime directory is waited for and verified once it appears", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "pk-wait-")));
    const uid = process.geteuid?.() ?? 0;
    const context: RuntimePathContext = { platform: "linux", effectiveUid: uid };
    const runtimeDir = join(base, "pohunek");
    const env = {
      ...baseEnv(),
      XDG_RUNTIME_DIR: base,
      POHUNEK_BACKEND_DAEMON_WAIT: "30",
      POHUNEK_BACKEND_DAEMON_RETRY_INTERVAL: "0.02",
      POHUNEK_BACKEND_ALLOW_LOOPBACK: "1",
      POHUNEK_BACKEND_BIND_HOST: "127.0.0.1",
      POHUNEK_BACKEND_PORT: "0",
      POHUNEK_BACKEND_STATIC_DIR: base,
    };
    let announceWaiting: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      announceWaiting = resolve;
    });
    const logger: BackendLogger = {
      log(event): void {
        if (event.event === "daemon_connection" && event.lifecycle === "waiting") {
          announceWaiting();
        }
      },
    };
    let daemon: FixtureDaemonHandle | undefined;
    let backend: BackendHandle | undefined;
    try {
      const starting = startBackend(loadBackendConfig(env, context), logger);
      await Promise.race([waiting, starting]);

      await mkdir(runtimeDir, { mode: 0o700 });
      daemon = await startFixtureDaemon({ listen: { unixSocketPath: join(runtimeDir, "daemon.sock") } });
      backend = await starting;
      expect(backend.hosts.snapshot()[0]?.reachability).toBe("reachable_daemon");
    } finally {
      await backend?.close();
      await daemon?.close();
      await rm(base, { recursive: true, force: true });
    }
  });

  test("a runtime directory with the wrong mode that appears while waiting stops startup", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "pk-wait-")));
    const uid = process.geteuid?.() ?? 0;
    const context: RuntimePathContext = { platform: "linux", effectiveUid: uid };
    const env = {
      ...baseEnv(),
      XDG_RUNTIME_DIR: base,
      POHUNEK_BACKEND_DAEMON_WAIT: "30",
      POHUNEK_BACKEND_DAEMON_RETRY_INTERVAL: "0.02",
    };
    try {
      const starting = startBackend(loadBackendConfig(env, context), { log: (): void => undefined });
      const settled = starting.then(
        () => undefined,
        (error: unknown) => error,
      );
      await mkdir(join(base, "pohunek"), { mode: 0o750 });

      const failure = await settled;
      expect(failure).toBeInstanceOf(BackendConfigError);
      expect((failure as BackendConfigError).message.includes("mode 0700")).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("runtime directory trust", () => {
  test("startup refuses a derived runtime directory that is not the user's own 0700 directory", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "pk-trust-")));
    const uid = process.geteuid?.() ?? 0;
    const context: RuntimePathContext = { platform: "linux", effectiveUid: uid };
    const env = { ...baseEnv(), XDG_RUNTIME_DIR: base };
    const runtimeDir = join(base, "pohunek");
    try {
      // Absent: a directory created after the check would not be checked.
      await expectRefused(env, context, "does not exist");

      await mkdir(runtimeDir, { mode: 0o700 });
      await chmod(runtimeDir, 0o750);
      await expectRefused(env, context, "mode 0700");
      await chmod(runtimeDir, 0o700);

      // Another user's directory: the same check with a different effective uid.
      await expectRefused(env, { platform: "linux", effectiveUid: uid + 1 }, "not owned");

      await mkdir(join(runtimeDir, "daemon.sock"));
      await expectRefused(env, context, "not a socket");
      await rm(join(runtimeDir, "daemon.sock"), { recursive: true });

      await rm(runtimeDir, { recursive: true });
      const elsewhere = join(base, "elsewhere");
      await mkdir(elsewhere, { mode: 0o700 });
      await symlink(elsewhere, runtimeDir);
      await expectRefused(env, context, "not a real directory");

      // A parent that is not a directory reports the cause instead of a raw errno.
      await expectRefused({ ...baseEnv(), XDG_RUNTIME_DIR: "/dev/null" }, context, "cannot be inspected");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

async function expectRefused(
  env: NodeJS.ProcessEnv,
  context: RuntimePathContext,
  reason: string,
): Promise<void> {
  let failure: unknown;
  try {
    await startBackend(loadBackendConfig(env, context), { log: (): void => undefined });
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BackendConfigError);
  const refusal = failure as BackendConfigError;
  expect(refusal.variable).toBe("XDG_RUNTIME_DIR");
  expect(refusal.message.includes(reason)).toBe(true);
}

describe("backend startup diagnostics", () => {
  test("a configuration error reaches the operator with the variable and the reason", async () => {
    const { code, stderr } = await runEntrypoint({ XDG_RUNTIME_DIR: "relative/run" });
    expect(code).toBe(1);
    expect(stderr.includes("XDG_RUNTIME_DIR must be an absolute path")).toBe(true);
  });

  test("an invalid daemon wait or retry interval names its variable", async () => {
    const wait = await runEntrypoint({ POHUNEK_BACKEND_DAEMON_WAIT: "-1" });
    expect(wait.code).toBe(1);
    expect(wait.stderr.includes("POHUNEK_BACKEND_DAEMON_WAIT must be a non-negative number")).toBe(true);

    const interval = await runEntrypoint({ POHUNEK_BACKEND_DAEMON_RETRY_INTERVAL: "0" });
    expect(interval.code).toBe(1);
    expect(interval.stderr.includes("POHUNEK_BACKEND_DAEMON_RETRY_INTERVAL must be a positive number")).toBe(true);
  });
});

async function runEntrypoint(
  extraEnv: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly stderr: string }> {
  const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "../src/entrypoint.ts");
  const child = spawn(process.execPath, [entrypoint], {
    env: {
      PATH: process.env["PATH"] ?? "",
      POHUNEK_BACKEND_BIND_HOST: "100.64.0.10",
      POHUNEK_BACKEND_PORT: "8080",
      XDG_RUNTIME_DIR: TEST_RUNTIME_DIR,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string): void => {
    stderr += chunk;
  });
  child.stdout.resume();
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, stderr };
}
