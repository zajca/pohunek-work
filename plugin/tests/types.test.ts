import { expect, test } from "bun:test";
import { isSourceFailure, LIST_CONTRACT_VERSION, type SourceStatus } from "../src/types/item.ts";

test("list contract version is a positive integer", () => {
  expect(Number.isInteger(LIST_CONTRACT_VERSION)).toBe(true);
  expect(LIST_CONTRACT_VERSION).toBeGreaterThan(0);
});

test.each<[SourceStatus, boolean]>([
  ["ok", false],
  ["unused", false],
  ["timeout", true],
  ["unauthenticated", true],
  ["not_configured", true],
])("isSourceFailure(%p) is %p", (status, expected) => {
  expect(isSourceFailure(status)).toBe(expected);
});
