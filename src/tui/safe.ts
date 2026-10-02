// SafeText: text that went through strict ASCII sanitizing. `view.ts` builds
// frames only from SafeText, so untrusted text cannot reach the terminal raw.
import { toAscii, toAsciiLines } from "../output/sanitize.ts";

declare const SAFE: unique symbol;

/** Printable ASCII only (0x20-0x7E): one character is one column. */
export type SafeText = string & { readonly [SAFE]: true };

/** The only constructor of SafeText from arbitrary text. */
export function toSafe(text: string): SafeText {
  return toAscii(text) as SafeText;
}

/** One SafeText per line of `text`. */
export function toSafeLines(text: string): SafeText[] {
  return toAsciiLines(text) as SafeText[];
}

const ELLIPSIS = "...";

// The helpers below only slice, pad and join SafeText, which keeps it ASCII.

/** Cuts to at most `width` columns, marking a cut with an ellipsis when there is room for one. */
export function truncate(text: SafeText, width: number): SafeText {
  if (width <= 0) return "" as SafeText;
  if (text.length <= width) return text;
  if (width <= ELLIPSIS.length) return text.slice(0, width) as SafeText;
  return (text.slice(0, width - ELLIPSIS.length) + ELLIPSIS) as SafeText;
}

/** Exactly `width` columns: truncated or padded with spaces. */
export function fit(text: SafeText, width: number): SafeText {
  return truncate(text, width).padEnd(Math.max(0, width)) as SafeText;
}

export function join(parts: readonly SafeText[], separator: SafeText): SafeText {
  return parts.join(separator) as SafeText;
}

export function concat(...parts: readonly SafeText[]): SafeText {
  return parts.join("") as SafeText;
}

/** Soft wrap for the detail pane: breaks at the last space that fits, hard-cuts words longer than `width`. */
export function wrap(text: SafeText, width: number): SafeText[] {
  if (width <= 0) return [];
  const lines: SafeText[] = [];
  let rest: string = text;
  while (rest.length > width) {
    const space = rest.lastIndexOf(" ", width);
    const cut = space > 0 ? space : width;
    lines.push(rest.slice(0, cut).trimEnd() as SafeText);
    rest = rest.slice(cut).replace(/^ +/, "");
  }
  lines.push(rest as SafeText);
  return lines;
}
