// `do` on a row that carries the ignore label: refused unless --include-ignored.
import { expect, test } from "bun:test";
import { runDo } from "../../src/commands/do.ts";
import { ActionError } from "../../src/actions/types.ts";
import type { Logger } from "../../src/log.ts";
import { pr } from "../rules/builders.ts";
import { baseConfig, expectRefusal, ok, options, refusal, setup, type Envelope } from "./harness.ts";

const PARKED = pr({ headRefName: "feature/x", isDraft: true, ignored: true });
const OPEN = pr({ headRefName: "feature/x", isDraft: true });
const KEY = `github:${PARKED.id}`;

for (const action of ["fix-ci", "ready", "attach"] as const) {
  for (const dryRun of [true, false]) {
    test(`${action} (dryRun ${String(dryRun)}) on an ignored row is refused before anything runs`, async () => {
      const { deps, commands, launches } = setup({ prs: ok("github", [PARKED]) });
      const error = await refusal(runDo(baseConfig, options({ key: KEY, action, dryRun, yes: !dryRun }), deps));
      expect(error).toBeInstanceOf(ActionError);
      expect(error.code).toBe("precondition_failed");
      expect(error.message).toContain(KEY);
      expect(error.message).toContain("--include-ignored");
      expect(commands).toHaveLength(0);
      expect(launches).toHaveLength(0);
    });
  }
}

test("the refusal is logged like any other refusal", async () => {
  const events: string[] = [];
  const { deps } = setup({ prs: ok("github", [PARKED]) });
  const logger: Logger = { ...deps.logger, error: (event) => void events.push(event) };
  await expectRefusal(runDo(baseConfig, options({ key: KEY, action: "ready", dryRun: true, yes: false }), { ...deps, logger }), "precondition_failed", "ignore label");
  expect(events).toContain("do_refused");
});

test("--include-ignored lets the normal preconditions decide for ready and attach", async () => {
  const { deps } = setup({ prs: ok("github", [PARKED]) });
  const ready = await runDo(baseConfig, options({ key: KEY, action: "ready", dryRun: true, yes: false, includeIgnored: true }), deps);
  expect((JSON.parse(ready.stdout) as Envelope).ok.dry_run).toBe(true);
  const attach = await refusal(runDo(baseConfig, options({ key: KEY, action: "attach", dryRun: true, yes: false, includeIgnored: true }), deps));
  expect(attach.message).not.toContain("--include-ignored");
});

test("--include-ignored plans a launch action on an ignored row", async () => {
  const conflicting = pr({ headRefName: "feature/x", mergeable: "CONFLICTING", ignored: true });
  const { deps } = setup({ prs: ok("github", [conflicting]) });
  const out = await runDo(baseConfig, options({ key: `github:${conflicting.id}`, action: "rebase", profile: "profile-a", dryRun: true, yes: false, includeIgnored: true }), deps);
  expect((JSON.parse(out.stdout) as Envelope).ok.dry_run).toBe(true);
});

test("a row without the ignore label is unaffected by the flag", async () => {
  for (const includeIgnored of [false, true]) {
    const { deps } = setup({ prs: ok("github", [OPEN]) });
    const out = await runDo(baseConfig, options({ key: KEY, action: "ready", dryRun: true, yes: false, includeIgnored }), deps);
    expect((JSON.parse(out.stdout) as Envelope).ok.dry_run).toBe(true);
  }
});
