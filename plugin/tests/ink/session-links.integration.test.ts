// The Links block of the session panel: every known link of a session (the core work link, the pull request and
// the issue of its Work item, the branch page on GitHub) is one numbered, clickable line. A click or its number
// runs the open command with that URL; a URL whose host is not in `open_url_hosts` is refused on screen and the
// open command never runs. The work items come from a stand-in work source (see scenario.ts), because GitHub and
// Linear are not reachable from the daemon test fixture.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keys, type PtyStep } from "./support/pty.ts";
import { EMPTY_WORK_LIST, PROJECT, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const WIDE = { cols: 120, rows: 40 };
/**
 * Left-button press on the `[2] Linear issue` line of the first session's panel, in 1-based cells: the panel's head
 * starts on row 4 and its Links lines follow the status, attention and project lines.
 */
const PRESS_LINEAR_LINE = "\x1b[<0;70;10M";
const SETTLE_MS = 300;
const PR_URL = "https://github.com/acme/widgets/pull/12";
const LINEAR_URL = "https://linear.app/acme/issue/WID-7/links";
const LINEAR_ITEM = "linear:WID-7";
/** Wait bound for the open command's trace: the child process writes it after the TUI reports the open. */
const TRACE_WAIT_MS = 10_000;
const TRACE_POLL_MS = 50;
const ARROW_DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

let scenario: TuiScenario | null = null;
let directory: string | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

/** Writes an open-command stub that appends each argument line to a trace file, and returns both paths. */
async function openStub(): Promise<{ command: string; trace: string }> {
  if (directory === null) throw new Error("scenario directory missing");
  const command = join(directory, "open-stub");
  const trace = join(directory, "open-trace.txt");
  await writeFile(command, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(trace)}, process.argv.slice(2).join(" ") + "\\n");
`);
  await chmod(command, 0o700);
  return { command, trace };
}

/** Lines the open command has recorded, polled until `count` of them exist or the wait bound passes. */
async function traced(trace: string, count: number): Promise<string[]> {
  const deadline = Date.now() + TRACE_WAIT_MS;
  for (;;) {
    const lines = await readFile(trace, "utf8").then((text) => text.trim().split("\n").filter((line) => line !== ""), () => []);
    if (lines.length >= count || Date.now() > deadline) return lines;
    await Bun.sleep(TRACE_POLL_MS);
  }
}

/** A session with the core work link `work.link.*` metadata; the branch goes to the GitHub page of the project. */
async function linkedSession(name: string, link: { id: string; url: string } | null, branch: string | null): Promise<string> {
  if (scenario === null) throw new Error("scenario not started");
  const meta = link === null ? [] : ["--meta", `work.link.id=${link.id}`, "--meta", `work.link.url=${link.url}`];
  const branchArgs = branch === null ? [] : ["--branch", branch];
  const created = await scenario.daemon.pohunek(["session", "new", "--agent", "shell", "--project", PROJECT, "--name", name, ...branchArgs, ...meta, "--json"]);
  const id = (JSON.parse(created.stdout) as { ok?: { id?: unknown } }).ok?.id;
  if (typeof id !== "string") throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  return id;
}

/** A work item of the `list --json` envelope joined to one local session. */
function workItem(sessionId: string, key: string, pullRequestUrl: string | null, issue: { id: string; url: string } | null): Record<string, unknown> {
  return {
    key,
    project: PROJECT,
    issue: issue === null ? null : { id: issue.id, title: "Links check", state: "started", url: issue.url },
    pull_request: pullRequestUrl === null ? null : { id: "12", url: pullRequestUrl, title: "Links check", draft: false, updated_at: "2026-10-14T10:00:00Z", review_decision: null, checks: "success", mergeable: "mergeable", fix_delivered: null, threads_answered: null, rerequested: null },
    no_issue: issue === null,
    issue_key: issue === null ? null : issue.id,
    sessions: [{ id: sessionId, name: "links", role: null, state: "running", activity: "working", indicator: "running", updated_at: null }],
    on_turn: { actor: "me", reason: "review", rule: null },
    actions: [],
    ignored: false,
    sources: { github: "ok", github_merged: "ok", linear: "ok", github_issues: "ok", pohunek: "ok" },
  };
}

/** The `list --json` envelope of the given items, in the shape the work source prints. */
function workList(items: readonly Record<string, unknown>[]): unknown {
  const envelope = structuredClone(EMPTY_WORK_LIST);
  return { ...envelope, ok: { ...envelope.ok, items } };
}

test("the Links block lists the PR and the Linear issue at a wide terminal; a click opens a line and l chooses among them", async () => {
  directory = await mkdtemp(join(tmpdir(), "pw-links-"));
  const stub = await openStub();
  scenario = await startTuiScenario({ overrides: { "tui.open_command": stub.command } });
  const linked = await linkedSession("links-a", { id: LINEAR_ITEM, url: LINEAR_URL }, "feature/links");
  await writeFile(scenario.workListFile, JSON.stringify(workList([workItem(linked, LINEAR_ITEM, PR_URL, { id: LINEAR_ITEM, url: LINEAR_URL })])));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "[1] GitHub PR" },
    { expect: "[2] Linear issue" },
    { expect: "[3] Branch on GitHub" },
    { expect: "Folder" },
    { ...keys(PRESS_LINEAR_LINE), settle: SETTLE_MS },
    { expect: "Opened linear.app" },
    // With three links, l lists them; the digit picks the PR and closes the chooser.
    keys("l"),
    { expect: "Choose 1–3" },
    keys("1"),
    { expect: "Opened github.com" },
    // The arrows move the highlight to the Linear issue, Enter opens it. The repeated status text is not
    // printed again, so the trace shows the second Linear open.
    keys("l"),
    { expect: "Choose 1–3" },
    keys(ARROW_DOWN),
    keys(ENTER),
    { pause: SETTLE_MS },
    // Esc closes the chooser without opening anything.
    keys("l"),
    { expect: "Choose 1–3" },
    keys(ESCAPE),
    { clear: true },
    { absent: "Choose 1–3", pause: SETTLE_MS },
    // Digits still switch views in Sessions: 3 is Hosts.
    keys("3"),
    { expect: "HOSTS" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await traced(stub.trace, 3)).toEqual([LINEAR_URL, PR_URL, LINEAR_URL]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a link whose host is not in open_url_hosts is refused on screen and the open command does not run", async () => {
  directory = await mkdtemp(join(tmpdir(), "pw-links-"));
  const stub = await openStub();
  scenario = await startTuiScenario({ overrides: { "tui.open_command": stub.command } });
  await linkedSession("links-refused", { id: "linear:WID-9", url: "https://evil.example.net/WID-9" }, null);
  await writeFile(scenario.workListFile, JSON.stringify(workList([])));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "[1] Work link" },
    keys("l"),
    { expect: "Not opened: host evil.example.net is not in open_url_hosts" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await readFile(stub.trace, "utf8").then(() => true, () => false)).toBe(false);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the Work join adds the pull request line to a session without a core work link", async () => {
  directory = await mkdtemp(join(tmpdir(), "pw-links-"));
  const stub = await openStub();
  scenario = await startTuiScenario({ overrides: { "tui.open_command": stub.command } });
  const joined = await linkedSession("links-joined", null, null);
  await writeFile(scenario.workListFile, JSON.stringify(workList([workItem(joined, "github:acme/widgets#12", PR_URL, null)])));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "[1] GitHub PR" },
    { absent: "[2]", pause: SETTLE_MS },
    keys("l"),
    { expect: "Opened github.com" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await traced(stub.trace, 1)).toEqual([PR_URL]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a session without any Work match says why its Links block is empty, and l reports the same reason", async () => {
  directory = await mkdtemp(join(tmpdir(), "pw-links-"));
  const stub = await openStub();
  scenario = await startTuiScenario({ overrides: { "tui.open_command": stub.command } });
  await linkedSession("links-unmatched", null, null);
  await writeFile(scenario.workListFile, JSON.stringify(workList([])));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "no Work match for this session" },
    { clear: true },
    keys("l"),
    { expect: "No link: no Work match for this session" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await readFile(stub.trace, "utf8").then(() => true, () => false)).toBe(false);
}, REAL_SCENARIO_TIMEOUT_MS);
