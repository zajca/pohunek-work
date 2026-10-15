// Regression: every inline attach ends with its session, and a failed attach is reported. The attach child is the
// real `pohunek attach` on real sessions. The owner's path is the attach menu (Ctrl-\ then t and y, or k and y).
// Other processes act from inside the attached shell, after the attach is confirmed by its output, so each trigger
// happens at a known point of the run and not on a timer.
import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { startSocketRelay, type SocketRelay } from "./support/socket-relay.ts";
import { startTcpRelay, type TcpRelay } from "./support/tcp-relay.ts";
import { daemonLocalSocket } from "../helpers/core-daemon.ts";

const CTRL_BACKSLASH = "1c";
const BUSY_REFUSAL = "Still working on the last action";
const READY = "ready-2";
const ECHO_READY = "echo ready-$((1+1))\r";
const ATTACH_SETTLE_MS = 2000;
const RETURN_SETTLE_MS = 1000;
const VIEW_SWITCH_MS = 500;
const INLINE = { overrides: { "tui.attach_mode": "inline" } };
const STOPPED_BY_SIGNAL = "stopped by SIGTERM";
const OUTPUT_WAIT_MS = 60_000;
const OUTPUT_POLL_MS = 300;
let scenario: TuiScenario | null = null;
let relay: SocketRelay | null = null;
let tcp: TcpRelay | null = null;

afterEach(async () => {
  tcp?.stop();
  tcp = null;
  await relay?.stop();
  relay = null;
  await scenario?.stop();
  scenario = null;
});

/** Opens the Sessions view, attaches the first session (inline, in this terminal) and waits for the shell's answer. */
function attachFirst(sessions: number): PtyStep[] {
  return [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: `SESSIONS  ${String(sessions)}` },
    keys("o"),
    { pause: ATTACH_SETTLE_MS },
    keys(ECHO_READY),
    { expect: READY },
  ];
}

/**
 * The keys that prove the TUI is back after the list was drawn: the view switches and come back to the list. The list
 * can be drawn while the attach child is still exiting, and a key typed then reaches the child, so the keys wait first.
 */
function backInTui(sessionsLeft: string): PtyStep[] {
  return [
    { pause: RETURN_SETTLE_MS },
    keys("3"),
    { expect: "HOSTS" },
    { pause: VIEW_SWITCH_MS },
    keys("2"),
    { expect: sessionsLeft },
  ];
}

/**
 * Resolves once the session has printed `text`, which the attached shell prints only after the attach is answering.
 * The daemon refuses a stop or removal sent from inside the session itself, so the trigger runs from the test.
 */
async function untilPrinted(tui: TuiScenario, id: string, text: string): Promise<void> {
  const deadline = Date.now() + OUTPUT_WAIT_MS;
  for (;;) {
    const output = JSON.parse((await tui.daemon.pohunek(["session", "output", id, "--json"])).stdout) as { ok?: { data_base64?: string } };
    if (Buffer.from(output.ok?.data_base64 ?? "", "base64").toString("utf8").includes(text)) return;
    if (Date.now() > deadline) throw new Error(`session ${id} never printed ${text}`);
    await Bun.sleep(OUTPUT_POLL_MS);
  }
}

test("the owner's path: Ctrl-\\ then terminate (t, y) ends the attach and the TUI comes back", async () => {
  scenario = await startTuiScenario(INLINE);
  await createShellSession(scenario.daemon, "alpha");
  await createShellSession(scenario.daemon, "beta");
  const steps: PtyStep[] = [
    ...attachFirst(2),
    { send: CTRL_BACKSLASH, settle: 800 },
    { expect: "Session menu" },
    keys("t"),
    { expect: "Terminate and delete session?" },
    keys("y"),
    { expect: "SESSIONS  1" },
    ...backInTui("SESSIONS  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the owner's path: Ctrl-\\ then kill (k, y) ends the attach and the TUI shows the session ended", async () => {
  scenario = await startTuiScenario(INLINE);
  await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    ...attachFirst(1),
    { send: CTRL_BACKSLASH, settle: 800 },
    { expect: "Session menu" },
    keys("k"),
    { expect: "Kill session?" },
    keys("y"),
    { expect: "UNAVAILABLE  1" },
    ...backInTui("UNAVAILABLE  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the session exits inside the attach: the TUI comes back and shows it ended", async () => {
  scenario = await startTuiScenario(INLINE);
  await createShellSession(scenario.daemon, "alpha");
  const steps: PtyStep[] = [
    ...attachFirst(1),
    keys("exit\r"),
    { expect: "UNAVAILABLE  1" },
    ...backInTui("UNAVAILABLE  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the session is stopped from outside once the attach answers: the TUI comes back and shows it ended", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  const stopping = untilPrinted(scenario, id, READY).then(() => scenario?.daemon.pohunek(["session", "stop", id]));
  const steps: PtyStep[] = [
    ...attachFirst(1),
    { expect: "UNAVAILABLE  1" },
    ...backInTui("UNAVAILABLE  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  await stopping;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("the session is removed from outside once the attach answers: the TUI comes back with the list drawn", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  const removing = untilPrinted(scenario, id, READY).then(() => scenario?.daemon.pohunek(["session", "rm", id]));
  const steps: PtyStep[] = [
    ...attachFirst(1),
    { expect: "No sessions" },
    ...backInTui("No sessions"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  await removing;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a SIGTERM from outside to the attach is reported and the session keeps running", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  // The pids of the attach and of the proxy that starts it both match the pattern; the proxy passes the signal on.
  const killAttach = keys(`kill -TERM $(/usr/bin/pgrep -f "attach --host local -- ${id}") 2>/dev/null\r`);
  const steps: PtyStep[] = [
    ...attachFirst(1),
    killAttach,
    { expect: STOPPED_BY_SIGNAL },
    { pause: RETURN_SETTLE_MS },
    keys("3"),
    { expect: "HOSTS" },
    keys("2"),
    { expect: "READY  1" },
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  const sessions = JSON.parse((await scenario.daemon.pohunek(["session", "list", "--json"])).stdout) as { ok?: { id: string; state: string }[] };
  expect(sessions.ok?.find((item) => item.id === id)?.state).toBe("running");
}, REAL_SCENARIO_TIMEOUT_MS);

test("a session created from the form is attached, and its end brings the TUI back", async () => {
  scenario = await startTuiScenario(INLINE);
  const tabs = (count: number): PtyStep[] => Array.from({ length: count }, (): PtyStep => ({ send: "09", settle: 100 }));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    keys("n"),
    { expect: "NEW SESSION" },
    ...tabs(7),
    keys("\r"),
    { expect: "sh-" },
    keys(ECHO_READY),
    { expect: READY },
    keys("exit\r"),
    { expect: "UNAVAILABLE  1" },
    ...backInTui("UNAVAILABLE  1"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
}, REAL_SCENARIO_TIMEOUT_MS);

/** Rules of the test proxy: the proxy reads them at every call, so a rewrite takes effect at the next CLI call. */
function proxyRulesFile(tui: TuiScenario): string {
  return join(dirname(tui.proxy.binary), "rules.json");
}

/** Writes proxy rules from the attached shell, a process of its own that the proxy does not see as the session. */
function writeRules(tui: TuiScenario, rules: unknown): PtyStep {
  return keys(`printf '%s' '${JSON.stringify(rules)}' > ${proxyRulesFile(tui)}\r`);
}

/** Waits until the proxy refuses `host discover`, which the TUI's refresh runs; the failure is then in effect. */
async function untilDiscoveryFails(tui: TuiScenario): Promise<void> {
  const deadline = Date.now() + OUTPUT_WAIT_MS;
  for (;;) {
    const proc = Bun.spawn([tui.proxy.binary, "host", "discover", "--json"], { env: tui.daemon.clientEnv, stdout: "pipe", stderr: "pipe" });
    const exit = await proc.exited;
    if (exit !== 0) return;
    if (Date.now() > deadline) throw new Error("the proxy never refused host list");
    await Bun.sleep(OUTPUT_POLL_MS);
  }
}

const EMPTY_LIST_WINDOW_MS = 8000;
const DISCOVERY_SETTLE_MS = 4000;

test("discovery fails and the attached local session is removed: the attach ends and the TUI comes back", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  // The removal runs from the test once the proxy refuses discovery, so the snapshot has the discovery error.
  const removing = untilPrinted(scenario, id, READY)
    .then(() => untilDiscoveryFails(scenario as TuiScenario))
    // The TUI's own refresh must read the failure before the removal, so the removal snapshot carries it. No output
    // shows that read, so the wait is a settle time for the TUI's refresh.
    .then(() => Bun.sleep(DISCOVERY_SETTLE_MS))
    .then(() => scenario?.daemon.pohunek(["session", "rm", id]));
  const steps: PtyStep[] = [
    ...attachFirst(1),
    writeRules(scenario, [{ match: ["host", "discover"], failWith: 1 }]),
    // The TUI shows the discovery error in its header, so the failure is observed before the removal.
    { expect: "host/source error" },
    // The main footer comes back only when the TUI redraws after the attach; the list then shows the session gone.
    { expect: "Tab views" },
    // The list shows the session gone or kept as stopped, depending on the failed read; the toolbar is the same in both.
    ...backInTui("Search /"),
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  await removing;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);

test("a snapshot without the attached session does not end the attach while a read says it is running", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  // Stand-in: the real daemon cannot produce a snapshot that lacks a running session it still lists, so the socket
  // relay answers the session list with nothing for the window, and the attach must not end on that snapshot.
  const flag = join(dirname(scenario.proxy.binary), "empty-list.flag");
  relay = await startSocketRelay(daemonLocalSocket(scenario.daemon), { holdSessionId: "none", holdMs: 0, skipCount: 0, holdCount: 0, refuseHealthAfterHold: false, emptySessionListFlag: flag });
  const window = untilPrinted(scenario, id, READY).then(async () => {
    await writeFile(flag, "");
    // A session event makes the TUI read the session list inside the window.
    await createShellSession(scenario?.daemon as TuiScenario["daemon"], "beta");
    await Bun.sleep(EMPTY_LIST_WINDOW_MS);
    await rm(flag, { force: true });
  });
  const steps: PtyStep[] = [
    ...attachFirst(1),
    { pause: EMPTY_LIST_WINDOW_MS + RETURN_SETTLE_MS },
    keys("echo still-$((1+1))\r"),
    { expect: "still-2" },
  ];
  const result = await scenario.run(steps, { timeoutS: 90, env: { POHUNEK_SOCKET_PATH: relay.socket } });
  await window;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  // The relay counts the empty replies it served; without one the window tested nothing.
  expect(await readFile(`${flag}.served`, "utf8").catch(() => "")).toContain("served");
}, REAL_SCENARIO_TIMEOUT_MS);

// A remote host served through a TCP listener of the test process (the real daemon reaches remote peers over TCP, the
// harness has only the unix socket), so its reads can be refused without touching the TUI or its SDK.
const REMOTE = "remote-peer";
const REMOTE_FAILURE_MS = 6000;

test("a remote host whose reads fail keeps its attach, and the attach ends once a read confirms the session stopped", async () => {
  scenario = await startTuiScenario(INLINE);
  const id = await createShellSession(scenario.daemon, "alpha");
  const daemon = scenario.daemon;
  tcp = startTcpRelay(daemonLocalSocket(daemon));
  await scenario.proxy.setRules([
    { match: ["host", "discover"], appendOk: [{ name: REMOTE, fqdn: "remote.netbird.example", address: "127.0.0.1", port: tcp.port, overlay: "netbird", peer_id: REMOTE, classification: "reachable_daemon", daemon_version: "0.34.2" }] },
    { match: [], aliasPrefix: { from: "netbird:", to: "local" } },
  ]);
  // The remote reads are refused for a window after the attach answers; then the relay recovers and the session is
  // stopped, so the first successful read confirms the end.
  const remote = untilPrinted(scenario, id, READY).then(async () => {
    tcp?.setFailing(true);
    await Bun.sleep(REMOTE_FAILURE_MS);
    tcp?.setFailing(false);
    await daemon.pohunek(["session", "stop", id]);
  });
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "SESSIONS  2" },
    keys("\x1b[B"),
    keys("o"),
    { pause: ATTACH_SETTLE_MS },
    keys(ECHO_READY),
    { expect: READY },
    // Inside the failure window the attach must still take input.
    { pause: REMOTE_FAILURE_MS / 2 },
    keys("echo still-$((1+1))\r"),
    { expect: "still-2" },
    // After recovery and the confirmed stop the attach is gone and the TUI is back.
    { pause: REMOTE_FAILURE_MS },
    { expect: "UNAVAILABLE" },
  ];
  const result = await scenario.run(steps, { timeoutS: 120 });
  await remote;
  expect(tcp.refusedCount(), "no remote read was refused").toBeGreaterThan(0);
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);
