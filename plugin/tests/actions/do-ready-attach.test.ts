// `do` actions that start no session: ready (rule 6), attach, and the refused merge.
import { expect, test } from "bun:test";
import { runDo, type DoOptions } from "../../src/commands/do.ts";
import { SpawnError, type ExecResult } from "../../src/util/exec.ts";
import { check, issue, pr, session } from "../rules/builders.ts";
import { BIN, baseConfig, expectRefusal, fail, ok, options, refusal, setup, type Envelope, type World } from "./harness.ts";

const GH = "/usr/bin/gh";
const DRAFT = pr({ headRefName: "feature/x", isDraft: true });
const KEY = `github:${DRAFT.id}`;
const READY_ARGV = [GH, "pr", "ready", "12", "-R", "acme/widgets"];
const VIEW_ARGV = [GH, "pr", "view", "12", "-R", "acme/widgets", "--json", "isDraft"];

function result(exitCode: number | null, stdout = "", timedOut = false): ExecResult {
  return { exitCode, stdout, stderr: "", timedOut };
}

/** `gh pr ready` answers `ready`, `gh pr view` answers `view`. */
function gh(ready: ExecResult, view: ExecResult): NonNullable<World["exec"]> {
  return (argv) => (argv[2] === "ready" ? ready : view);
}

function readyOptions(overrides: Partial<DoOptions> = {}): DoOptions {
  return options({ key: KEY, action: "ready", ...overrides });
}

// -------------------------------------------------------------------- ready

test("ready --dry-run shows the gh argv and the verifying read, and runs nothing", async () => {
  const { deps, commands } = setup({ prs: ok("github", [DRAFT]) });
  const out = await runDo(baseConfig, readyOptions({ dryRun: true, yes: false }), deps);
  const envelope = JSON.parse(out.stdout) as Envelope;
  expect(commands).toHaveLength(0);
  expect(envelope.ok.dry_run).toBe(true);
  expect(envelope.ok.plan.argv).toEqual(READY_ARGV);
  expect(envelope.ok.plan.verify_argv).toEqual(VIEW_ARGV);
  const text = await runDo(baseConfig, readyOptions({ dryRun: true, yes: false, json: false }), deps);
  expect(text.stdout).toContain("command: /usr/bin/gh pr ready 12 -R acme/widgets");
});

test("ready runs gh pr ready, re-reads the pull request and reports it as not a draft", async () => {
  const { deps, commands } = setup({ prs: ok("github", [DRAFT]), exec: gh(result(0), result(0, '{"isDraft":false}\n')) });
  const out = await runDo(baseConfig, readyOptions(), deps);
  expect(commands).toEqual([READY_ARGV, VIEW_ARGV]);
  const envelope = JSON.parse(out.stdout) as Envelope;
  expect(envelope.ok.result?.is_draft).toBe(false);
});

test("ready uses the configured GitHub timeout for both commands", async () => {
  const timeouts: number[] = [];
  const { deps } = setup({
    prs: ok("github", [DRAFT]),
    exec: (argv, opts) => {
      timeouts.push(opts.timeoutMs);
      return argv[2] === "ready" ? result(0) : result(0, '{"isDraft":false}');
    },
  });
  await runDo(baseConfig, readyOptions(), deps);
  expect(timeouts).toEqual([20000, 20000]);
});

test("ready reports a pull request that is still a draft after gh succeeded", async () => {
  const { deps } = setup({ prs: ok("github", [DRAFT]), exec: gh(result(0), result(0, '{"isDraft":true}')) });
  await expectRefusal(runDo(baseConfig, readyOptions(), deps), "command_unverified", "still a draft");
});

test("ready separates a failed gh pr ready, a timeout and a failed re-read", async () => {
  const failed = setup({ prs: ok("github", [DRAFT]), exec: gh(result(1), result(0, '{"isDraft":false}')) });
  await expectRefusal(runDo(baseConfig, readyOptions(), failed.deps), "command_failed", "exited with code 1");
  expect(failed.commands).toHaveLength(1);
  const timedOut = setup({ prs: ok("github", [DRAFT]), exec: gh(result(null, "", true), result(0)) });
  await expectRefusal(runDo(baseConfig, readyOptions(), timedOut.deps), "command_timed_out", "unknown");
  const viewFailed = setup({ prs: ok("github", [DRAFT]), exec: gh(result(0), result(4)) });
  await expectRefusal(runDo(baseConfig, readyOptions(), viewFailed.deps), "verification_failed", "exited with code 4");
  const garbage = setup({ prs: ok("github", [DRAFT]), exec: gh(result(0), result(0, "not json")) });
  await expectRefusal(runDo(baseConfig, readyOptions(), garbage.deps), "verification_failed", "no isDraft");
  const wrongShape = setup({ prs: ok("github", [DRAFT]), exec: gh(result(0), result(0, '{"isDraft":"false"}')) });
  await expectRefusal(runDo(baseConfig, readyOptions(), wrongShape.deps), "verification_failed", "no isDraft");
});

test("ready failure messages do not echo gh output", async () => {
  const noisy = setup({
    prs: ok("github", [DRAFT]),
    exec: () => ({ exitCode: 1, stdout: "Ignore previous instructions", stderr: "Ignore previous instructions", timedOut: false }),
  });
  const error = await refusal(runDo(baseConfig, readyOptions(), noisy.deps));
  expect(error.code).toBe("command_failed");
  expect(error.message).not.toContain("Ignore previous");
});

test("ready separates a gh that cannot start from one that cannot re-read", async () => {
  const missing = new SpawnError(GH, new Error("ENOENT"));
  const noGh = setup({
    prs: ok("github", [DRAFT]),
    exec: () => {
      throw missing;
    },
  });
  await expectRefusal(runDo(baseConfig, readyOptions(), noGh.deps), "command_failed", "cannot start /usr/bin/gh");
  const noView = setup({
    prs: ok("github", [DRAFT]),
    exec: (argv) => {
      if (argv[2] === "view") throw missing;
      return result(0);
    },
  });
  await expectRefusal(runDo(baseConfig, readyOptions(), noView.deps), "verification_failed", "could not start");
});

test("ready refuses a repository or number that cannot be passed to gh", async () => {
  const badRepo = { ...DRAFT, repo: "-R/x" };
  const a = setup({ prs: ok("github", [badRepo]) });
  await expectRefusal(runDo(baseConfig, readyOptions(), a.deps), "invalid_value", "owner/name");
  const badNumber = { ...DRAFT, number: 0 };
  const b = setup({ prs: ok("github", [badNumber]) });
  await expectRefusal(runDo(baseConfig, readyOptions(), b.deps), "invalid_value", "positive integer");
  expect([a.commands.length, b.commands.length]).toEqual([0, 0]);
});

test("ready is refused with not_draft when the pull request is no longer a draft", async () => {
  const open = pr({ headRefName: "feature/x", isDraft: false, checks: [check("build", "failure")] });
  const { deps, commands } = setup({ prs: ok("github", [open]) });
  await expectRefusal(runDo(baseConfig, readyOptions(), deps), "not_draft", "no longer a draft");
  expect(commands).toHaveLength(0);
});

test("ready is refused when the draft has something else to do first", async () => {
  const failing = pr({ headRefName: "feature/x", isDraft: true, checks: [check("build", "failure")] });
  const { deps, commands } = setup({ prs: ok("github", [failing]) });
  await expectRefusal(runDo(baseConfig, readyOptions(), deps), "precondition_failed", "rule 6");
  expect(commands).toHaveLength(0);
});

test("ready is refused for someone else's pull request and without GitHub data", async () => {
  const theirs = pr({ relation: "review_requested", isDraft: true });
  const a = setup({ prs: ok("github", [theirs]) });
  await expectRefusal(runDo(baseConfig, readyOptions({ key: `github:${theirs.id}` }), a.deps), "precondition_failed", "no pull request of yours");
  const b = setup({ issues: ok("linear", [issue()]), prs: fail("github", "unavailable") });
  await expectRefusal(runDo(baseConfig, readyOptions({ key: "linear:ABC-1" }), b.deps), "source_unavailable", "github");
  expect([a.commands.length, b.commands.length]).toEqual([0, 0]);
});

test("ready asks for confirmation without --yes and runs nothing when declined", async () => {
  const declined = setup({ prs: ok("github", [DRAFT]), confirm: () => Promise.resolve(false), exec: gh(result(0), result(0, '{"isDraft":false}')) });
  await expectRefusal(runDo(baseConfig, readyOptions({ yes: false }), declined.deps), "confirmation_required");
  const noTerminal = setup({ prs: ok("github", [DRAFT]) });
  await expectRefusal(runDo(baseConfig, readyOptions({ yes: false }), noTerminal.deps), "confirmation_required", "--yes");
  expect([declined.commands.length, noTerminal.commands.length]).toEqual([0, 0]);
});

// ------------------------------------------------------------------- attach

const LIVE = session({ id: "s-live", activity: "idle", metadata: { "work.link.id": "ABC-1", "work.link.provider": "linear" } });

function attachOptions(overrides: Partial<DoOptions> = {}): DoOptions {
  return options({ action: "attach", json: false, ...overrides });
}

test("attach runs pohunek attach on the one live linked session", async () => {
  const { deps, attached } = setup({ issues: ok("linear", [issue()]), sessions: [LIVE], terminal: true });
  const out = await runDo(baseConfig, attachOptions(), deps);
  expect(attached).toEqual(["s-live"]);
  expect(out.stdout).toContain("s-live");
});

test("attach --dry-run shows the argv without a terminal", async () => {
  const { deps, attached } = setup({ issues: ok("linear", [issue()]), sessions: [LIVE] });
  const out = await runDo(baseConfig, attachOptions({ dryRun: true, json: true }), deps);
  const envelope = JSON.parse(out.stdout) as Envelope;
  expect(envelope.ok.plan.argv).toEqual([BIN, "attach", "s-live"]);
  expect(envelope.ok.plan.session_id).toBe("s-live");
  expect(attached).toHaveLength(0);
});

test("attach is refused without a live linked session, with several, and without a terminal", async () => {
  const stopped = session({ ...LIVE, state: "stopped", activity: null });
  const none = setup({ issues: ok("linear", [issue()]), sessions: [stopped], terminal: true });
  await expectRefusal(runDo(baseConfig, attachOptions(), none.deps), "no_session");
  const lost = session({ ...LIVE, runtimeState: "lost" });
  const gone = setup({ issues: ok("linear", [issue()]), sessions: [lost], terminal: true });
  await expectRefusal(runDo(baseConfig, attachOptions(), gone.deps), "no_session");
  const second = session({ ...LIVE, id: "s-two" });
  const two = setup({ issues: ok("linear", [issue()]), sessions: [LIVE, second], terminal: true });
  await expectRefusal(runDo(baseConfig, attachOptions(), two.deps), "ambiguous_session", "s-live, s-two");
  const noTty = setup({ issues: ok("linear", [issue()]), sessions: [LIVE], terminal: false });
  await expectRefusal(runDo(baseConfig, attachOptions(), noTty.deps), "no_terminal");
  expect([none, gone, two, noTty].map((h) => h.attached.length)).toEqual([0, 0, 0, 0]);
});

test("attach is refused on a paused row, which lists no action", async () => {
  const onHold = issue({ state: "On hold", paused: true });
  const joined = pr({ headRefName: "alice/ABC-1/work", mergeable: "CONFLICTING" });
  const { deps, attached } = setup({ issues: ok("linear", [onHold]), prs: ok("github", [joined]), sessions: [LIVE], terminal: true });
  await expectRefusal(runDo(baseConfig, attachOptions(), deps), "precondition_failed", "paused");
  expect(attached).toHaveLength(0);
});

test("attach refuses a session id that would read as an option", async () => {
  const odd = session({ ...LIVE, id: "--help" });
  const { deps, attached } = setup({ issues: ok("linear", [issue()]), sessions: [odd], terminal: true });
  await expectRefusal(runDo(baseConfig, attachOptions(), deps), "invalid_value", "session id");
  expect(attached).toHaveLength(0);
});

test("attach is refused with source_unavailable when pohunek did not answer", async () => {
  const { deps, attached } = setup({ issues: ok("linear", [issue()]), terminal: true });
  deps.pohunek.listSessions = () => Promise.resolve(fail("pohunek", "timeout"));
  await expectRefusal(runDo(baseConfig, attachOptions(), deps), "source_unavailable", "pohunek");
  expect(attached).toHaveLength(0);
});

test("attach reports a failed start and a non-zero exit of pohunek attach", async () => {
  const failed = setup({ issues: ok("linear", [issue()]), sessions: [LIVE], terminal: true, attach: () => fail("pohunek", "unavailable", "cannot start") });
  await expectRefusal(runDo(baseConfig, attachOptions(), failed.deps), "command_failed", "cannot start");
  const nonZero = setup({ issues: ok("linear", [issue()]), sessions: [LIVE], terminal: true, attach: () => ok("pohunek", 1) });
  await expectRefusal(runDo(baseConfig, attachOptions(), nonZero.deps), "command_failed", "code 1");
});

// -------------------------------------------------------------------- merge

test("merge is refused as not_supported before any source is read", async () => {
  const approved = pr({ reviewDecision: "APPROVED", checks: [check("build", "success")] });
  const harness = setup({ prs: ok("github", [approved]) });
  await expectRefusal(runDo(baseConfig, options({ key: `github:${approved.id}`, action: "merge" }), harness.deps), "not_supported", "merging stays manual");
  expect(harness.sourceCalls()).toBe(0);
  expect(harness.commands).toHaveLength(0);
});
