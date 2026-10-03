// Behaviour of the portable `pohunek_run_with_timeout` helper in lib.sh. It is the
// most shell-sensitive code in the launchers (dash ignores `set -m` in subshells, macOS
// has no setsid(1)), so every scenario runs under the shell named by POHUNEK_TEST_SHELL.
import { expect, test } from "bun:test";
import { scriptPath, shellArgv } from "./helpers.ts";

/** Wall-clock bound of each scenario, far above every expected duration. */
const SCENARIO_TIMEOUT_MS = 20_000;
/** How long a process killed at the deadline may take to leave `ps`. */
const REAP_BOUND_MS = 2_000;
const REAP_POLL_MS = 50;
/** The helper's TERM-to-KILL grace is one second; scenarios bound their duration relative to it. */
const SHORT_RUN_SECONDS = 5;
const KILLED_RUN_SECONDS = 6;
const ESCALATED_RUN_SECONDS = 8;

interface Scenario {
  readonly stdout: string;
  readonly elapsedSeconds: number;
}

/** Runs `body` after sourcing lib.sh; the body's `status` variable is printed last. */
async function run(body: string, stdin?: string): Promise<Scenario> {
  const script = `. "${scriptPath("lib.sh")}"\nstatus=0\n${body}\nprintf "status=%s\\n" "$status"\n`;
  const started = performance.now();
  const child = Bun.spawn([...shellArgv(), "-c", script], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: SCENARIO_TIMEOUT_MS,
    env: { PATH: process.env["PATH"] ?? "" },
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  expect(child.exitCode, stderr).toBe(0);
  return { stdout, elapsedSeconds: (performance.now() - started) / 1000 };
}

async function running(marker: string): Promise<boolean> {
  const child = Bun.spawn(["ps", "-A", "-o", "args="], { stdout: "pipe", stderr: "ignore" });
  const listing = await new Response(child.stdout).text();
  await child.exited;
  return listing.split("\n").some((line) => line.includes(marker) && !line.includes("ps -A"));
}

/** Whether no process matching `marker` remains within the reap bound; a process killed by the last KILL may await its reaper briefly. */
async function gone(marker: string): Promise<boolean> {
  const deadline = Date.now() + REAP_BOUND_MS;
  while (await running(marker)) {
    if (Date.now() > deadline) return false;
    await Bun.sleep(REAP_POLL_MS);
  }
  return true;
}

test("an early exit keeps the status and cancels the watchdog", async () => {
  // A distinctive deadline makes the watchdog's sleeper findable in `ps`.
  const { stdout, elapsedSeconds } = await run('pohunek_run_with_timeout 17.25 sh -c "exit 3" || status=$?');
  // dash reports signalled jobs ("Terminated"); nothing may leak into stdout.
  expect(stdout).toBe("status=3\n");
  expect(elapsedSeconds).toBeLessThan(SHORT_RUN_SECONDS);
  expect(await running("sleep 17.25"), "watchdog sleeper was left behind").toBe(false);
});

test("fast commands never print job reports", async () => {
  // A command that exits before the watchdog installs its trap must not make dash print "Terminated".
  const body = Array.from({ length: 20 }, () => "pohunek_run_with_timeout 5 true || status=$?").join("\n");
  expect((await run(body)).stdout).toBe("status=0\n");
});

test("success returns zero and passes stdin and stdout through", async () => {
  expect((await run("pohunek_run_with_timeout 10 cat || status=$?", "hello\n")).stdout).toBe("hello\nstatus=0\n");
});

test("the deadline returns 124 and reaps the command", async () => {
  const { stdout, elapsedSeconds } = await run("pohunek_run_with_timeout 1 sleep 31.5 || status=$?");
  expect(stdout).toBe("status=124\n");
  expect(elapsedSeconds).toBeLessThan(KILLED_RUN_SECONDS);
  expect(await running("sleep 31.5"), "timed-out command was left behind").toBe(false);
});

test("a success reaped after the deadline is not a timeout", async () => {
  // The command stops the calling shell and exits 0 at once, so it stays an unreaped zombie
  // until a helper resumes the shell. The watchdog fires in between and its TERM "succeeds"
  // against the zombie; the shell must still report the command's own success. The resumer
  // runs outside the command's process group, which the deadline kills.
  const resumeAfterSeconds = 1.5; // past the 1 s deadline, inside the 1 s TERM grace
  const { stdout, elapsedSeconds } = await run(
    `(sleep ${String(resumeAfterSeconds)}; kill -CONT "$$") >/dev/null 2>&1 &\n` +
      "pohunek_run_with_timeout 1 sh -c 'kill -STOP \"$1\"; exit 0' _ \"$$\" || status=$?",
  );
  expect(stdout).toBe("status=0\n");
  expect(elapsedSeconds).toBeLessThan(KILLED_RUN_SECONDS);
});

test("a command failing after TERM reports the timeout", async () => {
  // A command that handles TERM and exits non-zero was still stopped by the deadline.
  const exitOnTerm = "import signal, sys, time; signal.signal(signal.SIGTERM, lambda *_: sys.exit(7)); time.sleep(33.5)";
  const { stdout, elapsedSeconds } = await run(`pohunek_run_with_timeout 1 python3 -c '${exitOnTerm}' || status=$?`);
  expect(stdout).toBe("status=124\n");
  expect(elapsedSeconds).toBeLessThan(KILLED_RUN_SECONDS);
  expect(await running("time.sleep(33.5)"), "timed-out command survived").toBe(false);
});

test("a command ignoring TERM is killed after the grace", async () => {
  const ignoreTerm = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(32.5)";
  const { stdout, elapsedSeconds } = await run(`pohunek_run_with_timeout 1 python3 -c '${ignoreTerm}' || status=$?`);
  expect(stdout).toContain("status=124");
  expect(elapsedSeconds).toBeLessThan(ESCALATED_RUN_SECONDS);
  expect(await running("time.sleep(32.5)"), "TERM-ignoring command survived").toBe(false);
});

test("a descendant ignoring TERM is killed after the grace", async () => {
  // The command's own shell dies on TERM, but the child it spawned ignores TERM; the
  // escalation must still reach it through the process group. The child's output goes to
  // /dev/null so a survivor cannot hold the captured pipe open.
  const ignoreTerm = "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(34.5)";
  const command = `python3 -c "${ignoreTerm}" >/dev/null 2>&1 & wait`;
  const { stdout, elapsedSeconds } = await run(`pohunek_run_with_timeout 1 sh -c '${command}' || status=$?`);
  expect(stdout).toBe("status=124\n");
  expect(elapsedSeconds).toBeLessThan(ESCALATED_RUN_SECONDS);
  expect(await gone("time.sleep(34.5)"), "TERM-ignoring descendant survived the timeout").toBe(true);
});

test("no descendant survives the timeout", async () => {
  // Descendants in the command's group receive the deadline's TERM although only their parent is the helper's child.
  const command = "sleep 35.5 >/dev/null 2>&1 & sleep 36.5 >/dev/null 2>&1 & wait";
  const { stdout, elapsedSeconds } = await run(`pohunek_run_with_timeout 1 sh -c '${command}' || status=$?`);
  expect(stdout).toBe("status=124\n");
  expect(elapsedSeconds).toBeLessThan(ESCALATED_RUN_SECONDS);
  expect(await gone("sleep 35.5"), "descendant survived the timeout").toBe(true);
  expect(await gone("sleep 36.5"), "descendant survived the timeout").toBe(true);
});

test("a missing command keeps the shell status", async () => {
  expect((await run("pohunek_run_with_timeout 5 pohunek-no-such-command || status=$?")).stdout).toBe("status=127\n");
});
