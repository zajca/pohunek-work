// Drives a command in a pseudo-terminal. Scenarios assert on the plain text the program
// printed, in order, so each expectation must appear after the previous one.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PtyStep =
  | { readonly expect: string; readonly timeout?: number }
  | { readonly send: string; readonly settle?: number }
  | { readonly pause: number };

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

export function keys(text: string): { send: string } {
  return { send: Buffer.from(text).toString("hex") };
}

export async function runPty(run: PtyRun): Promise<PtyResult> {
  const directory = await mkdtemp(join(tmpdir(), "pw-pty-"));
  try {
    const spec = join(directory, "spec.json");
    await writeFile(spec, JSON.stringify(run));
    const driver = Bun.spawn(["python3", DRIVER, spec], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(driver.stdout).text(), new Response(driver.stderr).text(), driver.exited]);
    if (exit !== 0) throw new Error(`pty driver exited ${String(exit)}: ${stderr}`);
    return JSON.parse(stdout) as PtyResult;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
