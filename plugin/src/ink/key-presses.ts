import type { Key } from "ink";

// Ink reads a chunk without an escape sequence as one input string, so typed text and Tabs that arrive together
// reach the key handler as one input. Each control character is a press of its own and each run of printable
// characters is one press, so a control character never ends up in text.
const ESCAPE = "\u001b";
const FIRST_PRINTABLE = " ".charCodeAt(0);
const DELETE = "\u007f".charCodeAt(0);

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < FIRST_PRINTABLE || code === DELETE;
}

/** The key presses a chunk of input holds. A chunk with an escape sequence stays whole: Ink reports those on their own. */
export function keyPresses(input: string): readonly string[] {
  if (input.length < 2 || input.includes(ESCAPE)) return [input];
  const presses: string[] = [];
  for (const char of input) {
    const last = presses.at(-1);
    if (!isControl(char) && last !== undefined && !isControl(last)) presses[presses.length - 1] = last + char;
    else presses.push(char);
  }
  return presses;
}

/** The key of a press split from a chunk: the chunk's flags belong to the whole chunk, so only the press's own control character sets one. */
export function splitKey(press: string, key: Key): Key {
  return {
    ...key,
    ctrl: false,
    meta: false,
    tab: press === "\t",
    return: press === "\r",
    backspace: press === "\b" || press === "\u007f",
  };
}
