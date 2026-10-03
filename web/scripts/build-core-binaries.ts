// Builds the core binaries the real-daemon tests drive (pohunekd,
// pohunek-sessiond, pohunek) from the revision pinned in web/core-sdk.json and
// prints the environment variables that locate them.
//
// usage: eval "$(bun scripts/build-core-binaries.ts [INSTALL_ROOT])"
//
// The binaries are installed from the exact revision with that revision's
// lockfile. The worker lands beside the daemon, where the daemon looks for it.
// The default root is `.core-sdk/core-binaries/<rev>`, which names the revision,
// so binaries already installed there are reused. Cargo output goes to stderr so
// stdout stays evaluable. Set `CARGO_TARGET_DIR` to keep cargo's build output
// off a small temporary file system.

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WORK_DIR, loadPin } from "./core-sdk";

const CRATES = ["pohunek-daemon", "pohunek-session-worker", "pohunek-cli"] as const;

function install(args: readonly string[]): Promise<void> {
  return new Promise((resolveInstall, reject) => {
    const child = spawn("cargo", [...args], { stdio: ["ignore", process.stderr, process.stderr] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolveInstall();
      } else {
        reject(new Error(`cargo install exited with status ${String(code)}`));
      }
    });
  });
}

async function allExecutable(paths: readonly string[]): Promise<boolean> {
  try {
    await Promise.all(paths.map((path) => access(path, constants.X_OK)));
    return true;
  } catch {
    return false;
  }
}

// Single-quoted so the value survives `eval` unchanged.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main(): Promise<void> {
  const pin = loadPin();
  const root = resolve(process.argv[2] ?? join(WORK_DIR, "core-binaries", pin.coreRev));
  const exports: Record<string, string> = {
    POHUNEK_DAEMON_BIN: join(root, "bin", "pohunekd"),
    POHUNEK_WORKER_BIN: join(root, "bin", "pohunek-sessiond"),
    POHUNEK_CLI_BIN: join(root, "bin", "pohunek"),
  };
  if (!(await allExecutable(Object.values(exports)))) {
    await install([
      "install",
      "--locked",
      "--debug",
      "--git",
      pin.coreRepository,
      "--rev",
      pin.coreRev,
      "--root",
      root,
      ...CRATES,
    ]);
  }
  for (const [name, value] of Object.entries(exports)) {
    process.stdout.write(`export ${name}=${shellQuote(value)}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`build-core-binaries: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
