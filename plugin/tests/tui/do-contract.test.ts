// The TUI decodes what `do --json` really prints (docs/tui-plan.md 4.4, requirement 2):
// every ok payload carries the action at ok.plan.action and, after a run, a result.
import { expect, test } from "bun:test";
import { runDo } from "../../src/commands/do.ts";
import { reportError } from "../../src/cli-errors.ts";
import { decodeDoEnvelope } from "../../src/tui/decode.ts";
import { check, issue, pr, session } from "../rules/builders.ts";
import { baseConfig, ok, options, setup } from "../actions/harness.ts";

test("implement: dry run and run decode with action, key, plan and result", async () => {
  const dry = setup({ issues: ok("linear", [issue()]) });
  const preview = decodeDoEnvelope((await runDo(baseConfig, options({ dryRun: true, yes: false }), dry.deps)).stdout);
  expect(preview.kind).toBe("ok");
  if (preview.kind !== "ok") return;
  expect([preview.action, preview.key, preview.dryRun, preview.result]).toEqual(["implement", "linear:ABC-1", true, null]);
  expect(preview.plan.map((field) => field.label)).toEqual(["profile", "branch", "name", "argv", "prompt"]);

  const run = setup({ issues: ok("linear", [issue()]) });
  const done = decodeDoEnvelope((await runDo(baseConfig, options(), run.deps)).stdout);
  expect(done.kind === "ok" ? done.result?.find((field) => field.label === "session_id")?.value : null).toBe("s-new");
});

test("ready: dry run and run decode", async () => {
  const draft = pr({ headRefName: "feature/x", isDraft: true, checks: [check("build", "success")] });
  const key = `github:${draft.id}`;
  const dry = setup({ prs: ok("github", [draft]) });
  const preview = decodeDoEnvelope((await runDo(baseConfig, options({ key, action: "ready", dryRun: true, yes: false }), dry.deps)).stdout);
  expect(preview.kind === "ok" ? preview.plan.map((field) => field.label) : null).toEqual(["pull_request", "argv", "verify_argv"]);
  const run = setup({
    prs: ok("github", [draft]),
    exec: (argv) => ({ exitCode: 0, stdout: argv[2] === "view" ? '{"isDraft":false}' : "", stderr: "", timedOut: false }),
  });
  const done = decodeDoEnvelope((await runDo(baseConfig, options({ key, action: "ready" }), run.deps)).stdout);
  expect(done.kind === "ok" ? done.result : null).toEqual([
    { label: "pull_request", value: "acme/widgets#12" },
    { label: "is_draft", value: "no" },
  ]);
});

test("attach: only the dry run has JSON; it decodes", async () => {
  const live = session({ id: "s-live", metadata: { "work.link.id": "ABC-1", "work.link.provider": "linear" } });
  const { deps } = setup({ issues: ok("linear", [issue()]), sessions: [live] });
  const preview = decodeDoEnvelope((await runDo(baseConfig, options({ action: "attach", dryRun: true, yes: false }), deps)).stdout);
  expect(preview.kind === "ok" ? preview.plan : null).toEqual([
    { label: "session_id", value: "s-live" },
    { label: "argv", value: "/usr/local/bin/pohunek attach s-live" },
  ]);
});

test("a refusal printed by the CLI entry point decodes as an error with its code", () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string): void => {
    lines.push(line);
  };
  try {
    reportError(true, "action", "confirmation_required", "not confirmed; nothing was executed");
  } finally {
    console.log = original;
  }
  expect(decodeDoEnvelope(lines.join("\n"))).toEqual({
    kind: "error",
    err: { class: "action", code: "confirmation_required", msg: "not confirmed; nothing was executed" },
  });
});
