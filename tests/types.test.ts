import { expect, test } from "bun:test";
import { LIST_CONTRACT_VERSION } from "../src/types/item.ts";

test("list contract version is a positive integer", () => {
  expect(Number.isInteger(LIST_CONTRACT_VERSION)).toBe(true);
  expect(LIST_CONTRACT_VERSION).toBeGreaterThan(0);
});
