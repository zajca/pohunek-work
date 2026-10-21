// Readable text of a session's PTY output for the detail panel. Escape sequences are removed, a carriage
// return rewrites the line it is on, and only the newest retained characters are kept.

// CSI, OSC and two-byte escape sequences.
// eslint-disable-next-line no-control-regex
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export class LiveOutput {
  private readonly decoder = new TextDecoder("utf-8");
  private retained = "";

  /** Keeps at most `retainChars` characters of the newest raw output; escape sequences may be split across appends. */
  public constructor(private readonly retainChars: number) {}

  public append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const text = this.retained + this.decoder.decode(bytes, { stream: true });
    this.retained = text.length > this.retainChars ? text.slice(text.length - this.retainChars) : text;
  }

  /** Marks output the daemon no longer retains between the previous and the next read. */
  public markGap(): void {
    this.retained += "\n[output not retained]\n";
  }

  /** The retained output as lines; the last line may still be growing. */
  public lines(): string[] {
    const plain = this.retained.replace(ESCAPE_SEQUENCE, "").replaceAll("\r\n", "\n");
    return plain.split("\n").map((line) => {
      const rewritten = line.slice(line.lastIndexOf("\r") + 1);
      return rewritten.replace(CONTROL_CHARACTER, "");
    });
  }
}
