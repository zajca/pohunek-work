import { expect, test } from "bun:test";
import { isIssueKey, slugify } from "../../src/actions/branch.ts";

test("slugify lowercases, joins words with dashes and drops accents", () => {
  expect(slugify("Přidat Widget Cache!", 40)).toBe("pridat-widget-cache");
  expect(slugify("  --Fix: CI / lint  ", 40)).toBe("fix-ci-lint");
});

test("slugify cuts at the limit without a trailing dash", () => {
  expect(slugify("alpha beta gamma", 11)).toBe("alpha-beta");
  expect(slugify("alpha beta gamma", 5)).toBe("alpha");
  expect(slugify("a".repeat(60), 40)).toHaveLength(40);
});

test("slugify returns an empty string when no ASCII letter or digit remains", () => {
  expect(slugify("日本語", 40)).toBe("");
  expect(slugify("--- !!!", 40)).toBe("");
});

test("isIssueKey accepts Linear identifiers only", () => {
  expect(isIssueKey("DMD-2188")).toBe(true);
  expect(isIssueKey("A1-7")).toBe(true);
  for (const bad of ["dmd-1", "DMD-", "DMD-1/x", "-DMD-1", "DMD-1 ", "DMD_1", ""]) {
    expect(isIssueKey(bad)).toBe(false);
  }
});
