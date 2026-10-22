// An inline attach with `[tui] detach_sequence` runs the real `pohunek attach` in a pseudo-terminal the TUI owns.
// Typing the sequence returns to the TUI with the session still running; any other input, including keys that hold
// a part of the sequence, escape sequences and pasted text, reaches the session unchanged; Ctrl-] still detaches;
// and the session's terminal follows a resize of the TUI's terminal.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const SEQUENCE = "~.";
const CTRL_DETACH = "1d";
/** Ctrl-U discards the shell's input line, so a line that only carried keys under test does not run. */
const KILL_LINE = "15";
const DELETE_KEY = Buffer.from("\x1b[3~").toString("hex");
const PASTED_SEQUENCE = Buffer.from(`\x1b[200~${SEQUENCE}\x1b[201~`).toString("hex");
const ATTACH_FAILED = "attach exited";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

/** Opens the only session from the Sessions view and waits for its shell. */
const openSession: readonly PtyStep[] = [
  { expect: "CONTROL CENTER" },
  keys("2"),
  { expect: "SESSIONS  1" },
  keys("o"),
  { pause: 1500 },
  { clear: true },
];

test("the typed sequence detaches; other input reaches the session; Ctrl-] still detaches", async () => {
  scenario = await startTuiScenario({ overrides: { "tui.detach_sequence": SEQUENCE } });
  const id = await createShellSession(scenario.daemon, "detach-sequence");
  const steps: PtyStep[] = [
    ...openSession,
    // A held `~` is released when the next key breaks the match; the shell prints what it received.
    keys("v=A~B.C; echo \"<$v>\"\r"),
    { expect: "<A~B.C>" },
    // `~` that ends an escape sequence (Delete) is not typed, so the `.` after it does not detach.
    { send: DELETE_KEY },
    keys("."),
    { send: KILL_LINE },
    keys("echo $((6*7))\r"),
    { expect: "42" },
    // Pasted text never detaches, even when it is exactly the sequence.
    { send: PASTED_SEQUENCE },
    { send: KILL_LINE },
    keys("echo $((6*8))\r"),
    { expect: "48" },
    keys(SEQUENCE),
    { expect: "SESSIONS  1" },
    { absent: ATTACH_FAILED },
    // The session still runs: a second attach reaches its shell, and Ctrl-] detaches through the relay.
    keys("o"),
    { pause: 1500 },
    { clear: true },
    keys("echo $((7*8))\r"),
    { expect: "56" },
    { send: CTRL_DETACH, settle: 1500 },
    { expect: "SESSIONS  1" },
    { absent: ATTACH_FAILED },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  const inspected = await scenario.daemon.pohunek(["session", "inspect", id, "--json"]);
  expect((JSON.parse(inspected.stdout) as { ok?: { state?: unknown } }).ok?.state).toBe("running");
  const attaches = (await scenario.proxy.calls()).filter((call) => call.includes("attach"));
  expect(attaches.length).toBe(2);
}, SCENARIO_TIMEOUT_MS);

test("the session's terminal follows a resize of the TUI's terminal", async () => {
  scenario = await startTuiScenario({ overrides: { "tui.detach_sequence": SEQUENCE } });
  await createShellSession(scenario.daemon, "detach-resize");
  const steps: PtyStep[] = [
    ...openSession,
    { resize: [31, 97] },
    { pause: 500 },
    // The session's shell has no PATH; bash keeps LINES and COLUMNS at the size of its terminal.
    keys("echo \"<$LINES/$COLUMNS>\"\r"),
    { expect: "<31/97>" },
    keys(SEQUENCE),
    { expect: "SESSIONS  1" },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("the config accepts the sequence only in inline mode and only as 2 to 16 printable characters", async () => {
  const cases: { overrides: Record<string, string | number>; problem: string }[] = [
    { overrides: { "tui.detach_sequence": "." }, problem: "detach_sequence must be 2 to 16 printable ASCII characters without space" },
    { overrides: { "tui.detach_sequence": "~ ." }, problem: "detach_sequence must be 2 to 16 printable ASCII characters without space" },
    { overrides: { "tui.detach_sequence": "~".repeat(17) }, problem: "detach_sequence must be 2 to 16 printable ASCII characters without space" },
    {
      overrides: { "tui.attach_mode": "window", "tui.attach_command": "/usr/bin/kitty {id}", "tui.attach_launch_check_ms": 500, "tui.detach_sequence": SEQUENCE },
      problem: "detach_sequence is only used with attach_mode = \"inline\"",
    },
  ];
  for (const testCase of cases) {
    scenario = await startTuiScenario({ overrides: testCase.overrides });
    const run = Bun.spawn([Bun.which("bun") ?? "bun", new URL("../../src/main.ts", import.meta.url).pathname, "tui"], {
      env: { ...scenario.fixture.env, CI: "true" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    expect(exit, JSON.stringify(testCase.overrides)).not.toBe(0);
    expect(stdout + stderr).toContain(testCase.problem);
    await scenario.stop();
    scenario = null;
  }
}, SCENARIO_TIMEOUT_MS);
