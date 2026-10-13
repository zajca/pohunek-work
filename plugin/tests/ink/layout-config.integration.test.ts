// The TUI refuses to start when a layout value of `[tui]` is missing or not a positive integer:
// no screen falls back to a built-in size. The process runs against a real daemon's configuration
// and reports the key on stderr with the configuration exit status 2.
import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 60_000;
const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

async function startWithConfig(edit: (text: string) => string): Promise<{ exit: number; stderr: string }> {
  scenario = await startTuiScenario();
  const path = join(scenario.fixture.configDir, "config.toml");
  await writeFile(path, edit(await readFile(path, "utf8")));
  const child = Bun.spawn([Bun.which("bun") ?? "bun", MAIN, "tui"], { env: scenario.fixture.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { exit, stderr };
}

test("a missing action capture limit stops the TUI before it draws", async () => {
  const result = await startWithConfig((text) => text.replace(/^action_capture_bytes = .*\n/m, ""));
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("action_capture_bytes");
}, SCENARIO_TIMEOUT_MS);

test("a zero session reconcile interval stops the TUI before it draws", async () => {
  const result = await startWithConfig((text) => text.replace(/^session_reconcile_secs = .*$/m, "session_reconcile_secs = 0"));
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("session_reconcile_secs");
}, SCENARIO_TIMEOUT_MS);

test("a missing reconnect cap stops the TUI before it draws", async () => {
  const result = await startWithConfig((text) => text.replace(/^reconnect_max_secs = .*\n/m, ""));
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("reconnect_max_secs");
}, SCENARIO_TIMEOUT_MS);

test("a zero reconnect cap stops the TUI before it draws", async () => {
  const result = await startWithConfig((text) => text.replace(/^reconnect_max_secs = .*$/m, "reconnect_max_secs = 0"));
  expect(result.exit).toBe(2);
  expect(result.stderr).toContain("reconnect_max_secs");
}, SCENARIO_TIMEOUT_MS);
