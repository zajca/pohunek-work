// Runs a command with TMPDIR set to a fresh private directory and fails when the
// command leaves anything in it. `bun run test` wraps the suite with it, so a test
// that does not remove its temporary files fails the gate. The private directory
// itself is always removed.
//
// usage: bun scripts/private-tmpdir.ts <command> [args...]
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DIR_PREFIX = "pohunek-test-tmpdir-";
/** Status when the command succeeded but left entries behind. */
const LEFTOVER_STATUS = 1;
/** Status of a usage error. */
const USAGE_STATUS = 2;
/** Shell convention for a child ended by a signal: 128 plus the signal number. */
const SIGNAL_STATUS_BASE = 128;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export interface PrivateTmpdirRun {
  /** The command's status, or `LEFTOVER_STATUS` when it succeeded but left entries. */
  readonly status: number;
  /** Names of the entries the command left in the private directory. */
  readonly leftovers: readonly string[];
}

function signalStatus(signal: NodeJS.Signals | null): number {
  if (signal === null) throw new Error("the command ended with neither an exit code nor a signal");
  return SIGNAL_STATUS_BASE + constants.signals[signal];
}

/** Runs `argv` with TMPDIR set to a new directory under `parent`, then removes that directory. */
export async function runWithPrivateTmpdir(argv: readonly string[], parent: string): Promise<PrivateTmpdirRun> {
  const dir = await mkdtemp(join(parent, PRIVATE_DIR_PREFIX));
  try {
    const child = Bun.spawn([...argv], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, TMPDIR: dir },
    });
    // The wrapper outlives a signal so the private directory is still removed.
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    try {
      await child.exited;
    } finally {
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
    }
    const commandStatus = child.exitCode ?? signalStatus(child.signalCode);
    const leftovers = (await readdir(dir)).sort();
    const status = commandStatus === 0 && leftovers.length > 0 ? LEFTOVER_STATUS : commandStatus;
    return { status, leftovers };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error("usage: bun scripts/private-tmpdir.ts <command> [args...]");
    process.exit(USAGE_STATUS);
  }
  const run = await runWithPrivateTmpdir(argv, tmpdir());
  if (run.leftovers.length > 0) {
    console.error(`private-tmpdir: entries left in TMPDIR (${run.leftovers.length}):`);
    for (const name of run.leftovers) console.error(`  ${name}`);
  }
  process.exit(run.status);
}
