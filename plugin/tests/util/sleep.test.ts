import { expect, test } from "bun:test";
import { sleep } from "../../src/util/sleep.ts";

test("resolves immediately when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = performance.now();
  await sleep(60_000, controller.signal);
  expect(performance.now() - started).toBeLessThan(1000);
});

test("resolves when the signal aborts during the wait", async () => {
  const controller = new AbortController();
  const started = performance.now();
  const waiting = sleep(60_000, controller.signal);
  controller.abort();
  await waiting;
  expect(performance.now() - started).toBeLessThan(1000);
});

test("resolves after the delay when nothing aborts", async () => {
  const controller = new AbortController();
  await sleep(5, controller.signal);
});
