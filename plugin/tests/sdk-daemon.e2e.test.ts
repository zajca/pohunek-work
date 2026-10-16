// The plugin's SDK dependency is the pinned release's TypeScript SDK: a client from the package
// connects to the real daemon's socket and reads its health. This is the connection the TUI's
// session adapter uses, so a broken pin or an incompatible tarball fails here, not in the TUI.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { connectLocal, type Client } from "@pohunek/sdk";
import { DAEMON_STOP_HOOK_TIMEOUT_MS, startCoreDaemon, type CoreDaemon } from "./helpers/core-daemon.ts";

const SCENARIO_TIMEOUT_MS = 60_000;
let daemon: CoreDaemon | null = null;
let client: Client | null = null;

afterEach(async () => {
  await client?.close();
  client = null;
  await daemon?.stop();
  daemon = null;
}, DAEMON_STOP_HOOK_TIMEOUT_MS);

test("the SDK from the pinned release reads the health of the real daemon", async () => {
  daemon = await startCoreDaemon();
  client = await connectLocal(join(daemon.runtimeDir, "pohunek", "daemon.sock"));
  const health = await client.call("daemon.health", null);
  expect(health.status).toBe("ok");
}, SCENARIO_TIMEOUT_MS);
