// Regression (hermes: a late live-output reply must not replace the session the owner moved to): the reply to
// the first session's output read is held by a socket relay while the owner moves to the second session. The
// core serves both outputs for real; the first session's text can reach the screen only through that reply.
import { afterEach, expect, test } from "bun:test";
import { daemonLocalSocket } from "../helpers/core-daemon.ts";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { startSocketRelay, type SocketRelay } from "./support/socket-relay.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
/** Long enough for the owner to move to the second session before the first session's reply arrives. */
const HOLD_MS = 3000;
const DOWN = "\x1b[B";
let scenario: TuiScenario | null = null;
let relay: SocketRelay | null = null;

afterEach(async () => {
  await relay?.stop();
  relay = null;
  await scenario?.stop();
  scenario = null;
});

test("a late output reply for the first session never replaces the panel of the session the owner moved to", async () => {
  scenario = await startTuiScenario({ rules: [] });
  const first = await createShellSession(scenario.daemon, "alpha-screen");
  const second = await createShellSession(scenario.daemon, "beta-screen");
  for (const [id, text] of [[first, "echo AAA-MARK"], [second, "echo BBB-MARK"]] as const) {
    const sent = await scenario.daemon.pohunek(["session", "input", id, text, "--json"]);
    if (!sent.stdout.includes('"ok"')) throw new Error(`session input failed: ${sent.stdout}${sent.stderr}`);
  }
  relay = await startSocketRelay(daemonLocalSocket(scenario.daemon), { holdSessionId: first, holdMs: HOLD_MS, holdCount: Number.MAX_SAFE_INTEGER, refuseHealthAfterHold: false });
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "alpha-screen · local · shell" },
    keys(DOWN),
    { expect: "beta-screen · local · shell" },
    // The second session's read waits behind the held reply on the same link, so its output follows the release.
    { pause: HOLD_MS + 1000 },
    { expect: "BBB-MARK" },
  ];
  const result = await scenario.run(steps, { timeoutS: 40, env: { POHUNEK_SOCKET_PATH: relay.socket } });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  // The first session's reply is held for the whole time the panel shows the second session, so its text
  // can appear only if the TUI draws that reply.
  expect(result.output).not.toContain("AAA-MARK");
}, SCENARIO_TIMEOUT_MS);
