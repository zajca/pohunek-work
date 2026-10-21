// Drives a command in a pseudo-terminal. Scenarios assert on the plain text the program
// printed, in order, so each expectation must appear after the previous one.
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PtyStep =
  | { readonly expect: string; readonly timeout?: number }
  | { readonly send: string; readonly settle?: number }
  | { readonly pause: number }
  | { readonly clear: true }
  | { readonly absent: string; readonly pause?: number };

export interface PtyRun {
  readonly cmd: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
  readonly steps: readonly PtyStep[];
  readonly cwd?: string;
  readonly timeoutS?: number;
}

export interface PtyResult {
  /** Index of the first step that did not complete, or -1. */
  readonly failed: number;
  readonly exit: number | null;
  readonly output: string;
}

const DRIVER = new URL("./pty-driver.py", import.meta.url).pathname;
/** Ends a driver still running when its caller leaves, so no driver outlives the directory it reads its spec from. */
const STOP_SIGNAL = "SIGTERM";

export function keys(text: string): { send: string } {
  return { send: Buffer.from(text).toString("hex") };
}

export async function runPty(run: PtyRun): Promise<PtyResult> {
  const directory = await mkdtemp(join(tmpdir(), "pw-pty-"));
  let driver: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  // A test that is abandoned while its run is pending leaves this promise unsettled, so the process exit removes the
  // directory and ends the driver; the same cleanup runs on every exit of this function.
  const onExit = (): void => {
    if (driver !== undefined && driver.exitCode === null) driver.kill(STOP_SIGNAL);
    rmSync(directory, { recursive: true, force: true });
  };
  process.once("exit", onExit);
  try {
    const spec = join(directory, "spec.json");
    await writeFile(spec, JSON.stringify(run));
    const running = Bun.spawn(["python3", DRIVER, spec], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    driver = running;
    const [stdout, stderr, exit] = await Promise.all([new Response(running.stdout).text(), new Response(running.stderr).text(), running.exited]);
    if (exit !== 0) throw new Error(`pty driver exited ${String(exit)}: ${stderr}`);
    return JSON.parse(stdout) as PtyResult;
  } finally {
    process.off("exit", onExit);
    // The driver reads its spec from the directory, so it has ended before the directory is removed.
    if (driver !== undefined && driver.exitCode === null) driver.kill(STOP_SIGNAL);
    await driver?.exited;
    await rm(directory, { recursive: true, force: true });
  }
}
