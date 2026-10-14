// Regression: an attach failure during a Work action's delayed list read is not replaced by that action's
// report when the read finishes. The Work list read is the stub's, delayed after the first run because the
// work sources (GitHub, Linear) are not part of the daemon; the window terminal is a stub that exits at once.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keys, type PtyStep } from "./support/pty.ts";
import { createShellSession, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const LIST_DELAY_MS = 3000;
const LAUNCH_CHECK_MS = 500;
const ENTER = "0d";
const ESCAPE = "1b";
const MOUSE_PRESS_ROW_SIX = "1b5b3c303b31303b364d";
let scenario: TuiScenario | null = null;
let directory: string | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

async function workSourceStub(dir: string): Promise<string> {
  const trace = join(dir, "trace.jsonl");
  const path = join(dir, "work-source");
  await writeFile(path, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const trace = ${JSON.stringify(trace)};
appendFileSync(trace, JSON.stringify(args) + "\\n");
const envelope = (version, payload) => console.log(JSON.stringify({cli_version:"0.5.0",protocol:{minimum:version,maximum:version},...payload}));
const runs = readFileSync(trace, "utf8").split("\\n").filter((line) => line.includes('"do"') && !line.includes("--dry-run")).length;
if (args[0] === "list") {
  // The read after the first run is still pending while the owner attaches.
  if (runs === 1) await Bun.sleep(${LIST_DELAY_MS});
  envelope(4, {ok:{items:[{key:"github-issue:acme/repo#1",project:"repo",issue:{id:"1",title:"Review this",state:"open",url:"https://github.com/acme/repo/issues/1"},pull_request:null,no_issue:false,issue_key:null,sessions:[],on_turn:{actor:"me",reason:"review",rule:1},actions:[{name:"review",delegable:true}],ignored:false,sources:{github:"ok",github_merged:"ok",linear:"unused",github_issues:"ok",pohunek:"ok"}}],orphaned_sessions:[],unlinked_sessions:[],projects:[],omitted_ignored:0}});
} else if (args[0] === "do" && args.includes("--dry-run")) envelope(1, {ok:{dry_run:true,plan:{action:"review",key:"github-issue:acme/repo#1",name:"Review this"}}});
else if (args[0] === "do") { envelope(1, {err:{class:"action",code:"confirmation_required",msg:"first attempt refused"}}); process.exit(2); }
else process.exit(70);
`);
  await chmod(path, 0o700);
  return path;
}

async function failingTerminal(dir: string): Promise<string> {
  const path = join(dir, "failing-terminal");
  await writeFile(path, "#!/bin/sh\nexit 3\n");
  await chmod(path, 0o700);
  return path;
}

test("an attach failure during a delayed Work read is not replaced by the older Work report", async () => {
  directory = await mkdtemp(join(tmpdir(), "pohunek-stale-attach-"));
  const stub = await workSourceStub(directory);
  const terminal = await failingTerminal(directory);
  scenario = await startTuiScenario({
    overrides: {
      "tui.self_bin": stub,
      "tui.list_timeout_ms": LIST_DELAY_MS * 4,
      "tui.attach_mode": "window",
      "tui.attach_command": `${terminal} {id}`,
      "tui.attach_launch_check_ms": LAUNCH_CHECK_MS,
    },
  });
  await createShellSession(scenario.daemon, "pending-read");
  const steps: PtyStep[] = [
    { expect: "WORK  1 items" },
    { pause: 500 },
    { send: MOUSE_PRESS_ROW_SIX, settle: 500 },
    { expect: "Run review" },
    { pause: 300 },
    { send: ENTER, settle: 300 },
    { expect: "PLAN PREVIEW" },
    { pause: 300 },
    { send: ESCAPE, settle: 300 },
    { expect: "Run review" },
    { pause: 300 },
    keys("r"),
    // The overlay closes before the read, so the list is drawn while that read is still pending.
    { expect: "WORK  1 items" },
    keys("2"),
    { expect: "SESSIONS  1" },
    keys("o"),
    { expect: "exited with status 3 within the launch check" },
    { pause: LIST_DELAY_MS + 1500 },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const report = result.output.lastIndexOf("first attempt refused");
  const failure = result.output.lastIndexOf("exited with status 3");
  expect(report).toBeGreaterThan(-1);
  expect(failure).toBeGreaterThan(report);
}, SCENARIO_TIMEOUT_MS);
