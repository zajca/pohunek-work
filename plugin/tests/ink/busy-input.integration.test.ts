// Input that arrives while an action runs must not vanish: the TUI refuses it on the status line. The
// work item's plan comes from a work source stub that answers the dry run after a delay, which keeps the
// TUI busy long enough for the owner's key to arrive during the action.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSY_REFUSAL } from "../../src/ink/app.tsx";
import { keys } from "./support/pty.ts";
import { startTuiScenario, type TuiScenario } from "./support/scenario.ts";

const DRY_RUN_DELAY_MS = 2500;
let scenario: TuiScenario | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
});

test("a key pressed while the dry run is busy is refused on the status line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pohunek-ink-busy-"));
  try {
    const stub = join(directory, "work-source");
    await writeFile(stub, `#!${process.execPath}
const args = process.argv.slice(2);
const envelope = (version, payload) => console.log(JSON.stringify({cli_version:"0.5.0",protocol:{minimum:version,maximum:version},...payload}));
if (args[0] === "list") envelope(4, {ok:{items:[{key:"github-issue:acme/repo#1",project:"repo",issue:{id:"1",title:"Review this",state:"open",url:"https://github.com/acme/repo/issues/1"},pull_request:null,no_issue:false,issue_key:null,sessions:[],on_turn:{actor:"me",reason:"review",rule:1},actions:[{name:"review",delegable:true}],ignored:false,sources:{github:"ok",github_merged:"ok",linear:"unused",github_issues:"ok",pohunek:"ok"}}],orphaned_sessions:[],unlinked_sessions:[],projects:[],omitted_ignored:0}});
else if (args[0] === "do" && args.includes("--dry-run")) {
  await Bun.sleep(${DRY_RUN_DELAY_MS});
  envelope(1, {ok:{dry_run:true,plan:{action:"review",key:"github-issue:acme/repo#1",name:"Review this"}}});
} else process.exit(70);
`);
    await chmod(stub, 0o700);
    scenario = await startTuiScenario({ rules: [], overrides: { "tui.self_bin": stub } });
    const result = await scenario.run([
      { expect: "CONTROL CENTER" },
      { expect: "Review this" },
      keys("\r"),
      { expect: "Run review" },
      keys("\r"),
      keys("j"),
      { expect: BUSY_REFUSAL },
      { expect: "PLAN PREVIEW" },
    ], { timeoutS: 40 });
    expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-900)}`).toBe(-1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
