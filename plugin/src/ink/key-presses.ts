// Ink reads a chunk without an escape sequence as one input string, so a run of Tab bytes written together reaches
// the key handler as a single input. Each Tab of such a run is a key press of its own.
const TAB = "\t";
const TABS = /^\t+$/;

/** The key presses a chunk of input holds: a run of Tabs is one press per Tab, anything else is one press. */
export function keyPresses(input: string): readonly string[] {
  return input.length > 1 && TABS.test(input) ? Array.from(input, () => TAB) : [input];
}
