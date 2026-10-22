// Inline attach through a pseudo-terminal the TUI owns. The child sees a terminal of the TUI's size; its output reaches
// the TUI's terminal unchanged and the owner's input reaches the child, except a typed detach sequence, which becomes
// the Ctrl-] that `pohunek attach` detaches on. Terminals that cannot send Ctrl-] (phone SSH apps) can then detach.
import { outcomeOf, SpawnError, type ChildEnd, type InteractiveOutcome } from "./exec.ts";

/** Ctrl-] (ASCII Group Separator), the key `pohunek attach` detaches on. */
const DETACH_KEY = 0x1d;
const ESC = 0x1b;
/** `[` after Escape opens a CSI sequence, `O` an SS3 sequence; `~` ends the bracketed paste markers. */
const CSI_OPEN = 0x5b;
const SS3_OPEN = 0x4f;
const TILDE = 0x7e;
/** Shortest and longest detach sequence: one stray key never detaches, and the held prefix stays short. */
const SEQUENCE_MIN = 2;
const SEQUENCE_MAX = 16;
/** Printable ASCII without space, the bytes `PRINTABLE_FIRST..=PRINTABLE_LAST`. */
const DETACH_SEQUENCE_CHARS = /^[\x21-\x7e]+$/;
/** First and last printable ASCII byte without space; only these bytes can be part of a detach sequence. */
const PRINTABLE_FIRST = 0x21;
const PRINTABLE_LAST = 0x7e;
/** CSI final bytes occupy the inclusive ECMA-48 `0x40..=0x7e` range. */
const CSI_FINAL_FIRST = 0x40;
const CSI_FINAL_LAST = 0x7e;
/** Longest CSI parameter run kept while a sequence is open; a longer one is not a key report and is passed on. */
const CSI_MAX_PARAMS = 64;
/** Bracketed paste markers: text between them is pasted, never typed. */
const PASTE_START_PARAMS = "200";
const PASTE_END = Buffer.from("\x1b[201~");

/** Whether a sequence of typed characters is accepted as the detach sequence. */
export function isDetachSequence(value: string): boolean {
  return value.length >= SEQUENCE_MIN && value.length <= SEQUENCE_MAX && DETACH_SEQUENCE_CHARS.test(value);
}

type ScanState = "ground" | "escape" | "csi" | "ss3" | "paste";

/** What one chunk of input becomes: the bytes the child gets now, and whether the detach sequence was typed. */
export interface Scanned {
  readonly forward: Uint8Array;
  readonly detach: boolean;
}

/**
 * Finds the detach sequence in the owner's typed input. Bytes of a possible match are held until the next byte
 * decides; a byte that breaks the match releases them in order. Bytes of escape sequences and of bracketed paste
 * never match, so an arrow, Delete (`ESC[3~`) or a pasted text reaches the child unchanged.
 */
export class DetachScanner {
  private readonly sequence: Buffer;
  private held: number[] = [];
  private state: ScanState = "ground";
  private csiParams = "";
  private pasteEndMatched = 0;

  public constructor(sequence: string) {
    if (!isDetachSequence(sequence)) throw new TypeError("the detach sequence must be 2 to 16 printable ASCII characters without space");
    this.sequence = Buffer.from(sequence, "ascii");
  }

  public push(chunk: Uint8Array): Scanned {
    const forward: number[] = [];
    for (const byte of chunk) {
      if (this.state === "ground" && byte >= PRINTABLE_FIRST && byte <= PRINTABLE_LAST) {
        if (this.type(byte, forward)) return { forward: Uint8Array.from(forward), detach: true };
        continue;
      }
      forward.push(...this.held, byte);
      this.held = [];
      this.step(byte);
    }
    // A lone Escape ends its chunk: terminals write an escape sequence in one piece, so the Escape key was pressed.
    if (this.state === "escape") this.state = "ground";
    return { forward: Uint8Array.from(forward), detach: false };
  }

  /** Adds a typed printable byte to the match; true when it completes the sequence. */
  private type(byte: number, forward: number[]): boolean {
    const candidate = [...this.held, byte];
    if (candidate.length === this.sequence.length && this.startsSequence(candidate)) {
      this.held = [];
      return true;
    }
    // The longest tail of the typed bytes that can still begin the sequence stays held; the rest goes to the child.
    let keep = Math.min(candidate.length, this.sequence.length - 1);
    while (keep > 0 && !this.startsSequence(candidate.slice(candidate.length - keep))) keep -= 1;
    forward.push(...candidate.slice(0, candidate.length - keep));
    this.held = candidate.slice(candidate.length - keep);
    return false;
  }

  private startsSequence(bytes: readonly number[]): boolean {
    return bytes.every((byte, index) => this.sequence[index] === byte);
  }

  /** Follows escape sequences and bracketed paste for a byte that was passed on. */
  private step(byte: number): void {
    switch (this.state) {
      case "ground":
        if (byte === ESC) this.state = "escape";
        return;
      case "escape":
        if (byte === CSI_OPEN) { this.state = "csi"; this.csiParams = ""; }
        else if (byte === SS3_OPEN) this.state = "ss3";
        else if (byte !== ESC) this.state = "ground";
        return;
      case "ss3":
        this.state = "ground";
        return;
      case "csi":
        if (byte >= CSI_FINAL_FIRST && byte <= CSI_FINAL_LAST) {
          this.state = byte === TILDE && this.csiParams === PASTE_START_PARAMS ? "paste" : "ground";
          this.pasteEndMatched = 0;
        } else if (this.csiParams.length >= CSI_MAX_PARAMS) {
          this.state = "ground";
        } else {
          this.csiParams += String.fromCharCode(byte);
        }
        return;
      case "paste":
        this.pasteEndMatched = byte === PASTE_END[this.pasteEndMatched] ? this.pasteEndMatched + 1 : byte === PASTE_END[0] ? 1 : 0;
        if (this.pasteEndMatched === PASTE_END.length) this.state = "ground";
        return;
    }
  }
}

export interface RelayOptions {
  /** Typed characters that detach, as Ctrl-] does. */
  readonly detachSequence: string;
  /** Longest wait for the child's last output after it exited, so its terminal restore reaches the terminal. */
  readonly drainMs: number;
}

/**
 * Runs an interactive child in a pseudo-terminal relayed to this process's terminal, with the outcome contract of
 * `execInteractive`. The child's terminal follows this terminal's size; input is scanned for the detach sequence.
 */
export async function execInteractiveRelay(argv: readonly string[], end: ChildEnd | undefined, options: RelayOptions): Promise<InteractiveOutcome> {
  const [binary, ...args] = argv;
  if (binary === undefined) throw new TypeError("execInteractiveRelay requires a non-empty argv");
  const stdin = process.stdin;
  const stdout = process.stdout;
  const scanner = new DetachScanner(options.detachSequence);
  let closed!: () => void;
  const drained = new Promise<void>((resolve) => { closed = resolve; });
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([binary, ...args], {
      terminal: {
        cols: stdout.columns,
        rows: stdout.rows,
        data: (_terminal, data) => { stdout.write(data); },
        exit: () => { closed(); },
      },
    });
  } catch (cause) {
    throw new SpawnError(binary, cause);
  }
  const terminal = child.terminal;
  if (terminal === undefined) throw new SpawnError(binary, new Error("the child has no pseudo-terminal"));
  // Ink reads the terminal in paused mode through `readable` and may have set an encoding, so input is read the same
  // way: a `data` listener on a stream once read through `readable` receives nothing.
  const onReadable = (): void => {
    for (let chunk: unknown = stdin.read(); chunk !== null; chunk = stdin.read()) {
      const scanned = scanner.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk as Uint8Array);
      if (scanned.forward.length > 0) terminal.write(scanned.forward);
      if (scanned.detach) terminal.write(Uint8Array.of(DETACH_KEY));
    }
  };
  const onResize = (): void => { terminal.resize(stdout.columns, stdout.rows); };
  const ending: { ended: boolean; killTimer?: ReturnType<typeof setTimeout> } = { ended: false };
  const stopWatching = end?.watch(() => {
    if (ending.ended) return;
    ending.ended = true;
    child.kill("SIGTERM");
    ending.killTimer = setTimeout(() => { child.kill("SIGKILL"); }, end.graceMs);
  });
  stdin.setRawMode(true);
  stdin.ref();
  stdin.on("readable", onReadable);
  stdout.on("resize", onResize);
  try {
    await child.exited;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([drained, new Promise<void>((resolve) => { drainTimer = setTimeout(resolve, options.drainMs); })]);
    clearTimeout(drainTimer);
  } finally {
    stopWatching?.();
    clearTimeout(ending.killTimer);
    stdout.off("resize", onResize);
    stdin.off("readable", onReadable);
    stdin.setRawMode(false);
    stdin.unref();
    terminal.close();
  }
  return outcomeOf(child, ending.ended);
}
