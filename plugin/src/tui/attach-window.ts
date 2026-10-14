import { basename } from "node:path";

// Window attach: the terminal of `attach_command` runs detached, with no stdin, and the TUI only
// checks that it does not exit within the launch window.

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
 * A terminal still running after the check is left alone; its stderr is drained so it never blocks.
 */
export async function openAttachWindow(argv: readonly string[], options: AttachWindowOptions): Promise<AttachWindowResult> {
  const [program] = argv;
  if (program === undefined) return { ok: false, message: "attach_command is empty" };
  let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
  try {
    child = Bun.spawn([...argv], { stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: true });
  } catch (error) {
    return { ok: false, message: `cannot start ${program}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const stderr = collectStderr(child.stderr, options.stderrMaxBytes);
  const exited = child.exited.then((code) => ({ code, signal: child.signalCode }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const running = new Promise<null>((resolve) => { timer = setTimeout(() => { resolve(null); }, options.launchCheckMs); });
  const outcome = await Promise.race([exited, running]);
  clearTimeout(timer);
  if (outcome === null) {
    child.unref();
    void stderr.catch(() => undefined);
    return { ok: true };
  }
  const detail = outcome.signal !== null ? `by signal ${outcome.signal}` : `with status ${String(outcome.code)}`;
  const lines = (await stderr).split("\n").map((line) => line.trim()).filter((line) => line !== "").slice(0, options.stderrMaxLines);
  const suffix = lines.length === 0 ? "" : `; stderr: ${lines.join(" | ")}`;
  return { ok: false, message: `${basename(program)} exited ${detail} within the launch check${suffix}` };
}

/** Reads the stream to its end, keeping at most `maxBytes` of it. */
async function collectStderr(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let kept = 0;
  for await (const chunk of stream) {
    if (kept < maxBytes) {
      const room = chunk.subarray(0, maxBytes - kept);
      text += decoder.decode(room, { stream: true });
      kept += room.byteLength;
    }
  }
  return text + decoder.decode();
}
