// Window attach: the terminal of `attach_command` runs detached with null stdio, as the native GUI runs it.
// The TUI only checks that it does not exit within the launch window.

import { basename } from "node:path";

export interface AttachWindowOptions {
  /** A terminal that exits within this many milliseconds is a failed launch. */
  readonly launchCheckMs: number;
}

export type AttachWindowResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/**
 * Starts the terminal in its own process group and returns once the launch check has passed or failed.
 * Its stdio is null: a detached terminal's stderr cannot be bounded in the TUI and would die with the TUI's pipe.
 */
export async function openAttachWindow(argv: readonly string[], options: AttachWindowOptions): Promise<AttachWindowResult> {
  const [program] = argv;
  if (program === undefined) return { ok: false, message: "attach_command is empty" };
  let child: Bun.Subprocess<"ignore", "ignore", "ignore">;
  try {
    child = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  } catch (error) {
    return { ok: false, message: `cannot start ${program}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const exited = child.exited.then((code) => ({ code, signal: child.signalCode }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = new Promise<null>((resolve) => { timer = setTimeout(() => { resolve(null); }, options.launchCheckMs); });
  const outcome = await Promise.race([exited, running]);
  clearTimeout(timer);
  if (outcome === null) {
    child.unref();
    return { ok: true };
  }
  const detail = outcome.signal !== null ? `by signal ${outcome.signal}` : `with status ${String(outcome.code)}`;
  return { ok: false, message: `${basename(program)} exited ${detail} within the launch check` };
}
