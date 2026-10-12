// End-to-end scenarios of `pohunek-work manager start` against a real pohunekd from the pinned core
// release. Every scenario gets its own daemon, so a manager one scenario starts never overlaps the
// next. widgets and gadgets are registered and configured, sprockets is only configured, and bolts is
// registered with an origin that does not resolve to its configured repository. The managers run
// agent `shell`, which reaches activity `working` once the prompt arrives on stdin.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runPlugin,
  spawnPluginInTerminal,
  startCoreDaemon,
  workersBelow,
  writePluginConfig,
  type CliResult,
  type CoreDaemon,
  type PluginFixture,
  type PluginProject,
} from "./helpers/core-daemon.ts";

const PROCESS_TIMEOUT_MS = 60_000;
const SCENARIO_TIMEOUT_MS = 120_000;
const SCREEN_TIMEOUT_MS = 10_000;
const CONFIRMATION_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 50;
const EXIT_ERROR = 2;
/** `list` printed rows while at least one source was unavailable. */
const EXIT_PARTIAL = 3;
/** `doctor` exit code of a `[manager] workdir` that is not an existing directory. */
const EXIT_MANAGER_WORKDIR = 20;
/** `doctor` exit code of a `[manager] workdir` inside a registered project checkout. */
const EXIT_MANAGER_WORKDIR_IN_PROJECT = 21;
/** `[actions] launch_timeout_ms` of the fixture configuration. */
const FIXTURE_LAUNCH_TIMEOUT_MS = "120000";
/** Last line of plugin/prompts/work-manager.tmpl; the `shell` agent runs it as the command `Start`. */
const PROMPT_MARKER = "Start now: run pohunek-work manager guide";
const MANAGER_GUIDE = new URL("../prompts/manager-guide.md", import.meta.url).pathname;
/** The prompt line that tells the manager which flag every `do` carries. */
const DO_SCOPE_LINE = "Every `pohunek-work do` you run carries --project followed by the label of the project its row belongs to.";
/** Guide lines shorter than this are headings, table rules or fragments a prompt may share by chance. */
const GUIDE_LINE_MIN_LENGTH = 30;

const CONFIGURED: readonly PluginProject[] = [
  { label: "widgets", repo: "acme/widgets" },
  { label: "gadgets", repo: "acme/gadgets" },
  { label: "sprockets", repo: "acme/sprockets" },
  { label: "bolts", repo: "acme/bolts" },
];

let daemon: CoreDaemon | null = null;

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

interface Setup {
  readonly daemon: CoreDaemon;
  readonly fixture: PluginFixture;
  readonly workdir: string;
}

function managerTable(profile: string, workdir: string): string {
  return `\n[manager]\nprofile = ${JSON.stringify(profile)}\nworkdir = ${JSON.stringify(workdir)}\n`;
}

/** A fresh daemon with the four projects, and a configuration whose `[manager]` runs agent `shell` in an existing workdir. */
async function setUp(options: { readonly manager?: boolean; readonly profile?: string } = {}): Promise<Setup> {
  const started = await startCoreDaemon();
  daemon = started;
  await started.registerProject("widgets", "acme/widgets");
  await started.registerProject("gadgets", "acme/gadgets");
  await started.registerProject("bolts", "acme/elsewhere");
  const workdir = join(started.root, "manager");
  await mkdir(workdir, { mode: 0o700 });
  const extraGlobal = options.manager === false ? "" : managerTable(options.profile ?? "shell", workdir);
  const fixture = await writePluginConfig(started, CONFIGURED, { extraGlobal });
  return { daemon: started, fixture, workdir };
}

interface DaemonSession {
  readonly id: string;
  readonly name?: string;
  readonly cwd?: string;
  readonly state: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

async function sessions(core: CoreDaemon): Promise<DaemonSession[]> {
  const listed = await core.pohunek(["session", "list", "--json"]);
  const envelope = JSON.parse(listed.stdout) as { ok?: DaemonSession[] };
  if (envelope.ok === undefined) throw new Error(`session list failed: ${listed.stdout}${listed.stderr}`);
  return envelope.ok;
}

interface StartOk {
  readonly dry_run: boolean;
  readonly plan: {
    readonly all: boolean;
    readonly projects: readonly string[];
    readonly skipped: readonly { readonly project: string; readonly reason: string }[];
    readonly profile: string;
    readonly cwd: string;
    readonly name: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly argv: readonly string[];
    readonly prompt: string;
  };
  readonly result?: { readonly session_id: string; readonly name: string; readonly metadata: Readonly<Record<string, string>> };
}

function okOf(result: CliResult): StartOk {
  const envelope = JSON.parse(result.out) as { ok?: StartOk; protocol?: unknown };
  if (envelope.ok === undefined) throw new Error(`manager start failed (${String(result.code)}): ${result.out}${result.err}`);
  return envelope.ok;
}

function errOf(result: CliResult): { class: string; code: string; msg: string } {
  expect(result.code).toBe(EXIT_ERROR);
  const envelope = JSON.parse(result.out) as { err?: { class: string; code: string; msg: string } };
  if (envelope.err === undefined) throw new Error(`expected an error envelope: ${result.out}${result.err}`);
  return envelope.err;
}

function start(fixture: PluginFixture, args: readonly string[]): Promise<CliResult> {
  return runPlugin(fixture, ["manager", "start", ...args], PROCESS_TIMEOUT_MS);
}

/**
 * Waits until the `shell` agent has executed the last line of the prompt, which it reports as a command it
 * cannot find: bash `sh: Start: command not found`, dash `/bin/sh: <n>: Start: not found`. Only the shell
 * writes that text, and it runs its input in order; the terminal echo of the typed prompt ("Start now: ...")
 * interleaves with the shell's output and is never matched. Interactive bash prints no line number and dash's
 * does not follow the prompt's lines, so no number is matched. Rows are joined without breaks, so a wrapped
 * message still matches.
 */
async function waitForPromptExecuted(core: CoreDaemon, sessionId: string, prompt: string): Promise<void> {
  const command = prompt.trimEnd().split("\n").at(-1)?.split(" ")[0] ?? "";
  if (!/^[A-Za-z]+$/.test(command)) throw new Error(`the last prompt line does not start with a plain command word: ${JSON.stringify(command)}`);
  const executed = new RegExp(`(^|[^A-Za-z])${command}: (command )?not found`);
  const deadline = Date.now() + SCREEN_TIMEOUT_MS;
  for (;;) {
    const screen = await core.pohunek(["session", "screen", sessionId, "--json"]);
    const lines = (JSON.parse(screen.stdout) as { ok?: { visible_lines?: string[] } }).ok?.visible_lines ?? [];
    if (executed.test(lines.join(""))) return;
    if (Date.now() > deadline) {
      throw new Error(`the screen of ${sessionId} did not show the last prompt line (${command}) executed within ${String(SCREEN_TIMEOUT_MS)} ms:\n${lines.join("\n")}`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

interface LogEntry {
  readonly event: string;
  readonly code?: string;
  readonly session_id?: string;
}

async function managerLog(fixture: PluginFixture): Promise<LogEntry[]> {
  const text = await readFile(join(fixture.stateDir, "logs", "manager.log"), "utf8");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as LogEntry);
}

function expectedArgv(core: CoreDaemon, workdir: string, name: string, projects: string): string[] {
  return [
    join(core.coreDir, "pohunek"), "session", "new",
    "--cwd", workdir,
    "--name", name,
    "--agent", "shell",
    "--meta", "work.role=manager",
    "--meta", `work.manager.projects=${projects}`,
    "--input-stdin",
    "--request-timeout-ms", FIXTURE_LAUNCH_TIMEOUT_MS,
    "--json",
  ];
}

test("manager start --project launches one verified manager in the workdir with the rendered prompt", async () => {
  const { daemon: core, fixture, workdir } = await setUp();
  const result = await start(fixture, ["--project", "widgets", "--yes", "--json"]);
  expect(result.code).toBe(0);
  const ok = okOf(result);
  expect(ok.dry_run).toBe(false);
  expect(ok.plan.argv).toEqual(expectedArgv(core, workdir, "manager:widgets", "widgets"));
  const id = ok.result?.session_id;
  if (id === undefined) throw new Error(`no session id in ${result.out}`);
  expect(ok.result?.metadata).toEqual({ "work.role": "manager", "work.manager.projects": "widgets" });

  const listed = await sessions(core);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ id, name: "manager:widgets", cwd: workdir, state: "running" });
  expect(listed[0]?.metadata).toEqual({ "work.role": "manager", "work.manager.projects": "widgets" });

  // The prompt went to the session's stdin: the shell ran it up to its last line.
  expect(ok.plan.prompt.trimEnd().split("\n").at(-1)).toBe(PROMPT_MARKER);
  await waitForPromptExecuted(core, id, ok.plan.prompt);
  expect(ok.plan.prompt).toContain("`pohunek-work manager guide`");
  expect(ok.plan.prompt).toContain("pohunek-work list --mine --json --project widgets\n");
  expect(ok.plan.prompt).toContain("pohunek-work list --json --project widgets\n");
  expect(ok.plan.prompt).toContain("Every `pohunek-work list` you run carries exactly these flags: --project widgets\n");
  expect(ok.plan.prompt).toContain(DO_SCOPE_LINE);
  expect(ok.plan.skipped).toEqual([]);
  const guide = await readFile(MANAGER_GUIDE, "utf8");
  const restated = guide.split("\n").map((line) => line.trim()).filter((line) => line.length >= GUIDE_LINE_MIN_LENGTH && ok.plan.prompt.includes(line));
  expect(restated).toEqual([]);

  const log = await managerLog(fixture);
  expect(log.map((entry) => entry.event)).toEqual(["manager_start", "manager_plan", "manager_done"]);
  expect(log.at(-1)?.session_id).toBe(id);

  const text = await start(fixture, ["--project", "gadgets", "--yes"]);
  expect(text.code).toBe(0);
  const gadgets = (await sessions(core)).find((session) => session.metadata?.["work.manager.projects"] === "gadgets");
  if (gadgets === undefined) throw new Error("no gadgets manager after a text-mode start");
  expect(text.out.trim()).toBe(`started session ${gadgets.id} (manager:gadgets) for project gadgets; attach with: pohunek attach ${gadgets.id}`);

  await core.stop();
  expect(await workersBelow(core.runtimeDir)).toEqual([]);
}, SCENARIO_TIMEOUT_MS);

test("manager start with several projects sorts and joins the labels, a duplicate is dropped", async () => {
  const { daemon: core, fixture, workdir } = await setUp();
  const ok = okOf(await start(fixture, ["--project", "widgets", "--project", "gadgets", "--project", "widgets", "--yes", "--json"]));
  expect(ok.plan.argv).toEqual(expectedArgv(core, workdir, "manager:gadgets,widgets", "gadgets,widgets"));
  expect(ok.plan.projects).toEqual(["gadgets", "widgets"]);
  expect(ok.plan.prompt).toContain("pohunek-work list --mine --json --project gadgets --project widgets\n");
  expect(ok.plan.prompt).toContain("pohunek-work list --json --project gadgets --project widgets\n");
  expect(ok.plan.prompt).toContain("Every `pohunek-work list` you run carries exactly these flags: --project gadgets --project widgets\n");
  expect(ok.plan.prompt).toContain(DO_SCOPE_LINE);
  const listed = await sessions(core);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.metadata).toEqual({ "work.role": "manager", "work.manager.projects": "gadgets,widgets" });
  await waitForPromptExecuted(core, listed[0]?.id ?? "", ok.plan.prompt);
}, SCENARIO_TIMEOUT_MS);

test("manager start --all covers every project with *, lists without --project and names the skipped projects", async () => {
  const { daemon: core, fixture, workdir } = await setUp();
  const result = await start(fixture, ["--all", "--yes", "--json"]);
  const ok = okOf(result);
  expect(ok.plan.all).toBe(true);
  expect(ok.plan.projects).toEqual(["gadgets", "widgets"]);
  expect(ok.plan.argv).toEqual(expectedArgv(core, workdir, "manager:*", "*"));
  expect(ok.plan.prompt).toContain("pohunek-work list --mine --json\n");
  expect(ok.plan.prompt).toContain("pohunek-work list --json\n");
  expect(ok.plan.prompt).toContain("need no project flag");
  expect(ok.plan.prompt).not.toContain("--project");
  expect(ok.plan.skipped).toEqual([
    { project: "bolts", reason: "origin_url does not resolve to acme/bolts" },
    { project: "sprockets", reason: "no pohunek project with this label" },
  ]);
  expect(result.err).toContain("project sprockets: no pohunek project with this label");
  expect(result.err).toContain("project bolts: origin_url does not resolve to acme/bolts");
  const listed = await sessions(core);
  expect(listed).toHaveLength(1);
  expect(listed[0]?.metadata).toEqual({ "work.role": "manager", "work.manager.projects": "*" });
}, SCENARIO_TIMEOUT_MS);

test("an overlapping live manager is refused with already_running and its attach command; a disjoint set starts", async () => {
  const { daemon: core, fixture } = await setUp();
  const first = okOf(await start(fixture, ["--project", "widgets", "--yes", "--json"])).result?.session_id ?? "";

  const again = errOf(await start(fixture, ["--project", "widgets", "--yes", "--json"]));
  expect(again.code).toBe("already_running");
  expect(again.msg).toContain(first);
  expect(again.msg).toContain(`pohunek attach ${first}`);
  // A dry run applies the same refusal.
  expect(errOf(await start(fixture, ["--project", "gadgets", "--project", "widgets", "--dry-run", "--json"])).code).toBe("already_running");
  expect(await sessions(core)).toHaveLength(1);

  const second = okOf(await start(fixture, ["--project", "gadgets", "--yes", "--json"])).result?.session_id ?? "";
  expect(await sessions(core)).toHaveLength(2);

  const all = errOf(await start(fixture, ["--all", "--yes", "--json"]));
  expect(all.code).toBe("already_running");
  expect(all.msg).toContain(`pohunek attach ${first}`);
  expect(all.msg).toContain(`pohunek attach ${second}`);
  expect(await sessions(core)).toHaveLength(2);

  const log = await managerLog(fixture);
  expect(log.filter((entry) => entry.event === "manager_refused").map((entry) => entry.code)).toEqual(["already_running", "already_running", "already_running"]);

  // A manager that is no longer live does not block a new one.
  const stopped = await core.pohunek(["session", "stop", first, "--json"]);
  expect(stopped.exitCode).toBe(0);
  okOf(await start(fixture, ["--project", "widgets", "--yes", "--json"]));
  expect((await sessions(core)).filter((session) => session.state === "running")).toHaveLength(2);
}, SCENARIO_TIMEOUT_MS);

/** Collects a stream into `sink.text` until it ends. */
async function collect(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
}

test("a confirmation does not authorize a plan that changed while the owner was asked", async () => {
  const { daemon: core, fixture, workdir } = await setUp();
  const child = spawnPluginInTerminal(fixture, ["manager", "start", "--project", "widgets", "--json"]);
  const output = { text: "" };
  const errors = { text: "" };
  const reading = Promise.all([collect(child.stdout, output), collect(child.stderr, errors)]);
  let rival: string | undefined;
  try {
    const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
    while (!output.text.includes("Run this command?")) {
      if (child.exitCode !== null) throw new Error(`manager start exited before asking (${String(child.exitCode)}):\n${output.text}\nstderr:\n${errors.text}`);
      if (Date.now() > deadline) throw new Error(`no confirmation question within ${String(CONFIRMATION_TIMEOUT_MS)} ms:\n${output.text}`);
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    expect(await sessions(core)).toEqual([]);
    // Another terminal starts a manager for the same project while the owner reads the plan.
    const created = await core.pohunek(["session", "new", "--agent", "shell", "--cwd", workdir, "--name", "rival", "--meta", "work.role=manager", "--meta", "work.manager.projects=widgets", "--json"]);
    rival = (JSON.parse(created.stdout) as { ok?: { id?: string } }).ok?.id;
    if (rival === undefined) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
    await child.stdin.write("y\n");
    await child.stdin.flush();
    expect(await child.exited).toBe(EXIT_ERROR);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.stdin.end();
  }
  await reading;
  expect(output.text).toContain('"code": "already_running"');
  expect(output.text).toContain(`pohunek attach ${rival}`);
  expect((await sessions(core)).map((session) => session.id)).toEqual([rival]);
}, SCENARIO_TIMEOUT_MS);

test("a live manager without a readable project set, or with *, overlaps every project", async () => {
  const { daemon: core, fixture, workdir } = await setUp();
  // No key, an empty value, an empty element and an element that is no label cannot be read as a set; none names gadgets.
  for (const meta of [[], ["--meta", "work.manager.projects="], ["--meta", "work.manager.projects=bolts,,sprockets"], ["--meta", "work.manager.projects=bolts, sprockets"]]) {
    const created = await core.pohunek(["session", "new", "--agent", "shell", "--cwd", workdir, "--name", "hand", "--meta", "work.role=manager", ...meta, "--json"]);
    const hand = (JSON.parse(created.stdout) as { ok?: { id?: string } }).ok?.id;
    if (hand === undefined) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
    const refused = errOf(await start(fixture, ["--project", "gadgets", "--yes", "--json"]));
    expect(refused.code).toBe("already_running");
    expect(refused.msg).toContain(`pohunek attach ${hand}`);
    expect((await core.pohunek(["session", "stop", hand, "--json"])).exitCode).toBe(0);
  }
  const hands = (await sessions(core)).map((session) => session.id);

  const everything = okOf(await start(fixture, ["--all", "--yes", "--json"])).result?.session_id ?? "";
  const byStar = errOf(await start(fixture, ["--project", "widgets", "--yes", "--json"]));
  expect(byStar.code).toBe("already_running");
  expect(byStar.msg).toContain(`pohunek attach ${everything}`);
  for (const hand of hands) expect(byStar.msg).not.toContain(hand);
  expect((await sessions(core)).filter((session) => session.state === "running").map((session) => session.id)).toEqual([everything]);
}, SCENARIO_TIMEOUT_MS);

test("unknown, unregistered and origin-mismatch labels are refused together and nothing is launched", async () => {
  const { daemon: core, fixture } = await setUp();
  const refused = errOf(await start(fixture, ["--project", "widgets", "--project", "sprockets", "--project", "nosuch", "--project", "bolts", "--yes", "--json"]));
  expect(refused.code).toBe("precondition_failed");
  expect(refused.msg).toContain("nosuch: no project file");
  expect(refused.msg).toContain("sprockets: no pohunek project with this label");
  expect(refused.msg).toContain("bolts: origin_url does not resolve to acme/bolts");
  expect(refused.msg).not.toContain("widgets");

  const invalid = errOf(await start(fixture, ["--project", "a,b", "--yes", "--json"]));
  expect(invalid.code).toBe("invalid_value");
  expect(invalid.msg).toContain('"a,b"');
  expect(await sessions(core)).toEqual([]);

  const none = await writePluginConfig(core, [{ label: "sprockets", repo: "acme/sprockets" }], { name: "none", extraGlobal: managerTable("shell", join(core.root, "manager")) });
  const nothing = errOf(await runPlugin(none, ["manager", "start", "--all", "--yes", "--json"], PROCESS_TIMEOUT_MS));
  expect(nothing.code).toBe("precondition_failed");
  expect(nothing.msg).toContain("no configured project");
  expect(await sessions(core)).toEqual([]);
}, SCENARIO_TIMEOUT_MS);

test("without [manager] only manager start refuses; a bad table fails at load; a missing workdir is refused and reported by doctor", async () => {
  const { daemon: core, fixture } = await setUp({ manager: false });
  const refused = errOf(await start(fixture, ["--project", "widgets", "--yes", "--json"]));
  expect(refused).toMatchObject({ class: "configuration", code: "config_invalid" });
  expect(refused.msg).toContain("[manager]");
  expect((await runPlugin(fixture, ["list", "--json", "--project", "widgets"], PROCESS_TIMEOUT_MS)).code).toBe(EXIT_PARTIAL);
  expect((await runPlugin(fixture, ["doctor"], PROCESS_TIMEOUT_MS)).out).toMatch(/^ok {3}ok manager workdir: not needed/m);

  const missing = join(core.root, "no-such-dir");
  const gone = await writePluginConfig(core, CONFIGURED, { name: "gone", extraGlobal: managerTable("shell", missing) });
  const noDir = errOf(await runPlugin(gone, ["manager", "start", "--project", "widgets", "--yes", "--json"], PROCESS_TIMEOUT_MS));
  expect(noDir.code).toBe("precondition_failed");
  expect(noDir.msg).toContain(missing);
  expect(await stat(missing).catch((error: unknown) => error)).toMatchObject({ code: "ENOENT" });
  const doctor = await runPlugin(gone, ["doctor"], PROCESS_TIMEOUT_MS);
  expect(doctor.code).toBe(EXIT_MANAGER_WORKDIR);
  expect(doctor.out).toContain("FAIL manager_workdir_missing manager workdir:");

  const cases: readonly (readonly [string, string])[] = [
    ['\n[manager]\nprofile = "shell"\n', "[manager] workdir is required"],
    [`\n[manager]\nprofile = "shell"\nworkdir = "relative/dir"\n`, "[manager] workdir must be an absolute path"],
    [`\n[manager]\nworkdir = ${JSON.stringify(missing)}\n`, "[manager] profile is required"],
    [`\n[manager]\nprofile = "--rm"\nworkdir = ${JSON.stringify(missing)}\n`, "[manager] profile must be a profile name"],
    [`\n[manager]\nprofile = "shell"\nworkdir = ${JSON.stringify(missing)}\nhost = "x"\n`, "[manager] host is not a known key"],
  ];
  for (const [index, [extraGlobal, message]] of cases.entries()) {
    const bad = await writePluginConfig(core, CONFIGURED, { name: `bad${String(index)}`, extraGlobal });
    const loaded = errOf(await runPlugin(bad, ["list", "--json"], PROCESS_TIMEOUT_MS));
    expect(loaded.code).toBe("config_invalid");
    expect(loaded.msg).toContain(message);
  }
  expect(await sessions(core)).toEqual([]);
}, SCENARIO_TIMEOUT_MS);

test("a workdir equal to or below a registered project checkout is refused, also through a symlink, and doctor reports it", async () => {
  const { daemon: core } = await setUp();
  const checkout = join(core.root, "repos", "widgets");
  const below = join(checkout, "manager");
  await mkdir(below);
  const link = join(core.root, "link");
  await symlink(below, link);
  for (const [index, workdir] of [checkout, below, link].entries()) {
    const inside = await writePluginConfig(core, CONFIGURED, { name: `inside${String(index)}`, extraGlobal: managerTable("shell", workdir) });
    const refused = errOf(await runPlugin(inside, ["manager", "start", "--project", "gadgets", "--dry-run", "--json"], PROCESS_TIMEOUT_MS));
    expect(refused.code).toBe("precondition_failed");
    expect(refused.msg).toContain(`inside the checkout of pohunek project widgets (${checkout})`);
  }
  expect(await sessions(core)).toEqual([]);

  // Only registered, matching projects, so the placement check is the first one that fails.
  const placed = await writePluginConfig(core, [{ label: "widgets", repo: "acme/widgets" }], { name: "placed", extraGlobal: managerTable("shell", link) });
  const doctor = await runPlugin(placed, ["doctor"], PROCESS_TIMEOUT_MS);
  expect(doctor.code).toBe(EXIT_MANAGER_WORKDIR_IN_PROJECT);
  expect(doctor.out).toContain("FAIL manager_workdir_in_project manager workdir placement:");
}, SCENARIO_TIMEOUT_MS);

test("a path that exists but cannot be resolved fails the placement check closed, in manager start and in doctor", async () => {
  const { daemon: core, workdir } = await setUp();
  const repos = join(core.root, "repos");
  const locked = join(core.root, "locked");
  const lockedWorkdir = join(locked, "manager");
  await mkdir(lockedWorkdir, { recursive: true });
  const outside = await writePluginConfig(core, [{ label: "widgets", repo: "acme/widgets" }], { name: "outside", extraGlobal: managerTable("shell", workdir) });
  const hidden = await writePluginConfig(core, [{ label: "widgets", repo: "acme/widgets" }], { name: "hidden", extraGlobal: managerTable("shell", lockedWorkdir) });
  // Without search permission on the parent, realpath of every repo_root fails with EACCES, and so does stat of the workdir.
  await chmod(repos, 0o000);
  await chmod(locked, 0o000);
  try {
    const unresolved = errOf(await runPlugin(outside, ["manager", "start", "--project", "widgets", "--dry-run", "--json"], PROCESS_TIMEOUT_MS));
    expect(unresolved.code).toBe("precondition_failed");
    for (const label of ["bolts", "gadgets", "widgets"]) expect(unresolved.msg).toContain(`${join(repos, label)}, the repo_root of pohunek project ${label} (EACCES)`);
    const doctor = await runPlugin(outside, ["doctor"], PROCESS_TIMEOUT_MS);
    expect(doctor.code).toBe(EXIT_MANAGER_WORKDIR_IN_PROJECT);
    expect(doctor.out).toContain("FAIL manager_workdir_in_project manager workdir placement: [manager] cannot resolve ");
    expect(doctor.out).toContain(`${join(repos, "widgets")}, the repo_root of pohunek project widgets (EACCES)`);
    expect(doctor.out).not.toContain("lies outside every registered project checkout");

    const unreadable = errOf(await runPlugin(hidden, ["manager", "start", "--project", "widgets", "--dry-run", "--json"], PROCESS_TIMEOUT_MS));
    expect(unreadable.code).toBe("precondition_failed");
    expect(unreadable.msg).toContain(`[manager] workdir ${lockedWorkdir} cannot be read (EACCES)`);
    const hiddenDoctor = await runPlugin(hidden, ["doctor"], PROCESS_TIMEOUT_MS);
    expect(hiddenDoctor.code).toBe(EXIT_MANAGER_WORKDIR);
    expect(hiddenDoctor.out).toContain(`FAIL manager_workdir_missing manager workdir: [manager] workdir ${lockedWorkdir} cannot be read (EACCES)`);
  } finally {
    await chmod(repos, 0o700);
    await chmod(locked, 0o700);
  }
  expect(await sessions(core)).toEqual([]);
}, SCENARIO_TIMEOUT_MS);

test("--profile overrides [manager] profile and is validated like do", async () => {
  const { daemon: core, fixture } = await setUp({ profile: "no-such-profile" });
  const invalid = errOf(await start(fixture, ["--project", "widgets", "--profile=-x", "--yes", "--json"]));
  expect(invalid.code).toBe("invalid_value");
  expect(invalid.msg).toContain('agent profile "-x" is not a valid profile name');
  const ok = okOf(await start(fixture, ["--project", "widgets", "--profile", "shell", "--yes", "--json"]));
  expect(ok.plan.profile).toBe("shell");
  expect(ok.plan.argv).toContain("shell");
  expect(await sessions(core)).toHaveLength(1);
}, SCENARIO_TIMEOUT_MS);

test("--dry-run prints the plan with argv and prompt and launches nothing", async () => {
  const { daemon: core, fixture, workdir } = await setUp();
  const ok = okOf(await start(fixture, ["--project", "widgets", "--dry-run", "--json"]));
  expect(ok.dry_run).toBe(true);
  expect(ok.result).toBeUndefined();
  expect(ok.plan.argv).toEqual(expectedArgv(core, workdir, "manager:widgets", "widgets"));
  expect(ok.plan.prompt.trimEnd().split("\n").at(-1)).toBe(PROMPT_MARKER);
  const text = await start(fixture, ["--project", "widgets", "--dry-run"]);
  expect(text.code).toBe(0);
  expect(text.out).toContain("dry run: nothing was executed");
  expect(text.out).toContain(`--name manager:widgets`);
  expect(text.out).toContain(`  ${PROMPT_MARKER}`);
  expect(await sessions(core)).toEqual([]);

  const doctor = await runPlugin(fixture, ["doctor"], PROCESS_TIMEOUT_MS);
  expect(doctor.out).toContain(`ok   ok manager workdir: ${workdir} is a directory`);
  expect(doctor.out).toContain(`ok   ok manager workdir placement: ${workdir} lies outside every registered project checkout`);
  expect(doctor.code).not.toBe(EXIT_MANAGER_WORKDIR);
}, SCENARIO_TIMEOUT_MS);

test("a session name over the daemon's 128-byte limit is refused while planning; 128 bytes are accepted", async () => {
  const core = await startCoreDaemon();
  daemon = core;
  const [a, b, c] = ["a".repeat(60), "b".repeat(59), "c".repeat(60)];
  const long = [a, b, c].map((label) => ({ label, repo: `acme/${label}` }));
  for (const project of long) await core.registerProject(project.label, project.repo);
  const workdir = join(core.root, "manager");
  await mkdir(workdir, { mode: 0o700 });
  const fixture = await writePluginConfig(core, long, { extraGlobal: managerTable("shell", workdir) });

  const tooLong = errOf(await start(fixture, ["--project", a, "--project", c, "--dry-run", "--json"]));
  expect(tooLong.code).toBe("invalid_value");
  expect(tooLong.msg).toContain("128 bytes");
  expect(await sessions(core)).toEqual([]);

  // "manager:" and one separator around 60 + 59 characters is exactly 128 bytes, which the daemon accepts.
  const fits = okOf(await start(fixture, ["--project", a, "--project", b, "--yes", "--json"]));
  expect(Buffer.byteLength(fits.plan.name)).toBe(128);
  expect((await sessions(core)).map((session) => session.name)).toEqual([fits.plan.name]);
}, SCENARIO_TIMEOUT_MS);

test("an unreadable pohunek refuses with source_unavailable and launches nothing", async () => {
  const { daemon: core, fixture } = await setUp();
  const global = join(fixture.configDir, "config.toml");
  const text = await readFile(global, "utf8");
  const binLine = /^bin = .*$/m;
  if (!binLine.test(text)) throw new Error("the fixture configuration has no [pohunek] bin line");
  await writeFile(global, text.replace(binLine, `bin = ${JSON.stringify(join(core.root, "missing", "pohunek"))}`));
  const refused = errOf(await start(fixture, ["--project", "widgets", "--yes", "--json"]));
  expect(refused.code).toBe("source_unavailable");
  expect(refused.msg).toContain("nothing was launched");
  expect(await sessions(core)).toEqual([]);
}, SCENARIO_TIMEOUT_MS);

test("usage errors and a missing confirmation launch nothing", async () => {
  const { daemon: core, fixture } = await setUp();
  for (const args of [[], ["--project", "widgets", "--all"], ["--project", "widgets", "--dry-run", "--yes"], ["--project", "widgets", "extra"]]) {
    const usage = errOf(await start(fixture, [...args, "--json"]));
    expect(usage.class).toBe("usage");
    expect(usage.msg).toContain("pohunek-work manager start (--project <label>... | --all)");
  }
  const unconfirmed = errOf(await start(fixture, ["--project", "widgets", "--json"]));
  expect(unconfirmed.code).toBe("confirmation_required");
  expect(await sessions(core)).toEqual([]);
}, SCENARIO_TIMEOUT_MS);
