// Window attach: the terminal of `attach_command` runs detached, with no stdin, and the TUI only
// checks that it does not exit within the launch window.

import { closeSync, openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

export interface AttachWindowOptions {
  /** A terminal that exits within this many milliseconds is a failed launch. */
  readonly launchCheckMs: number;
  /** Bytes of the terminal's stderr kept for a failed launch. */
  readonly stderrMaxBytes: number;
  /** Lines of that stderr shown in the status. */
  readonly stderrMaxLines: number;
}

export type AttachWindowResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Starts the terminal in its own process group and returns once the launch check has passed or failed.
 * The terminal writes stderr to a private file instead of a pipe, so it outlives the TUI and never gets a
 * broken pipe; a failed launch reads the file's bounded head, without waiting for the terminal's descendants.
 */
export async function openAttachWindow(argv: readonly string[], options: AttachWindowOptions): Promise<AttachWindowResult> {
  const [program] = argv;
  if (program === undefined) return { ok: false, message: "attach_command is empty" };
  const directory = await mkdtemp(join(tmpdir(), "pohunek-attach-"));
  const stderrPath = join(directory, "stderr.log");
  let child: Bun.Subprocess<"ignore", "ignore", number>;
  try {
    const stderr = openSync(stderrPath, "w", 0o600);
    try {
      child = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr, detached: true });
    } finally {
      closeSync(stderr);
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    return { ok: false, message: `cannot start ${program}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const exited = child.exited.then((code) => ({ code, signal: child.signalCode }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = new Promise<null>((resolve) => { timer = setTimeout(() => { resolve(null); }, options.launchCheckMs); });
  const outcome = await Promise.race([exited, running]);
  clearTimeout(timer);
  if (outcome === null) {
    child.unref();
    // The terminal keeps its own handle to the file, so the name can go.
    await rm(directory, { recursive: true, force: true });
    return { ok: true };
  }
  const detail = outcome.signal !== null ? `by signal ${outcome.signal}` : `with status ${String(outcome.code)}`;
  const head = await Bun.file(stderrPath).slice(0, options.stderrMaxBytes).text().catch(() => "");
  await rm(directory, { recursive: true, force: true });
  const lines = head.split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(0, options.stderrMaxLines);
  const suffix = lines.length === 0 ? "" : `; stderr: ${lines.join(" | ")}`;
  return { ok: false, message: `${basename(program)} exited ${detail} within the launch check${suffix}` };
}
