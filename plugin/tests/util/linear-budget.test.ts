import { expect, test } from "bun:test";
import { estimateLinearComplexity, fitsLinearComplexity, LINEAR_MAX_COMPLEXITY } from "../../src/util/linear-budget.ts";

test("the largest issue page that fits is 93 without labels and 66 with labels", () => {
  expect(fitsLinearComplexity(93, false)).toBe(true);
  expect(fitsLinearComplexity(94, false)).toBe(false);
  expect(fitsLinearComplexity(66, true)).toBe(true);
  expect(fitsLinearComplexity(67, true)).toBe(false);
});

test("the estimate counts objects at 1 point, properties at 0.1 point and multiplies connections by first", () => {
  // 1 issue: issue 1.4 + state 1.2 + attachments (1 * 1.1 + 1.2) + page-level pageInfo 1.2
  expect(estimateLinearComplexity(1, false)).toBeCloseTo(1.4 + 1.2 + 1.1 + 1.2 + 1.2, 10);
  expect(estimateLinearComplexity(1, true)).toBeCloseTo(estimateLinearComplexity(1, false) + 1.1 + 1.2, 10);
});

test("the shipped page size of 50 fits with labels", () => {
  expect(estimateLinearComplexity(50, true)).toBeLessThan(LINEAR_MAX_COMPLEXITY);
});
