import { describe, expect, test } from "bun:test";
import { toAscii, toAsciiLines } from "../../src/output/sanitize.ts";
import { fit, toSafe, toSafeLines, truncate, wrap } from "../../src/tui/safe.ts";

const ESC = "\u001b";

describe("toAscii / toSafe", () => {
  test.each([
    ["CSI", `${ESC}[2J${ESC}[31mred`, "?[2J?[31mred"],
    ["OSC 8 hyperlink", `${ESC}]8;;https://x${ESC}\\t${ESC}]8;;${ESC}\\`, "?]8;;https://x?\\t?]8;;?\\"],
    ["OSC 52 clipboard write", `${ESC}]52;c;cHduZWQ=\u0007`, "?]52;c;cHduZWQ=?"],
    ["C1 CSI", "\u009b31m", "?31m"],
    ["bidi override", "a\u202Eb\u202Cc", "a?b?c"],
    ["zero width", "a\u200Bb\u200Dc\uFEFF", "a?b?c?"],
    ["line breaks and tab", "a\nb\r\tc", "a?b??c"],
    ["Czech diacritics", "Příliš žluťoučký kůň úpěl ďábelské ódy", "Prilis zlutoucky kun upel dabelske ody"],
    ["compatibility forms", "ﬁ ① Ｘ", "fi 1 X"],
    ["astral and CJK: one ? per character", "😀漢", "??"],
    ["DEL", "a\u007fb", "a?b"],
  ])("%s", (_name, input, expected) => {
    expect(toAscii(input)).toBe(expected);
    expect(toSafe(input)).toBe(expected as ReturnType<typeof toSafe>);
  });

  test("a 10 kB title stays one ASCII line of the same length", () => {
    const title = "ž".repeat(10_000);
    const safe = toSafe(title);
    expect(safe).toHaveLength(10_000);
    expect(/^[\x20-\x7e]*$/.test(safe)).toBe(true);
  });

  test("line splitting keeps each line and sanitizes it", () => {
    expect(toAsciiLines(`one\r\ntwo\rthree\n${ESC}four`)).toEqual(["one", "two", "three", "?four"]);
    expect(toSafeLines("a\nb")).toEqual(["a", "b"] as ReturnType<typeof toSafeLines>);
  });
});

describe("SafeText helpers", () => {
  test("truncate marks a cut with an ellipsis when there is room", () => {
    expect(truncate(toSafe("abcdefgh"), 6)).toBe(toSafe("abc..."));
    expect(truncate(toSafe("abcdefgh"), 3)).toBe(toSafe("abc"));
    expect(truncate(toSafe("abc"), 5)).toBe(toSafe("abc"));
    expect(truncate(toSafe("abc"), 0)).toBe(toSafe(""));
  });

  test("fit pads or cuts to the exact width", () => {
    expect(fit(toSafe("ab"), 4)).toBe(toSafe("ab  "));
    expect(fit(toSafe("abcdefg"), 5)).toBe(toSafe("ab..."));
  });

  test("wrap breaks at spaces and hard-cuts long words", () => {
    expect(wrap(toSafe("aaa bbb ccc"), 7)).toEqual([toSafe("aaa bbb"), toSafe("ccc")]);
    expect(wrap(toSafe("abcdefghij"), 4)).toEqual([toSafe("abcd"), toSafe("efgh"), toSafe("ij")]);
    expect(wrap(toSafe(""), 4)).toEqual([toSafe("")]);
    expect(wrap(toSafe("abc"), 0)).toEqual([]);
  });
});
