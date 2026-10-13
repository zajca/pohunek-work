// Regression: the launch form must not submit while the selected host's options are loading.
// A submission then creates a session on the host the form shows, and only once. The second host is a real release peer
// route that the CLI proxy aliases to the local daemon, so its slow options are the only
// synthetic condition: the proxy delays every call on that route.
import { afterEach, expect, test } from "bun:test";
import { keys, type PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 90_000;
const PEER = "delayed-peer";
const ROUTE = `netbird:peer~${Buffer.from(PEER).toString("base64url")}@18722`;
const RIGHT = "\x1b[C";
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("a submission during a host switch waits for that host's options and creates on that host", async () => {
  scenario = await startTuiScenario({
    rules: [
      { match: ["host", "list"], appendOk: [{ name: PEER, fqdn: "delayed.netbird.example", address: "100.64.0.9", port: 18722, overlay: "netbird", peer_id: PEER, classification: "reachable_daemon", daemon_version: "0.34.2" }] },
      { match: [ROUTE], delayMs: 4000 },
      { match: [], aliasPrefix: { from: "netbird:", to: "local" } },
    ],
  });
  const tabs = (count: number): PtyStep[] => Array.from({ length: count }, (): PtyStep => ({ send: "09", settle: 100 }));
  const steps: PtyStep[] = [
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "No sessions" },
    keys("n"),
    { expect: "NEW SESSION" },
    ...tabs(8),
    { expect: "Hosts: Local" },
    keys(RIGHT),
    ...tabs(8),
    keys("\r"),
    { pause: 1000 },
    { pause: 10000 },
    keys("\r"),
    { pause: 1500 },
  ];
  const result = await scenario.run(steps, { timeoutS: 40 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  const creations = (await scenario.proxy.calls()).filter((call) => call.includes("session") && call.includes("new"));
  expect(creations.map((call) => call.includes(ROUTE)), result.output.slice(-900)).toEqual([true]);
}, SCENARIO_TIMEOUT_MS);
