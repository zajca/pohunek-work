// Terminal driver of the TUI: raw mode, alternate screen, key decoding,
// resize, the handover of the terminal to a child and its restore on every
// exit path. The only module that writes control sequences.
import { constants } from "node:os";

const ESC = "\u001b";
const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
const LEAVE_ALT_SCREEN = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CURSOR_HOME = `${ESC}[H`;
const CLEAR_BELOW = `${ESC}[J`;
const BELL = "\u0007";

export type NamedKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "enter"
  | "tab"
  | "backTab"
  | "escape"
  | "backspace"
  | "ctrlC";

export type Key = { readonly kind: "char"; readonly char: string } | { readonly kind: NamedKey };

const SEQUENCES: Readonly<Record<string, NamedKey>> = {
  [`${ESC}[A`]: "up",
  [`${ESC}[B`]: "down",
  [`${ESC}[C`]: "right",
  [`${ESC}[D`]: "left",
  [`${ESC}OA`]: "up",
  [`${ESC}OB`]: "down",
  [`${ESC}OC`]: "right",
  [`${ESC}OD`]: "left",
  [`${ESC}[5~`]: "pageUp",
  [`${ESC}[6~`]: "pageDown",
  [`${ESC}[H`]: "home",
  [`${ESC}OH`]: "home",
  [`${ESC}[1~`]: "home",
  [`${ESC}[7~`]: "home",
  [`${ESC}[F`]: "end",
  [`${ESC}OF`]: "end",
  [`${ESC}[4~`]: "end",
  [`${ESC}[8~`]: "end",
  [`${ESC}[Z`]: "backTab",
};

const CONTROL_KEYS: Readonly<Record<string, NamedKey>> = {
  "\r": "enter",
  "\n": "enter",
  "\t": "tab",
  "\u007f": "backspace",
  "\b": "backspace",
  "\u0003": "ctrlC",
};

function inRange(text: string, index: number, low: number, high: number): boolean {
  const code = text.charCodeAt(index);
  return !Number.isNaN(code) && code >= low && code <= high;
}

/**
 * Decodes one read from the terminal. A terminal writes an escape sequence in
 * a single write, so an ESC that ends the chunk is the Esc key. Unknown
 * sequences, Alt combinations, other control bytes and non-ASCII input are
 * dropped: every command key is ASCII.
 */
export function decodeKeys(input: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < input.length) {
    const char = input.charAt(i);
    if (char === ESC) {
      const next = input.charAt(i + 1);
      if (next === "" || next === ESC) {
        keys.push({ kind: "escape" });
        i += 1;
        continue;
      }
      if (next === "[" || next === "O") {
        // CSI/SS3: parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F, one final byte 0x40-0x7E.
        let end = i + 2;
        while (inRange(input, end, 0x30, 0x3f)) end += 1;
        while (inRange(input, end, 0x20, 0x2f)) end += 1;
        if (!inRange(input, end, 0x40, 0x7e)) {
          i = end;
          continue;
        }
        const named = SEQUENCES[input.slice(i, end + 1)];
        if (named !== undefined) keys.push({ kind: named });
        i = end + 1;
        continue;
      }
      // Alt plus a key: not a command.
      i += 2;
      continue;
    }
    const control = CONTROL_KEYS[char];
    if (control !== undefined) {
      keys.push({ kind: control });
    } else if (inRange(input, i, 0x20, 0x7e)) {
      keys.push({ kind: "char", char });
    }
    i += 1;
  }
  return keys;
}

export interface Size {
  readonly columns: number;
  readonly rows: number;
}

/** The parts of `process.stdin` the driver uses. */
export interface TtyInput {
  setRawMode(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

/** The parts of `process.stdout` the driver uses. */
export interface TtyOutput {
  write(text: string): unknown;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export type TerminatingSignal = "SIGTERM" | "SIGHUP";

/** The parts of `process` the driver uses for signals and exit. */
export interface ProcessHooks {
  on(event: "SIGINT" | TerminatingSignal, listener: () => void): unknown;
  off(event: "SIGINT" | TerminatingSignal, listener: () => void): unknown;
  exit(code: number): never;
}

export interface TerminalHandlers {
  readonly onKey: (key: Key) => void;
  readonly onResize: (size: Size) => void;
  /** Called after the restore when SIGTERM or SIGHUP ends the TUI; the exit waits for its promise. */
  readonly onSignal: (signal: TerminatingSignal) => Promise<void> | void;
}

export interface Terminal {
  /** Enters raw mode and the alternate screen and starts delivering keys and resizes. */
  start(handlers: TerminalHandlers): void;
  size(): Size;
  /** Full redraw; ignored while the terminal is handed over. */
  draw(lines: readonly string[]): void;
  bell(): void;
  /**
   * Hands the terminal to `body` (a foreground child): main screen, cooked
   * mode, cursor on, no key delivery, and SIGINT ignored by the TUI, because
   * Ctrl-C at a child prompt reaches the whole foreground process group.
   */
  handover<T>(body: () => Promise<T>): Promise<T>;
  /** While handed over: shows `prompt` and discards input up to Enter (stray bytes included). */
  awaitEnter(prompt: string): Promise<void>;
  /** Takes the terminal back after a handover: alternate screen, raw mode, key delivery. */
  resume(): void;
  /** Raw mode off, main screen, cursor on. Idempotent; safe on every exit path. */
  restore(): void;
}

const SIGNAL_EXIT_BASE = 128;

export function signalExitCode(signal: TerminatingSignal): number {
  return SIGNAL_EXIT_BASE + constants.signals[signal];
}

export function createTerminal(input: TtyInput, output: TtyOutput, hooks: ProcessHooks): Terminal {
  let handlers: TerminalHandlers | null = null;
  let active = false;
  let handedOver = false;

  const write = (text: string): void => {
    output.write(text);
  };

  const onData = (chunk: Buffer | string): void => {
    if (handlers === null || handedOver) return;
    for (const key of decodeKeys(chunk.toString())) handlers.onKey(key);
  };
  const size = (): Size => ({ columns: output.columns ?? 0, rows: output.rows ?? 0 });
  const onResize = (): void => {
    handlers?.onResize(size());
  };
  const ignoreSigint = (): void => undefined;

  const enterScreen = (): void => {
    input.setRawMode(true);
    write(ENTER_ALT_SCREEN + HIDE_CURSOR);
    input.on("data", onData);
    input.resume();
  };
  const leaveScreen = (): void => {
    input.off("data", onData);
    input.pause();
    input.setRawMode(false);
    write(SHOW_CURSOR + LEAVE_ALT_SCREEN);
  };

  const terminal: Terminal = {
    start(next) {
      if (active) throw new Error("terminal already started");
      handlers = next;
      active = true;
      hooks.on("SIGTERM", onSigterm);
      hooks.on("SIGHUP", onSighup);
      output.on("resize", onResize);
      enterScreen();
    },
    size,
    draw(lines) {
      if (!active || handedOver) return;
      const { columns } = size();
      write(CURSOR_HOME + lines.map((line) => line.padEnd(columns)).join("\r\n") + CLEAR_BELOW);
    },
    bell() {
      if (active && !handedOver) write(BELL);
    },
    async handover(body) {
      if (!active || handedOver) throw new Error("terminal is not available for a handover");
      handedOver = true;
      leaveScreen();
      hooks.on("SIGINT", ignoreSigint);
      try {
        return await body();
      } finally {
        hooks.off("SIGINT", ignoreSigint);
      }
    },
    async awaitEnter(prompt) {
      if (!handedOver) throw new Error("awaitEnter needs a handed-over terminal");
      write(prompt);
      input.setRawMode(true);
      try {
        await new Promise<void>((resolve) => {
          const listener = (chunk: Buffer | string): void => {
            if (!/[\r\n]/.test(chunk.toString())) return;
            input.off("data", listener);
            resolve();
          };
          input.on("data", listener);
          input.resume();
        });
      } finally {
        input.pause();
        input.setRawMode(false);
        write("\r\n");
      }
    },
    resume() {
      if (!handedOver) return;
      handedOver = false;
      enterScreen();
    },
    restore() {
      if (!active) return;
      active = false;
      hooks.off("SIGTERM", onSigterm);
      hooks.off("SIGHUP", onSighup);
      output.off("resize", onResize);
      if (handedOver) {
        // The screen was already left for the handover; only the mode needs a reset.
        input.setRawMode(false);
        input.pause();
        return;
      }
      leaveScreen();
    },
  };

  async function terminate(signal: TerminatingSignal): Promise<void> {
    try {
      terminal.restore();
      await handlers?.onSignal(signal);
    } finally {
      hooks.exit(signalExitCode(signal));
    }
  }
  function onSigterm(): void {
    void terminate("SIGTERM");
  }
  function onSighup(): void {
    void terminate("SIGHUP");
  }

  return terminal;
}
