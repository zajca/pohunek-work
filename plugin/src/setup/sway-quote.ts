// Quoting for words that end up in a sway `exec` command. sway scans the config
// line first (variable substitution, then splitting at `;` and `,` outside
// quotes, tracking `"` and `'` quote state without honouring a backslash before
// `'`) and then hands the `exec` text to `sh -c`. A word therefore has to be
// valid for both: it is wrapped in single quotes, an apostrophe becomes a
// double-quoted apostrophe, and `$` becomes a double-quoted `$` so sway never
// sees `$name` and substitutes a variable. Every quote run stays balanced for
// sway and for sh.

/** Quotes one word so sh reads it back unchanged and sway leaves it alone. */
export function quoteForSwayExec(word: string): string {
  let out = "'";
  for (const char of word) {
    if (char === "'") out += `'"'"'`;
    else if (char === "$") out += `'"$"'`;
    else out += char;
  }
  return `${out}'`;
}

/** Control characters cannot be quoted: a newline would start a new sway command. */
export function hasControlCharacter(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(text);
}

/** Characters that change the meaning of a `bindsym` key sequence in the sway config. */
const KEYBIND_FORBIDDEN = /[;,"'\\#\s]/;

/** Whether `keybind` is a plain key sequence such as `$mod+Shift+p`. */
export function isPlainKeybind(keybind: string): boolean {
  return keybind !== "" && !hasControlCharacter(keybind) && !KEYBIND_FORBIDDEN.test(keybind);
}
