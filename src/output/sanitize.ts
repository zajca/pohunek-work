// Sanitizers for untrusted text (provider titles, URLs, session names, child
// output) on its way to a terminal. A leaf module: no pipeline imports, so the
// TUI may use it.

/**
 * C0 and C1 control characters become spaces; everything else is kept. Used
 * for provider text inside the prompt, which an agent reads, not a terminal.
 */
export function sanitizeCell(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

const PRINTABLE_LOW = 0x20;
const PRINTABLE_HIGH = 0x7e;
const REPLACEMENT = "?";
const COMBINING_MARK = /\p{M}/gu;

/**
 * Strict ASCII: NFKD, combining marks dropped (Czech titles stay readable),
 * every other character outside 0x20-0x7E becomes `?`. Removes ESC, OSC 8 and
 * OSC 52 sequences' introducers, bidi overrides, zero-width characters and
 * line breaks, so every result character is one terminal column wide.
 */
export function toAscii(text: string): string {
  let out = "";
  for (const char of text.normalize("NFKD").replace(COMBINING_MARK, "")) {
    const code = char.codePointAt(0) ?? 0;
    out += code >= PRINTABLE_LOW && code <= PRINTABLE_HIGH ? char : REPLACEMENT;
  }
  return out;
}

/** Splits on any line break and applies `toAscii` to each line. */
export function toAsciiLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map(toAscii);
}
