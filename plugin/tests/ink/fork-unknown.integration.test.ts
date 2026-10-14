// A fork whose reply does not arrive in time has an unknown outcome: the fork may exist. The TUI must say so,
// refresh the list, and refuse another fork until the owner has reviewed the list. The session reads and the
// fork go through the SDK stand-in, whose fault stalls the first fork reply; the CLI stub answers the reads.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keys } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";
import { startSdkStandIn, type SdkStandIn } from "../helpers/sdk-stand-in.ts";

let scenario: TuiScenario | null = null;
let standIn: SdkStandIn | null = null;
let directory: string | null = null;

afterEach(async () => {
  await standIn?.stop();
  standIn = null;
  await scenario?.stop();
  scenario = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

const session = {
  id: "s1", name: "Fork source", agent: "claude", cwd: "/repo", state: "running", activity: "working",
  updated_at: "2026-10-09T10:00:00Z", project_id: "p1", project_label: "repo", branch: "fix",
  worktree_path: "/repo/fix", capabilities: { resume: true, fork: true }, metadata: {},
  subagents: [],
};
const project = { id: "p1", label: "repo", repo_root: "/repo", git_common_dir: "/repo/.git" };

test("a fork that does not answer is reported as unknown and another fork waits for a review of the list", async () => {
  directory = await mkdtemp(join(tmpdir(), "pohunek-ink-fork-"));
  const stub = join(directory, "pohunek");
  await writeFile(stub, `#!${process.execPath}
const args = process.argv.slice(2);
const joined = args.join(" ");
const ok = (value) => console.log(JSON.stringify({cli_version:"0.33.1",protocol:{minimum:4,maximum:4},ok:value}));
if (joined === "host discover --json") ok([]);
else if (joined === "--host local session list --json") ok([${JSON.stringify(session)}]);
else if (joined === "--host local project list --json") ok([${JSON.stringify(project)}]);
else if (joined === "--host local session inspect s1 --json") ok(${JSON.stringify(session)});
else if (args.includes("notification")) ok({notifications: [], next_cursor: null});
else if (joined === "--host local session fork s1 --json") ok(${JSON.stringify({ ...session, id: "s2", name: "Fork source fork" })});
else process.exit(70);
`);
  await chmod(stub, 0o700);
  standIn = await startSdkStandIn(stub, { faults: [{ method: "session.fork", kind: "stall", times: 1 }] });
  // The CLI the TUI runs is the stub too, so both its reads and the SDK's reads describe the same session.
  scenario = await startTuiScenario({ rules: [], overrides: { "pohunek.timeout_ms": 1000, "pohunek.bin": stub, "tui.reconnect_max_secs": 2 } });
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("2"),
    // Narrow terminal: the list opens the session in its overlay, where fork is offered.
    keys("\r"),
    { expect: "Status  " },
    keys("f"),
    { expect: "Confirm fork of Fork source" },
    keys("y"),
    { expect: "fork outcome is unknown" },
    // The owner is taken to the list; the link reconnects, then the session is opened again for another fork.
    { pause: 3000 },
    keys("\r"),
    { expect: "Status  " },
    keys("f"),
    { expect: "Confirm fork of Fork source" },
    keys("y"),
    { expect: "may exist; press r" },
  ], { cols: 100, timeoutS: 40, env: { POHUNEK_SOCKET_PATH: standIn.socket } });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-2000)}`).toBe(-1);
}, 90_000);
