// `g` opens the session's branch on GitHub. The URL comes from the project's GitHub origin, which the daemon's
// test repositories set to git@github.com:acme/widgets.git; the open command is a stub that records its argument.
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keys } from "./support/pty.ts";
import { PROJECT, REAL_SCENARIO_TIMEOUT_MS, startTuiScenario, type TuiScenario } from "./support/scenario.ts";

let scenario: TuiScenario | null = null;
let directory: string | null = null;

afterEach(async () => {
  await scenario?.stop();
  scenario = null;
  if (directory !== null) await rm(directory, { recursive: true, force: true });
  directory = null;
});

test("g opens the branch page on the project's GitHub origin", async () => {
  directory = await mkdtemp(join(tmpdir(), "pw-open-"));
  const command = join(directory, "open-stub");
  const trace = join(directory, "open-trace.txt");
  await writeFile(command, `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(trace)}, process.argv.slice(2).join(" ") + "\\n");
`);
  await chmod(command, 0o700);
  scenario = await startTuiScenario({ overrides: { "tui.open_command": command } });
  const created = await scenario.daemon.pohunek(["session", "new", "--agent", "shell", "--project", PROJECT, "--branch", "feature/owner-check", "--name", "branchy", "--json"]);
  if (!created.stdout.includes('"ok"')) throw new Error(`session new failed: ${created.stdout}${created.stderr}`);
  const result = await scenario.run([
    { expect: "CONTROL CENTER" },
    keys("2"),
    { expect: "branchy" },
    keys("g"),
    { expect: "Opened github.com" },
    keys("q"),
  ], { timeoutS: 60 });
  expect(result.failed, `step ${String(result.failed)} failed; output:\n${result.output.slice(-1200)}`).toBe(-1);
  expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual(["https://github.com/acme/widgets/tree/feature/owner-check"]);
}, REAL_SCENARIO_TIMEOUT_MS);
