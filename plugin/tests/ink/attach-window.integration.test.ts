// Window attach at the process boundary: the TUI starts the terminal of `attach_command` detached and
// reports its launch check. The terminal is a stub script that records its argv, and an inline attach
// stays the default when no mode is configured.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keys, runPty, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const LAUNCH_CHECK_MS = 500;
const DETACH = "1d";
const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;
let scenario: TuiScenario | null = null;
let directory: string | null = null;
let pidFile: string | null = null;

afterEach(async () => {
  // The recording terminal runs detached and keeps running; the test ends it.
  if (pidFile !== null) {
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  }
  pidFile = null;
  await scenario?.stop();
  scenario = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

/** A terminal stub: records its argv in `trace` and then stays alive, as a real terminal window does. */
async function recordingTerminal(dir: string): Promise<{ path: string; trace: string }> {
  // The TUI's child environment has no PATH entry for sleep, so the stub names it by its absolute path.
  const sleep = Bun.which("sleep");
  if (sleep === null) throw new Error("sleep is not on PATH; the recording terminal stub needs it");
  const trace = join(dir, "argv.txt");
  const path = join(dir, "terminal-stub");
  pidFile = join(dir, "terminal.pid");
  await writeFile(path, `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg"; done > ${JSON.stringify(trace)}
echo $$ > ${JSON.stringify(pidFile)}
exec ${JSON.stringify(sleep)} 60
`);
  await chmod(path, 0o700);
  return { path, trace };
}

/** A terminal that fails at once, as a missing display does. */
async function failingTerminal(dir: string): Promise<string> {
  const path = join(dir, "failing-terminal");
  await writeFile(path, "#!/bin/sh\nprintf 'no display\\n' >&2\nexit 3\n");
  await chmod(path, 0o700);
  return path;
}

test("window mode starts the terminal with the exact argv and the TUI stays responsive", async () => {
  directory = await mkdtemp(join(tmpdir(), "pohunek-attach-window-"));
  const terminal = await recordingTerminal(directory);
  const template = `${terminal.path} --bin={bin} --host={host} --name="session {id} label" attach -- {id}`;
  scenario = await startTuiScenario({
    overrides: { "tui.attach_mode": "window", "tui.attach_command": template, "tui.attach_launch_check_ms": LAUNCH_CHECK_MS },
  });
  const id = await createShellSession(scenario.daemon, "window");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("o"),
    { expect: "opened in a new window" },
    // The TUI keeps reading input while the terminal runs: the next view switch is drawn.
    keys("3"),
    { expect: "HOSTS" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const argv = (await readFile(terminal.trace, "utf8")).split("\n").filter((line) => line !== "");
  expect(argv).toEqual([`--bin=${scenario.proxy.binary}`, "--host=local", `--name=session ${id} label`, "attach", "--", id]);
}, SCENARIO_TIMEOUT_MS);

test("a terminal that exits within the launch check is reported as a failed launch", async () => {
  directory = await mkdtemp(join(tmpdir(), "pohunek-attach-window-"));
  const terminal = await failingTerminal(directory);
  scenario = await startTuiScenario({
    overrides: { "tui.attach_mode": "window", "tui.attach_command": `${terminal} {id}`, "tui.attach_launch_check_ms": LAUNCH_CHECK_MS },
  });
  await createShellSession(scenario.daemon, "failing");
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("o"),
    { expect: "exited with status 3 within the launch check" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("the config rejects inline mode with a command, window mode without one, and a relative program", async () => {
  const cases: { overrides: Record<string, string | number>; problem: string }[] = [
    {
      overrides: { "tui.attach_mode": "inline", "tui.attach_command": "/usr/bin/kitty {id}" },
      problem: "attach_command is only used with attach_mode = \"window\"",
    },
    { overrides: { "tui.attach_mode": "window", "tui.attach_launch_check_ms": LAUNCH_CHECK_MS }, problem: "attach_command is required with attach_mode = \"window\"" },
    {
      overrides: { "tui.attach_mode": "window", "tui.attach_command": "kitty -e {bin} attach -- {id}", "tui.attach_launch_check_ms": LAUNCH_CHECK_MS },
      problem: "must start with an absolute program path",
    },
  ];
  for (const testCase of cases) {
    scenario = await startTuiScenario({ overrides: testCase.overrides });
    const run = Bun.spawn([Bun.which("bun") ?? "bun", MAIN, "tui"], { env: { ...scenario.fixture.env, CI: "true" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect(exit, JSON.stringify(testCase.overrides)).not.toBe(0);
    expect(stdout + stderr).toContain(testCase.problem);
    await scenario.stop();
    scenario = null;
  }
}, SCENARIO_TIMEOUT_MS);

test("the --attach flag overrides the configured mode for one run", async () => {
  // Window requested by the flag, with no attach_command configured: the TUI refuses to start.
  scenario = await startTuiScenario();
  const refused = Bun.spawn([Bun.which("bun") ?? "bun", MAIN, "tui", "--attach", "window"], { env: { ...scenario.fixture.env, CI: "true" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [refusedOut, refusedErr, refusedExit] = await Promise.all([new Response(refused.stdout).text(), new Response(refused.stderr).text(), refused.exited]);
  expect(refusedExit).not.toBe(0);
  expect(refusedOut + refusedErr).toContain("window attach needs attach_command");

  // Inline requested by the flag while the config is window mode: the session is attached inline, so the
  // recording terminal never runs and the TUI is handed the terminal (the real `pohunek attach`).
  await scenario.stop();
  directory = await mkdtemp(join(tmpdir(), "pohunek-attach-window-"));
  const terminal = await recordingTerminal(directory);
  scenario = await startTuiScenario({
    overrides: { "tui.attach_mode": "window", "tui.attach_command": `${terminal.path} {id}`, "tui.attach_launch_check_ms": LAUNCH_CHECK_MS },
  });
  await createShellSession(scenario.daemon, "inline-flag");
  const result = await runPty({
    cmd: [Bun.which("bun") ?? "bun", MAIN, "tui", "--attach", "inline"],
    env: { ...scenario.fixture.env, TERM: "xterm-256color", CI: "true" },
    cols: 120,
    rows: 40,
    steps: [
      { expect: "CONTROL CENTER" },
      keys("2"),
      { expect: "SESSIONS  1" },
      keys("o"),
      { pause: 1500 },
      { send: DETACH, settle: 1500 },
      { expect: "SESSIONS  1" },
      keys("q"),
    ],
    timeoutS: 60,
  });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  expect(result.output).not.toContain("opened in a new window");
  // The recording terminal never ran, so its trace file was never written.
  expect(await readFile(terminal.trace, "utf8").catch(() => null)).toBeNull();
}, SCENARIO_TIMEOUT_MS);

test("a window terminal outlives the TUI and keeps writing to stderr after it has quit", async () => {
  // The stub waits past the TUI's exit, writes to stderr, and then records that it is still running.
  const sleep = Bun.which("sleep");
  if (sleep === null) throw new Error("sleep is not on PATH; the terminal stub needs it");
  directory = await mkdtemp(join(tmpdir(), "pohunek-attach-window-"));
  const marker = join(directory, "survived");
  const path = join(directory, "late-terminal");
  await writeFile(path, `#!/bin/sh
${JSON.stringify(sleep)} 1
echo late >&2
echo ok > ${JSON.stringify(marker)}
exec ${JSON.stringify(sleep)} 60
`);
  await chmod(path, 0o700);
  scenario = await startTuiScenario({
    overrides: { "tui.attach_mode": "window", "tui.attach_command": `${path} {id}`, "tui.attach_launch_check_ms": LAUNCH_CHECK_MS },
  });
  await createShellSession(scenario.daemon, "late");
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("o"),
    { expect: "opened in a new window" },
    keys("q"),
  ], { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  // The terminal wrote to stderr after the TUI was gone; it must still be running to record the marker.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await readFile(marker, "utf8").catch(() => null) !== null) break;
    await Bun.sleep(200);
  }
  expect(await readFile(marker, "utf8").catch(() => null)).toBe("ok\n");
}, SCENARIO_TIMEOUT_MS);

test("a failed launch is reported while a descendant of the terminal still holds its stderr", async () => {
  // The terminal exits with status 3 at once, but leaves a background child that keeps stderr open.
  const sleep = Bun.which("sleep");
  if (sleep === null) throw new Error("sleep is not on PATH; the terminal stub needs it");
  directory = await mkdtemp(join(tmpdir(), "pohunek-attach-window-"));
  const path = join(directory, "descendant-terminal");
  await writeFile(path, `#!/bin/sh
(${JSON.stringify(sleep)} 30) &
echo "display refused" >&2
exit 3
`);
  await chmod(path, 0o700);
  scenario = await startTuiScenario({
    overrides: { "tui.attach_mode": "window", "tui.attach_command": `${path} {id}`, "tui.attach_launch_check_ms": LAUNCH_CHECK_MS },
  });
  await createShellSession(scenario.daemon, "descendant");
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("o"),
    { expect: "exited with status 3 within the launch check" },
    keys("q"),
  ], { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
