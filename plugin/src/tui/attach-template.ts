// The `attach_command` argv template of window mode: POSIX word splitting without expansion, and the
// placeholders that every value fills as exactly one argument.

/** Placeholders a template may use; any other `{name}` is a configuration error. */
export const ATTACH_PLACEHOLDERS = ["bin", "host", "id"] as const;
export type AttachPlaceholder = (typeof ATTACH_PLACEHOLDERS)[number];
export type AttachValues = Readonly<Record<AttachPlaceholder, string>>;

/**
 * Splits a template into words with POSIX quoting: whitespace separates words; single quotes keep
 * everything literal; double quotes keep everything but `\` before `"`, `\`, `$`, `` ` `` or a newline;
 * an unquoted `\` escapes the next character. `$`, `~`, globs and backticks have no meaning here.
 * Returns an error text for an unterminated quote or a dangling escape.
 */
export function splitAttachTemplate(template: string): { ok: true; words: string[] } | { ok: false; message: string } {
  const words: string[] = [];
  let word = "";
  // A word exists once it has any character, quoted or not, so `''` is an empty argument.
  let inWord = false;
  let index = 0;
  while (index < template.length) {
    const char = template.charAt(index);
    if (char === " " || char === "\t" || char === "\n") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      index += 1;
      continue;
    }
    inWord = true;
    if (char === "'") {
      const close = template.indexOf("'", index + 1);
      if (close === -1) return { ok: false, message: "has an unterminated single quote" };
      word += template.slice(index + 1, close);
      index = close + 1;
    } else if (char === "\"") {
      let cursor = index + 1;
      for (;;) {
        if (cursor >= template.length) return { ok: false, message: "has an unterminated double quote" };
        const inner = template.charAt(cursor);
        if (inner === "\"") break;
        if (inner === "\\" && cursor + 1 < template.length && "\\\"$`\n".includes(template.charAt(cursor + 1))) {
          if (template.charAt(cursor + 1) !== "\n") word += template.charAt(cursor + 1);
          cursor += 2;
          continue;
        }
        word += inner;
        cursor += 1;
      }
      index = cursor + 1;
    } else if (char === "\\") {
      if (index + 1 >= template.length) return { ok: false, message: "ends with a lone backslash" };
      if (template.charAt(index + 1) !== "\n") word += template.charAt(index + 1);
      index += 2;
    } else {
      word += char;
      index += 1;
    }
  }
  if (inWord) words.push(word);
  return { ok: true, words };
}

/**
 * Checks a parsed template: the program word is an absolute path with no placeholder, every `{name}` is a
 * known placeholder, and `{id}` appears so that the attach names its session.
 */
export function checkAttachWords(words: readonly string[]): string | null {
  const [program] = words;
  if (program === undefined) return "must name a program";
  if (!program.startsWith("/")) return "must start with an absolute program path";
  if (program.includes("{")) return "must not use a placeholder as the program";
  for (const word of words) {
    for (const match of word.matchAll(/\{([^{}]*)\}/g)) {
      const name = match[1] ?? "";
      if (!(ATTACH_PLACEHOLDERS as readonly string[]).includes(name)) return `uses the unknown placeholder {${name}}`;
    }
  }
  if (!words.some((word) => word.includes("{id}"))) return "must contain {id}";
  return null;
}

/** Fills the placeholders of every word once; a value is never scanned for placeholders, and stays one argument. */
export function renderAttachArgv(words: readonly string[], values: AttachValues): string[] {
  return words.map((word) => word.replace(/\{(bin|host|id)\}/g, (_, name: AttachPlaceholder) => values[name]));
}
