// The one fuzzy matcher behind every `/` filter and form pick field. It is fzf's algorithm (the pinned fzf-for-js
// port): the query letters must occur in order, and consecutive and word-start matches rank first.
import { Fzf } from "fzf";

interface Entry<T> {
  readonly item: T;
  readonly text: string;
}

/**
 * The items whose terms match `query`, best match first; equal scores keep their input order. A blank query keeps
 * every item in input order. The terms of an item are joined with a space, so a space typed in the query has to occur
 * literally; the query is trimmed first.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, termsOf: (item: T) => readonly string[]): T[] {
  const needle = query.trim();
  if (needle === "") return [...items];
  const entries: Entry<T>[] = items.map((item) => ({ item, text: termsOf(item).join(" ") }));
  const finder = new Fzf(entries, { casing: "case-insensitive", selector: (entry) => entry.text, tiebreakers: [] });
  return finder.find(needle).map((result) => result.item.item);
}

const FIRST_PRINTABLE = " ".charCodeAt(0);
const DELETE = "\u007f".charCodeAt(0);

/** The text a key press types: empty when the input holds a control character, such as an escape sequence or a raw Backspace. */
export function typedText(input: string): string {
  for (const char of input) {
    const code = char.charCodeAt(0);
    if (code < FIRST_PRINTABLE || code === DELETE) return "";
  }
  return input;
}

/** Pasted text as a query: line breaks become spaces and the other control characters are dropped. */
export function pastedText(text: string): string {
  let out = "";
  for (const char of text.replaceAll("\r", " ").replaceAll("\n", " ")) {
    const code = char.charCodeAt(0);
    if (code >= FIRST_PRINTABLE && code !== DELETE) out += char;
  }
  return out;
}
