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
import { REFRESH_SECS, SWITCH_AFTER_CALLS, scriptedWorkSource, workItem, workList, writeWorkPhase, type WorkPhase } from "./support/work-source.ts";
import { PROJECT, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

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

/** One phase of the stand-in work source: whether it prints the envelope in its file, its stderr and its exit code. */
/** Waits past the refreshes that serve the `after` phase, so the chooser has seen the new link set. */
const SHRINK_WAIT_MS = 10_000;
/** The branch page of the scenario's session on the GitHub origin the project has. */
const BRANCH_URL = "https://github.com/acme/widgets/tree/feature/links";
/** Waits for a refresh that the scenario expects to change the Links block. */
/** Seconds the TUI waits for the work list to be refreshed; the driver takes its timeouts in seconds. */
const REFRESH_WAIT_S = 30;

/** Writes the envelope of a scripted phase into the scenario directory. */
async function writeWorkPhaseHere(name: "before" | "after", envelope: unknown): Promise<void> {
  if (directory === null) throw new Error("scenario directory missing");
  await writeWorkPhase(directory, name, envelope);
}

/** Starts a scenario whose work source follows the two phases; the caller writes the envelopes the phases name. */
async function startScriptedScenario(before: WorkPhase, after: WorkPhase, switchAfter: number): Promise<{ stub: { command: string; trace: string }; tui: TuiScenario }> {
  directory = await mkdtemp(join(tmpdir(), "pw-links-"));
  const stub = await openStub();
  const selfBin = await scriptedWorkSource(directory, before, after, switchAfter);
  const tui = await startTuiScenario({ overrides: { "tui.open_command": stub.command, "tui.self_bin": selfBin, "tui.refresh_interval_secs": REFRESH_SECS } });
  scenario = tui;
  return { stub, tui };
}

test("a link chooser whose links shrink on a refresh reports a missing pick by a digit and by Enter", async () => {
  const { stub, tui } = await startScriptedScenario({ envelope: true, stderr: "", exit: 0 }, { envelope: true, stderr: "", exit: 0 }, SWITCH_AFTER_CALLS);
  const linked = await linkedSession("links-shrink", { id: LINEAR_ITEM, url: LINEAR_URL }, "feature/links");
  await writeWorkPhaseHere("before", workList([workItem(linked, LINEAR_ITEM, PR_URL, { id: LINEAR_ITEM, url: LINEAR_URL })]));
  // The shrunk set keeps the core work link and the branch page, so the chooser lists two links where it listed three.
  await writeWorkPhaseHere("after", workList([workItem(linked, LINEAR_ITEM, null, null)]));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "[3] Branch on GitHub" },
    keys("l"),
    { expect: "Choose 1–3" },
    keys(ARROW_DOWN),
    keys(ARROW_DOWN),
    // The chooser stays open while the refreshes replace the links with the shrunk set.
    { pause: SHRINK_WAIT_MS },
    { expect: "Choose 1–2 or ↑↓ and Enter" },
    // A digit past the shrunk set reports the missing link and keeps the chooser open on the new count.
    keys("3"),
    { expect: "No link 3 on this session anymore; choose 1–2" },
    { clear: true },
    // Enter opens the highlighted link by its URL: the highlight stayed on the branch page, which the refresh kept.
    keys(ENTER),
    { absent: "Choose 1–2", pause: SETTLE_MS },
    keys("q"),
  ];
  const result = await tui.run(steps, { ...WIDE, timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await traced(stub.trace, 1)).toEqual([BRANCH_URL]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("when every link disappears while the chooser is open, a digit closes it and says none are left", async () => {
  const { stub, tui } = await startScriptedScenario({ envelope: true, stderr: "", exit: 0 }, { envelope: true, stderr: "", exit: 0 }, SWITCH_AFTER_CALLS);
  const linked = await linkedSession("links-gone", null, null);
  await writeWorkPhaseHere("before", workList([workItem(linked, "github:acme/widgets#12", PR_URL, { id: LINEAR_ITEM, url: LINEAR_URL })]));
  await writeWorkPhaseHere("after", workList([]));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "[2] Linear issue" },
    keys("l"),
    { expect: "Choose 1–2" },
    { pause: SHRINK_WAIT_MS },
    { expect: "No links left on this session" },
    { clear: true },
    keys("1"),
    { expect: "No link 1 on this session anymore; none are left" },
    { absent: "No links left on this session", pause: SETTLE_MS },
    keys("q"),
  ];
  const result = await tui.run(steps, { ...WIDE, timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await readFile(stub.trace, "utf8").then(() => true, () => false)).toBe(false);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a Work list whose source did not answer says it is incomplete, not that no item matches", async () => {
  // The stand-in exits with the partial code (3) and names the failed source on stderr, as `list --json` does.
  const { tui } = await startScriptedScenario({ envelope: true, stderr: "linear: unreachable", exit: 3 }, { envelope: true, stderr: "linear: unreachable", exit: 3 }, 0);
  await linkedSession("incomplete-a", null, null);
  await writeWorkPhaseHere("before", workList([]));
  await writeWorkPhaseHere("after", workList([]));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "Work incomplete: linear: unreachable" },
    keys("q"),
  ];
  const result = await tui.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a refresh that fails after a good load keeps the rows and says the Work list is incomplete", async () => {
  const { tui } = await startScriptedScenario({ envelope: true, stderr: "", exit: 0 }, { envelope: false, stderr: "gh: unavailable", exit: 1 }, SWITCH_AFTER_CALLS);
  await linkedSession("incomplete-b", null, null);
  await writeWorkPhaseHere("before", workList([]));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "no Work match for this session" },
    // The next refreshes fail; the last good rows stay and the Links block says the list is incomplete.
    { expect: "Work incomplete: gh: unavailable", timeout: REFRESH_WAIT_S },
    keys("q"),
  ];
  const result = await tui.run(steps, { ...WIDE, timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

/** A chooser over PR, Linear issue and branch, where the PR leaves the list on the first refresh that serves `after`. */
async function startChooserScenario(): Promise<{ stub: { command: string; trace: string }; tui: TuiScenario; linked: string }> {
  const { stub, tui } = await startScriptedScenario({ envelope: true, stderr: "", exit: 0 }, { envelope: true, stderr: "", exit: 0 }, SWITCH_AFTER_CALLS);
  const linked = await linkedSession("links-chooser", { id: LINEAR_ITEM, url: LINEAR_URL }, "feature/links");
  await writeWorkPhaseHere("before", workList([workItem(linked, LINEAR_ITEM, PR_URL, { id: LINEAR_ITEM, url: LINEAR_URL })]));
  // Without the pull request the Linear issue and the branch page remain: [Linear, Branch].
  await writeWorkPhaseHere("after", workList([workItem(linked, LINEAR_ITEM, null, null)]));
  return { stub, tui, linked };
}

test("a link removed above the highlighted one leaves Enter on the highlighted URL, not on its neighbour", async () => {
  const { stub, tui } = await startChooserScenario();
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "[3] Branch on GitHub" },
    keys("l"),
    { expect: "Choose 1–3" },
    // Highlight the Linear issue, the second link, before the refresh removes the first one.
    keys(ARROW_DOWN),
    { pause: SHRINK_WAIT_MS },
    { expect: "Choose 1–2 or ↑↓ and Enter" },
    keys(ENTER),
    { pause: SETTLE_MS },
    keys("q"),
  ];
  const result = await tui.run(steps, { ...WIDE, timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await traced(stub.trace, 1)).toEqual([LINEAR_URL]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a highlighted link removed by a refresh refuses Enter with a status and opens nothing", async () => {
  const { stub, tui } = await startChooserScenario();
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "[3] Branch on GitHub" },
    keys("l"),
    { expect: "Choose 1–3" },
    // The highlight stays on the pull request, which the refresh removes.
    { pause: SHRINK_WAIT_MS },
    { expect: "Choose 1–2 or ↑↓ and Enter" },
    keys(ENTER),
    { expect: "The highlighted link is no longer on this session; choose again" },
    keys(ESCAPE),
    { absent: "Choose 1–2", pause: SETTLE_MS },
    keys("q"),
  ];
  const result = await tui.run(steps, { ...WIDE, timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await readFile(stub.trace, "utf8").then(() => true, () => false)).toBe(false);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a 16-row terminal with a session of three links still shows its output and scrolls it", async () => {
  const { tui } = await startScriptedScenario({ envelope: true, stderr: "", exit: 0 }, { envelope: true, stderr: "", exit: 0 }, SWITCH_AFTER_CALLS);
  const linked = await linkedSession("links-small", { id: LINEAR_ITEM, url: LINEAR_URL }, "feature/links");
  await writeWorkPhaseHere("before", workList([workItem(linked, LINEAR_ITEM, PR_URL, { id: LINEAR_ITEM, url: LINEAR_URL })]));
  await writeWorkPhaseHere("after", workList([workItem(linked, LINEAR_ITEM, PR_URL, { id: LINEAR_ITEM, url: LINEAR_URL })]));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    // The panel follows the output, so the body's last lines show; the OUTPUT heading is in the body on every shell.
    { expect: "Branch  feature/links" },
    { expect: "OUTPUT" },
    { clear: true },
    // PageUp brings the scrolled body's top into view: the links, which are not in the fixed head on this terminal.
    keys("\x1b[5~"),
    { expect: "LINKS" },
    { expect: "[3] Branch on GitHub" },
    { clear: true },
    // PageDown returns to the output, whose heading shows again.
    keys("\x1b[6~"),
    { expect: "OUTPUT" },
    keys("q"),
  ];
  const result = await tui.run(steps, { cols: 120, rows: 16, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

/** Waits for the session list to drop a session the scenario removed while a chooser was open. */
const SESSION_GONE_WAIT_MS = 10_000;
/** Time into the run at which the chooser is open and the session is removed under it. */
const CHOOSER_OPEN_WAIT_MS = 6_000;
const PR2_URL = "https://github.com/acme/widgets/pull/13";

test("a chooser whose session was removed while it was open opens no link", async () => {
  const { stub, tui } = await startScriptedScenario({ envelope: true, stderr: "", exit: 0 }, { envelope: true, stderr: "", exit: 0 }, SWITCH_AFTER_CALLS);
  const linked = await linkedSession("links-removed", { id: LINEAR_ITEM, url: LINEAR_URL }, "feature/links");
  await writeWorkPhaseHere("before", workList([]));
  await writeWorkPhaseHere("after", workList([]));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "[2] Branch on GitHub" },
    keys("l"),
    { expect: "Choose 1–2" },
    // The session is removed under the open chooser; its stale links must not be offered.
    { pause: SESSION_GONE_WAIT_MS },
    keys(ENTER),
    { expect: "The session of this chooser is no longer listed; no link opened" },
    keys("q"),
  ];
  // The chooser is open a few seconds into the run; the session is removed while the run waits on its pause.
  const running = tui.run(steps, { ...WIDE, timeoutS: 90 });
  await Bun.sleep(CHOOSER_OPEN_WAIT_MS);
  const removed = await tui.daemon.pohunek(["session", "rm", linked, "--json"]);
  expect((JSON.parse(removed.stdout) as { ok?: unknown }).ok).toBeDefined();
  const result = await running;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await readFile(stub.trace, "utf8").then(() => true, () => false)).toBe(false);
}, REAL_SCENARIO_TIMEOUT_MS);

test("two pull requests sharing one issue: a session on the secondary PR shows and opens both the PR and the issue", async () => {
  const { stub, tui } = await startScriptedScenario({ envelope: true, stderr: "", exit: 0 }, { envelope: true, stderr: "", exit: 0 }, SWITCH_AFTER_CALLS);
  const linked = await linkedSession("links-secondary", null, null);
  // The Work list carries the issue on the winning PR's row only; the session's row names it by issue_key.
  const secondary = { ...workItem(linked, "github:acme/widgets#12", PR_URL, null), issue_key: LINEAR_ITEM };
  const winner = workItem("none", "github:acme/widgets#13", PR2_URL, { id: LINEAR_ITEM, url: LINEAR_URL });
  await writeWorkPhaseHere("before", workList([secondary, winner]));
  await writeWorkPhaseHere("after", workList([secondary, winner]));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "[1] GitHub PR" },
    { expect: "[2] Linear issue" },
    keys("l"),
    { expect: "Choose 1–2" },
    keys(ARROW_DOWN),
    keys(ENTER),
    { pause: SETTLE_MS },
    keys("l"),
    keys(ENTER),
    { pause: SETTLE_MS },
    keys("q"),
  ];
  const result = await tui.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(await traced(stub.trace, 2)).toEqual([LINEAR_URL, PR_URL]);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a project whose origin is not GitHub says why its session has no branch page", async () => {
  const { tui } = await startScriptedScenario({ envelope: true, stderr: "", exit: 0 }, { envelope: true, stderr: "", exit: 0 }, SWITCH_AFTER_CALLS);
  if (directory === null) throw new Error("scenario directory missing");
  await writeWorkPhaseHere("before", workList([]));
  await writeWorkPhaseHere("after", workList([]));
  // A project whose origin is a GitLab repository: the daemon fixture registers only GitHub origins.
  const repo = join(directory, "gitlab-repo");
  for (const args of [["init", "-q", "-b", "main", repo], ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"], ["-C", repo, "remote", "add", "origin", "https://gitlab.com/acme/widgets.git"]]) {
    const git = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "ignore" });
    expect(await git.exited).toBe(0);
  }
  const added = await tui.daemon.pohunek(["project", "add", repo, "--json"]);
  const label = (JSON.parse(added.stdout) as { ok?: { label?: unknown } }).ok?.label;
  if (typeof label !== "string") throw new Error(`project add failed: ${added.stdout}${added.stderr}`);
  const created = await tui.daemon.pohunek(["session", "new", "--agent", "shell", "--project", label, "--name", "gitlab-branch", "--branch", "feature/gitlab", "--json"]);
  if ((JSON.parse(created.stdout) as { ok?: unknown }).ok === undefined) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    // The only session is the GitLab one, so the panel shows its Links block with the reason.
    { expect: "origin is not GitHub: no branch page" },
    keys("q"),
  ];
  const result = await tui.run(steps, { ...WIDE, timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);
