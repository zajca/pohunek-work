// Regression: a scenario whose setup fails after the daemon started must release the daemon and its directories
// before the error reaches the test. The failure is an invalid override, which the plugin config writer rejects
// after the daemon and the proxy exist. The private TMPDIR of the daemon is isolated for the test, so an empty
// directory afterwards proves that nothing was left behind.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { startTuiScenario } from "./support/scenario.ts";

test("a failed scenario setup removes the daemon root and the proxy", async () => {
  const previous = process.env["TMPDIR"];
  const isolated = await mkdtemp(join(tmpdir(), "pw-init-"));
  process.env["TMPDIR"] = isolated;
  try {
    const outcome = await startTuiScenario({ overrides: { "not-a-table-key": 1 } }).then(
      () => "started",
      (error: unknown) => (error instanceof Error ? error.message : "not an Error"),
    );
    expect(outcome).toContain("is not <table>.<key>");
    expect(await readdir(isolated)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
    await rm(isolated, { recursive: true, force: true });
  }
}, 120_000);
