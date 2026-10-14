// Live output across a daemon outage. The socket relay holds the reply to the first output read past the
// SDK's bound, so the link drops and reconnects. The panel must show the outage, then read the output again
// once the session list is back, instead of staying on the outage message.
import { afterEach, expect, test } from "bun:test";
import { daemonLocalSocket } from "../helpers/core-daemon.ts";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { startSocketRelay, type SocketRelay } from "./support/socket-relay.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const HOLD_MS = 4000;
const OVERRIDES = { "pohunek.timeout_ms": 1000, "tui.reconnect_max_secs": 1, "tui.output_wait_ms": 300 };
let scenario: TuiScenario | null = null;
let relay: SocketRelay | null = null;

afterEach(async () => {
  await relay?.stop();
  relay = null;
  await scenario?.stop();
  scenario = null;
});

/** Starts the TUI behind a relay whose first output reply past the SDK bound is held; returns the TUI's socket. */
async function startOutageScenario(refuseHealthAfterHold: boolean): Promise<{ run: TuiScenario; socket: string }> {
  const started = await startTuiScenario({ rules: [], overrides: OVERRIDES });
  scenario = started;
  const id = await createShellSession(started.daemon, "outage-panel");
  const sent = await started.daemon.pohunek(["session", "input", id, "echo OUT-MARK\n", "--json"]);
  if (!sent.stdout.includes('"ok"')) throw new Error(`session input failed: ${sent.stdout}${sent.stderr}`);
  const relayStarted = await startSocketRelay(daemonLocalSocket(started.daemon), { holdSessionId: id, holdMs: HOLD_MS, holdCount: 1, refuseHealthAfterHold });
  relay = relayStarted;
  return { run: started, socket: relayStarted.socket };
}

test("the panel reads the output again once the daemon is reachable after an outage", async () => {
  const outage = await startOutageScenario(false);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "output unavailable: no daemon response" },
    { expect: "OUT-MARK" },
  ];
  const result = await outage.run.run(steps, { timeoutS: 40, env: { POHUNEK_SOCKET_PATH: outage.socket } });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);

test("a reconnect the daemon refuses stops retrying and the panel says why", async () => {
  const outage = await startOutageScenario(true);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "output unavailable: no daemon response" },
    { expect: "relay refuses health" },
  ];
  const result = await outage.run.run(steps, { timeoutS: 40, env: { POHUNEK_SOCKET_PATH: outage.socket } });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
}, SCENARIO_TIMEOUT_MS);
