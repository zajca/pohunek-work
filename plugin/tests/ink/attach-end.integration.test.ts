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
import type { ProxyRule } from "./support/cli-proxy.ts";
import { daemonLocalSocket } from "../helpers/core-daemon.ts";

const CTRL_BACKSLASH = "1c";
const BUSY_REFUSAL = "Still working on the last action";
const READY = "ready-2";
const ECHO_READY = "echo ready-$((1+1))\r";
const ATTACH_SETTLE_MS = 2000;
const RETURN_SETTLE_MS = 1000;
const RETURN_WITHIN_MS = 12_000;
const VIEW_SWITCH_MS = 500;
const INLINE = { overrides: { "tui.attach_mode": "inline" } };
const STOPPED_BY_SIGNAL = "stopped by SIGTERM";
const OUTPUT_WAIT_MS = 60_000;
const OUTPUT_POLL_MS = 300;
let scenario: TuiScenario | null = null;
let relay: SocketRelay | null = null;
let tcp: TcpRelay | null = null;

afterEach(async () => {
  // Every teardown step runs even when one rejects, so a leaked connection does not keep the daemon alive; the first
  // rejection is rethrown afterwards so the leak still fails the test.
  const steps = await Promise.allSettled([tcp?.stop(), relay?.stop(), scenario?.stop()]);
  tcp = null;
  relay = null;
  scenario = null;
  const failed = steps.find((step): step is PromiseRejectedResult => step.status === "rejected");
  if (failed !== undefined) throw failed.reason;
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
  // Each Tab waits for the marker of the field it must reach, so Tabs are never sent faster than the form moves; the
  // last Tab is confirmed by the marker of the submit row before Enter.
  const tab: PtyStep = { send: "09", settle: 100 };
  const movesToBaseBranch = ["Agent", "Action/template", "Name", "Prompt", "Branch", "Base branch"].flatMap((label): PtyStep[] => [tab, { expect: `▸ ${label}` }]);
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    keys("n"),
    { expect: "NEW SESSION" },
    ...movesToBaseBranch,
    tab,
    { expect: "▸ Create and attach" },
    keys("\r"),
    // The shell prompt differs between hosts, so the attach is awaited with the settle the other attach scenarios use.
    { pause: ATTACH_SETTLE_MS },
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

/**
 * Waits until the proxy refused a `host discover` call: the rule answers with a stand-in that appends to a marker file
 * and fails, so the marker counts the refusals the TUI's refresh received.
 */
async function untilDiscoveryRefused(marker: string): Promise<void> {
  const deadline = Date.now() + OUTPUT_WAIT_MS;
  for (;;) {
    if (await Bun.file(marker).exists()) return;
    if (Date.now() > deadline) throw new Error("the TUI never asked host discover after the refusal was written");
    await Bun.sleep(OUTPUT_POLL_MS);
  }
}

const EMPTY_LIST_WINDOW_MS = 8000;

test("discovery fails and the attached local session is removed: the attach ends and the TUI comes back", async () => {
  // Discovery runs with the periodic refresh, so the refresh interval is short enough to read the refusal while attached.
  scenario = await startTuiScenario({ overrides: { "tui.attach_mode": "inline", "tui.session_reconcile_secs": 1 } });
  const id = await createShellSession(scenario.daemon, "alpha");
  const marker = join(dirname(scenario.proxy.binary), "discover-refused");
  // The removal waits for a counted refusal of `host discover`, the command the TUI's refresh runs; the refresh reads the
  // failure, so the removal snapshot carries the discovery error.
  const removing = untilPrinted(scenario, id, READY)
    .then(() => untilDiscoveryRefused(marker))
    .then(() => scenario?.daemon.pohunek(["session", "rm", id]));
  const steps: PtyStep[] = [
    ...attachFirst(1),
    writeRules(scenario, [{ match: ["host", "discover"], replaceWith: ["/bin/sh", "-c", `echo refused >> ${marker}; exit 1`] }]),
    // The core ends the attach by itself after its retry window (about 20 s), so the TUI must be back well before that.
    { pause: RETURN_SETTLE_MS },
    keys("3"),
    { expect: "HOSTS", timeout: RETURN_WITHIN_MS },
    keys("2"),
    { expect: "Search /", timeout: RETURN_WITHIN_MS },
  ];
  const result = await scenario.run(steps, { timeoutS: 90 });
  await removing;
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
  expect(result.output).not.toContain(BUSY_REFUSAL);
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

/** The host route the TUI names the remote peer by behind the relay port (the same form the launch-host scenario uses). */
function remoteRoute(port: number): string {
  return `netbird:peer~${Buffer.from(REMOTE).toString("base64url")}@${String(port)}`;
}

/**
 * Rules of the remote host. During the outage the host is not listed and its session read is refused by a stand-in that
 * counts the refusal: a read that fails keeps the last records, so the session leaves the snapshot only when its host does.
 */
function remoteRules(port: number, outageMarker: string | null): ProxyRule[] {
  const discovery: ProxyRule = outageMarker === null
    ? { match: ["host", "discover"], appendOk: [{ name: REMOTE, fqdn: "remote.netbird.example", address: "127.0.0.1", port, overlay: "netbird", peer_id: REMOTE, classification: "reachable_daemon", daemon_version: "0.34.2" }] }
    : { match: ["host", "discover"], failWith: 1 };
  const refusal: ProxyRule[] = outageMarker === null ? [] : [{
    match: ["session", "inspect", remoteRoute(port)],
    replaceWith: ["/bin/sh", "-c", `echo refused >> ${outageMarker}; exit 1`],
  }];
  return [discovery, ...refusal, { match: [], aliasPrefix: { from: "netbird:", to: "local" } }];
}

/** Number of session reads of the remote host that the stand-in refused, counted by the marker file. */
async function refusalCount(marker: string): Promise<number> {
  return (await readFile(marker, "utf8").catch(() => "")).split("\n").filter((line) => line !== "").length;
}

/** Waits until the relay refused a connection: the SDK's reads of the remote host failed at the TCP boundary. */
async function untilConnectionRefused(relay: TcpRelay): Promise<void> {
  const deadline = Date.now() + OUTPUT_WAIT_MS;
  for (;;) {
    if (relay.refusedCount() > 0) return;
    if (Date.now() > deadline) throw new Error("no remote connection was refused during the outage");
    await Bun.sleep(OUTPUT_POLL_MS);
  }
}

/** Waits until the decisive read of the remote session failed, which the attach can only survive by not ending on it. */
async function untilSessionReadRefused(marker: string): Promise<void> {
  const deadline = Date.now() + OUTPUT_WAIT_MS;
  for (;;) {
    if (await refusalCount(marker) > 0) return;
    if (Date.now() > deadline) throw new Error("no read of the remote session was refused during the outage");
    await Bun.sleep(OUTPUT_POLL_MS);
  }
}

test("a remote host whose reads fail keeps its attach, and the attach ends once a read confirms the session stopped", async () => {
  // The refresh runs every second, so the session leaves the snapshot and the decisive read runs inside the outage.
  scenario = await startTuiScenario({ overrides: { "tui.attach_mode": "inline", "tui.session_reconcile_secs": 1 } });
  const id = await createShellSession(scenario.daemon, "alpha");
  const daemon = scenario.daemon;
  const proxy = scenario.proxy;
  const refusals = join(dirname(proxy.binary), "session-read-refused");
  const relay = startTcpRelay(daemonLocalSocket(daemon));
  tcp = relay;
  await proxy.setRules(remoteRules(relay.port, null));
  // The outage refuses the remote TCP connections, drops the host from discovery and refuses the CLI read of its session.
  // The attach ends only when a read after the recovery confirms the stop, so that first successful read ends it.
  const remote = untilPrinted(scenario, id, READY).then(async () => {
    relay.setFailing(true);
    await untilConnectionRefused(relay);
    await proxy.setRules(remoteRules(relay.port, refusals));
    await untilSessionReadRefused(refusals);
    await Bun.sleep(REMOTE_FAILURE_MS);
    relay.setFailing(false);
    await proxy.setRules(remoteRules(relay.port, null));
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
  // A failed trigger is rethrown after the run, so the scenario is never abandoned while its pty run is still going.
  const remoteOutcome = remote.then(() => null, (error: unknown) => ({ error }));
  const result = await scenario.run(steps, { timeoutS: 120 });
  const outcome = await remoteOutcome;
  if (outcome !== null) throw outcome.error;
  expect(relay.refusedCount(), "no remote connection was refused").toBeGreaterThan(0);
  expect(await refusalCount(refusals), "no session read of the remote host failed").toBeGreaterThan(0);
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1500)}`).toBe(-1);
}, REAL_SCENARIO_TIMEOUT_MS);
