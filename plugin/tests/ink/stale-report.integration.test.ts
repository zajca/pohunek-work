// Regression: a Work action's report is set only if no newer action started while its list read was
// pending. The first action's list read is delayed; a second action runs during that read and is
// refused. The second refusal must be the last status the owner sees.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keys, type PtyStep } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const SCENARIO_TIMEOUT_MS = 120_000;
const LIST_DELAY_MS = 3000;
const ENTER = "0d"; // hex, sent raw
const ESCAPE = "1b";
// Left press on column 10 of row 6, the first list row in the 120x40 frame.
const MOUSE_PRESS_ROW_SIX = "1b5b3c303b31303b364d";
let scenario: TuiScenario | null = null;
let directory: string | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

/**
 * The work source stub: one review item. The first action succeeds to the list read, which is delayed
 * by LIST_DELAY_MS; each run of the action is refused with a message that names its attempt.
 */
async function workSourceStub(dir: string): Promise<{ path: string; trace: string }> {
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
  // The first run's read is the one that is still pending when the second run starts.
  if (runs === 1) await Bun.sleep(${LIST_DELAY_MS});
  envelope(4, {ok:{items:[{key:"github-issue:acme/repo#1",project:"repo",issue:{id:"1",title:"Review this",state:"open",url:"https://github.com/acme/repo/issues/1"},pull_request:null,no_issue:false,issue_key:null,sessions:[],on_turn:{actor:"me",reason:"review",rule:1},actions:[{name:"review",delegable:true}],ignored:false,sources:{github:"ok",github_merged:"ok",linear:"unused",github_issues:"ok",pohunek:"ok"}}],orphaned_sessions:[],unlinked_sessions:[],projects:[],omitted_ignored:0}});
} else if (args[0] === "do" && args.includes("--dry-run")) envelope(1, {ok:{dry_run:true,plan:{action:"review",key:"github-issue:acme/repo#1",name:"Review this"}}});
else if (args[0] === "do") { envelope(1, {err:{class:"action",code:"confirmation_required",msg:runs === 1 ? "first attempt refused" : "second attempt refused"}}); process.exit(2); }
else process.exit(70);
`);
  await chmod(path, 0o700);
  return { path, trace };
}

test("the last status is the newest action's, not a delayed earlier report", async () => {
  directory = await mkdtemp(join(tmpdir(), "pohunek-ink-stale-"));
  const stub = await workSourceStub(directory);
  scenario = await startTuiScenario({ overrides: { "tui.self_bin": stub.path, "tui.list_timeout_ms": 5000 } });
  // A double click opens the first row's detail; each run is previewed first, as the owner runs it.
  const steps: PtyStep[] = [
    { expect: "WORK  1 items" },
    { pause: 500 },
    // A press opens nothing on its own: the second press on the row, within the fixture's double_click_ms, opens it.
    { send: MOUSE_PRESS_ROW_SIX, settle: 100 },
    { send: MOUSE_PRESS_ROW_SIX, settle: 500 },
    { expect: "Run review" },
    { pause: 300 },
    { send: ENTER },
    { expect: "PLAN PREVIEW" },
    { pause: 300 },
    { send: ESCAPE },
    { expect: "Run review" },
    { pause: 300 },
    keys("r"),
    // The run's overlay closes before its list read, so the list is drawn while that read is still pending.
    { expect: "WORK  1 items" },
    { send: ENTER },
    { expect: "Run review" },
    { pause: 300 },
    { send: ENTER },
    { expect: "PLAN PREVIEW" },
    { pause: 300 },
    { send: ESCAPE },
    { expect: "Run review" },
    { pause: 300 },
    keys("r"),
    { expect: "second attempt refused" },
    // Long enough for the first run's delayed list read to complete after the second report.
    { pause: LIST_DELAY_MS + 1500 },
    keys("q"),
  ];
  const result = await scenario.run(steps, { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  const lastFirst = result.output.lastIndexOf("first attempt refused");
  const lastSecond = result.output.lastIndexOf("second attempt refused");
  expect(lastSecond).toBeGreaterThan(lastFirst);
  expect(result.output.slice(lastSecond)).not.toContain("first attempt refused");
}, SCENARIO_TIMEOUT_MS);
