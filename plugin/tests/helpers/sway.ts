// Test helper mirroring how sway scans a config line.

/**
 * Splits `line` at `;` and `,` outside quotes with sway's quote tracking, so a test can
 * check that no quoted word is cut apart.
 */
export function swayCommandCount(line: string): number {
  let inString = false;
  let inChar = false;
  let escaped = false;
  let count = 1;
  for (const char of line) {
    if (char === '"' && !inChar && !escaped) {
      inString = !inString;
    } else if (char === "'" && !inString) {
      inChar = !inChar;
    } else if (char === "\\") {
      escaped = !escaped;
      continue;
    } else if (!inString && !inChar && !escaped && (char === ";" || char === ",")) {
      count += 1;
    }
    escaped = false;
  }
  return count;
}
