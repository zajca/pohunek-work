// Regression: a TUI that runs inside a Pohunek-managed session carries that session's origin, so the daemon
// refuses a stop or a removal the TUI aims at the same session. The daemon id is read from the session's own shell,
// which holds the same POHUNEK_DAEMON_ID a process inside the session would see.
import { afterEach, expect, test } from "bun:test";
import type { CoreDaemon } from "../helpers/core-daemon.ts";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { keys } from "./support/pty.ts";

let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

/** The value of an environment variable in the session's shell, read from the session's screen. */
async function shellVariable(daemon: CoreDaemon, id: string, name: string): Promise<string> {
  const label = `ORIGIN_${name}`;
  const sent = await daemon.pohunek(["session", "input", id, `echo ${label}=$${name}\n`, "--json"]);
  if (!sent.stdout.includes('"ok"')) throw new Error(`session input failed: ${sent.stdout}${sent.stderr}`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const screen = await daemon.pohunek(["session", "screen", id, "--json"]);
    const lines = (JSON.parse(screen.stdout) as { ok?: { visible_lines?: string[] } }).ok?.visible_lines ?? [];
    const match = lines.map((line) => new RegExp(`${label}=([A-Za-z0-9_.:-]+)`).exec(line)).find((found) => found !== null);
    if (match?.[1] !== undefined) return match[1];
    if (Date.now() > deadline) throw new Error(`the session shell did not print ${name}`);
    await Bun.sleep(100);
  }
}

async function sessionState(daemon: CoreDaemon, id: string): Promise<string> {
  const inspected = await daemon.pohunek(["session", "inspect", id, "--json"]);
  return (JSON.parse(inspected.stdout) as { ok?: { state?: string } }).ok?.state ?? "unknown";
}

test("the daemon refuses a stop or a removal aimed at the session that hosts the TUI", async () => {
  scenario = await startTuiScenario();
  const id = await createShellSession(scenario.daemon, "hosting");
  const daemonId = await shellVariable(scenario.daemon, id, "POHUNEK_DAEMON_ID");
  const refusal = "cannot mutate that origin session";
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "hosting" },
    keys("x"),
    { expect: "Confirm stop" },
    keys("y"),
    { expect: refusal },
    keys("D"),
    { expect: "Confirm remove" },
    keys("y"),
    { pause: 2000 },
  ], { timeoutS: 40, env: { POHUNEK_SESSION_ID: id, POHUNEK_DAEMON_ID: daemonId } });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  // The refusal came from the daemon, so the session is still running and still listed.
  expect(await sessionState(scenario.daemon, id)).toBe("running");
}, REAL_SCENARIO_TIMEOUT_MS);
