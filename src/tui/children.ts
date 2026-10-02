// Child processes of the TUI. `list` and the preview run piped with a timeout
// through util/exec.ts (own process group, killed whole on timeout); a
// handover runs the child in the foreground on the TUI's terminal; `o` starts
// the URL opener detached.
import { SpawnError, type Exec } from "../util/exec.ts";
import type { Argv } from "./actions.ts";
import { decodeDoEnvelope, decodeListEnvelope, type DoOutcome, type ListOutcome } from "./decode.ts";
import type { ChildRun, HandoverExit, HandoverMode } from "./model.ts";
import type { Terminal } from "./terminal.ts";

export interface ListRun {
  readonly run: ChildRun;
  readonly outcome: ListOutcome | null;
  readonly durationMs: number;
}

function stderrLines(stderr: string): string[] {
  return stderr.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
}

async function piped<T>(
  exec: Exec,
  argv: Argv,
  timeoutMs: number,
  decode: (stdout: string) => T,
): Promise<{ run: ChildRun; outcome: T | null }> {
  try {
    const result = await exec(argv, { timeoutMs });
    const run: ChildRun = {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      spawnError: null,
      stderr: stderrLines(result.stderr),
    };
    // Exit 2 and 3 still carry an envelope on stdout, so stdout is decoded whatever the exit code.
    const outcome = result.timedOut || result.stdout.trim() === "" ? null : decode(result.stdout);
    return { run, outcome };
  } catch (error) {
    if (!(error instanceof SpawnError)) throw error;
    return { run: { exitCode: null, timedOut: false, spawnError: `cannot start ${error.binary}`, stderr: [] }, outcome: null };
  }
}

export async function runList(exec: Exec, argv: Argv, timeoutMs: number, now: () => number): Promise<ListRun> {
  const started = now();
  const { run, outcome } = await piped(exec, argv, timeoutMs, decodeListEnvelope);
  return { run, outcome, durationMs: now() - started };
}

/** `do --dry-run --json`: read-only, piped, with the list timeout. */
export async function runPreview(exec: Exec, argv: Argv, timeoutMs: number): Promise<{ run: ChildRun; outcome: DoOutcome | null }> {
  return piped(exec, argv, timeoutMs, decodeDoEnvelope);
}

export interface ForegroundExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
}

/** Runs a child on the TUI's terminal; throws SpawnError when it cannot start. */
export type ForegroundSpawn = (argv: Argv, stdout: "inherit" | "pipe") => Promise<ForegroundExit>;

/**
 * Stdin and stderr inherited, stdout piped for a write (`do --json` prints its
 * envelope there) or inherited for attach. Never detached: a child outside
 * the foreground process group is stopped by SIGTTIN when it reads the terminal.
 */
export const spawnForeground: ForegroundSpawn = async (argv, stdout) => {
  const [binary, ...args] = argv;
  if (binary === undefined) throw new TypeError("spawnForeground requires a non-empty argv");
  if (stdout === "pipe") {
    const child = started(binary, () => Bun.spawn([binary, ...args], { stdin: "inherit", stdout: "pipe", stderr: "inherit" }));
    const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { exitCode: child.exitCode, signal: child.signalCode, stdout: text };
  }
  const child = started(binary, () => Bun.spawn([binary, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }));
  await child.exited;
  return { exitCode: child.exitCode, signal: child.signalCode, stdout: "" };
};

/** Bun.spawn throws synchronously when the binary is missing or not executable. */
function started<T>(binary: string, spawn: () => T): T {
  try {
    return spawn();
  } catch (cause) {
    throw new SpawnError(binary, cause);
  }
}

export const RETURN_PROMPT = "\r\npress Enter to return to pohunek-work tui ";

/**
 * Hands the terminal to a `do` child and takes it back. After a write, a
 * failed start or a non-zero exit the owner reads the child's output and
 * presses Enter; a clean detach from attach returns directly.
 */
export async function runHandover(
  terminal: Terminal,
  spawn: ForegroundSpawn,
  mode: HandoverMode,
  argv: Argv,
): Promise<HandoverExit> {
  try {
    return await terminal.handover(async () => {
      let exit: HandoverExit;
      try {
        const result = await spawn(argv, mode === "write" ? "pipe" : "inherit");
        exit = { ...result, spawnError: null };
      } catch (error) {
        if (!(error instanceof SpawnError)) throw error;
        exit = { exitCode: null, signal: null, stdout: "", spawnError: `cannot start ${error.binary}` };
      }
      const cleanDetach = mode === "attach" && exit.exitCode === 0;
      if (!cleanDetach) await terminal.awaitEnter(RETURN_PROMPT);
      return exit;
    });
  } finally {
    terminal.resume();
  }
}

/** Starts a child that outlives nothing of the TUI: own process group, no stdio. Throws SpawnError. */
export type DetachedSpawn = (argv: Argv) => void;

export const spawnDetached: DetachedSpawn = (argv) => {
  const [binary, ...args] = argv;
  if (binary === undefined) throw new TypeError("spawnDetached requires a non-empty argv");
  // Browser chatter on stdout or stderr would land in the frame, so every stream is ignored.
  const child = started(binary, () =>
    Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }),
  );
  child.unref();
};

/** `open_command <href>` with the parsed URL as one argv element; returns an error text or null. */
export function openUrl(spawn: DetachedSpawn, openCommand: string, href: string): string | null {
  try {
    spawn([openCommand, href]);
    return null;
  } catch (error) {
    if (!(error instanceof SpawnError)) throw error;
    return `cannot start ${error.binary}`;
  }
}
