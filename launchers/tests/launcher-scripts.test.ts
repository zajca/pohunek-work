// Behaviour of the launcher scripts against stub `pohunek`, `gh`, `linear`, `rofi`,
// `swaymsg` and terminal binaries. Scenarios that stop before a prompt is rendered need
// no real pohunek binary; the rendering scenarios are in launch-render.test.ts.
import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  POHUNEK_STUB,
  read,
  removeSandboxes,
  runScript,
  sandbox,
  scriptPath,
  waitForFileContains,
  writeConfig,
  writeExecutable,
} from "./helpers.ts";

afterEach(removeSandboxes);

function failureContext(result: { stdout: string; stderr: string }): string {
  return `stdout=${result.stdout} stderr=${result.stderr}`;
}

test("launch scripts do not embed python3 in their branch and link path", async () => {
  for (const script of ["pohunek-launch-issue", "pohunek-launch-pr"]) {
    expect(await readFile(scriptPath(script), "utf8"), `${script} must not embed python3`).not.toContain("python3");
  }
});

test("launch-issue aborts without a session when the daemon cannot resolve the prompt", async () => {
  const box = await sandbox("launch-abort");
  const pohunek = join(box.bin, "pohunek");
  const linear = join(box.bin, "linear-wrapper");
  const pohunekArgs = join(box.root, "pohunek.args");
  await writeExecutable(
    linear,
    `#!/bin/sh
printf '{"id":"LIN-1","title":"T","description":"B","branchName":"lin-1","url":"u"}\\n'
`,
  );
  await writeExecutable(pohunek, POHUNEK_STUB);
  const configDir = await writeConfig(box.root, [
    ["pohunek_bin", pohunek],
    ["linear_cli", linear],
    ["host", "local"],
  ]);

  const result = await runScript("pohunek-launch-issue", ["ui", "LIN-1"], box, configDir, {
    POHUNEK_TEST_POHUNEK_ARGS: pohunekArgs,
    POHUNEK_TEST_RECIPE_FAIL: "1",
  });

  expect(result.status).not.toBe(0);
  const args = await read(pohunekArgs);
  expect(args).toContain("project\naction\n");
  expect(args).not.toContain("session\nnew\n");
});

test("launch-issue rejects an action with a non-linear provider before fetching the issue", async () => {
  const box = await sandbox("launch-issue-provider-mismatch");
  const pohunek = join(box.bin, "pohunek");
  const linear = join(box.bin, "linear-wrapper");
  const linearArgs = join(box.root, "linear.args");
  const pohunekArgs = join(box.root, "pohunek.args");
  await writeExecutable(
    linear,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_LINEAR_ARGS"; done
printf '{"id":"LIN-1","title":"T","description":"B","branchName":"lin-1","url":"u"}\\n'
`,
  );
  await writeExecutable(pohunek, POHUNEK_STUB);
  const configDir = await writeConfig(box.root, [
    ["pohunek_bin", pohunek],
    ["linear_cli", linear],
    ["host", "local"],
  ]);
  const recipe = '{"provider":"github_pr","agent":"codex","prompt_name":"issue","prompt_content":"Issue ${id}\\n"}';

  const result = await runScript("pohunek-launch-issue", ["ui", "LIN-1"], box, configDir, {
    POHUNEK_TEST_LINEAR_ARGS: linearArgs,
    POHUNEK_TEST_POHUNEK_ARGS: pohunekArgs,
    POHUNEK_TEST_RECIPE_JSON: recipe,
  });

  expect(result.status).not.toBe(0);
  const args = await read(pohunekArgs);
  expect(args).toContain("project\naction\nui\nprocess-issue\n--json\n");
  expect(args).not.toContain("session\nnew\n");
  expect(await read(linearArgs)).toBe("");
});

test("launch-pr rejects a provider=none recipe with a static branch before fetching the PR", async () => {
  const box = await sandbox("launch-pr-provider-none");
  const pohunek = join(box.bin, "pohunek");
  const gh = join(box.bin, "gh");
  const ghArgs = join(box.root, "gh.args");
  const pohunekArgs = join(box.root, "pohunek.args");
  await writeExecutable(
    gh,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_GH_ARGS"; done
printf '{"title":"T","body":"B","headRefName":"feat/x","url":"u"}\\n'
`,
  );
  await writeExecutable(pohunek, POHUNEK_STUB);
  const configDir = await writeConfig(box.root, [
    ["pohunek_bin", pohunek],
    ["gh_bin", gh],
    ["host", "local"],
  ]);
  const recipe = '{"provider":"none","agent":"claude","branch":"feature/static","prompt_name":"pr","prompt_content":"PR ${number}\\n"}';

  const result = await runScript("pohunek-launch-pr", ["ui", "7"], box, configDir, {
    POHUNEK_TEST_GH_ARGS: ghArgs,
    POHUNEK_TEST_POHUNEK_ARGS: pohunekArgs,
    POHUNEK_TEST_RECIPE_JSON: recipe,
  });

  expect(result.status).not.toBe(0);
  const args = await read(pohunekArgs);
  expect(args).toContain("project\naction\nui\nprocess-pr\n--json\n");
  expect(args).not.toContain("session\nnew\n");
  expect(await read(ghArgs)).toBe("");
});

test("rofi-issue lists my issues and hands the selection to launch-issue", async () => {
  const box = await sandbox("rofi-issue");
  const linear = join(box.bin, "linear-wrapper");
  const rofi = join(box.bin, "rofi");
  const terminal = join(box.bin, "terminal");
  const linearArgs = join(box.root, "linear.args");
  const rofiStdin = join(box.root, "rofi.stdin");
  const terminalArgs = join(box.root, "terminal.args");

  // The second title carries a JSON-escaped tab: the picker must flatten it rather
  // than let it forge an extra rofi column.
  await writeExecutable(
    linear,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_LINEAR_ARGS"; done
if [ "$1" = "issue" ] && [ "$2" = "query" ]; then
  printf '[{"identifier":"AI-1","title":"First issue","state":{"name":"Todo"}},{"identifier":"AI-2","title":"Second\\\\ttab","state":{"name":"In Progress"}}]\\n'
fi
`,
  );
  await writeExecutable(
    rofi,
    `#!/bin/sh
cat >"$POHUNEK_TEST_ROFI_STDIN"
head -n 1 "$POHUNEK_TEST_ROFI_STDIN"
`,
  );
  await writeExecutable(
    terminal,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_TERMINAL_ARGS"; done
`,
  );
  const configDir = await writeConfig(box.root, [
    ["linear_cli", linear],
    ["rofi_bin", rofi],
    ["terminal", terminal],
    ["linear_assignee", "zajca"],
    ["host", "local"],
  ]);

  const result = await runScript("pohunek-rofi-issue", ["ui", "linear"], box, configDir, {
    POHUNEK_TEST_LINEAR_ARGS: linearArgs,
    POHUNEK_TEST_ROFI_STDIN: rofiStdin,
    POHUNEK_TEST_TERMINAL_ARGS: terminalArgs,
    LINEAR_API_KEY: "lin_secret_should_not_leak",
  });

  expect(result.status, failureContext(result)).toBe(0);
  const largs = await read(linearArgs);
  expect(largs).toContain("query\n");
  expect(largs).toContain("--all-teams\n");
  expect(largs).toContain("--assignee\nzajca\n");
  expect(largs).toContain("--state\nstarted\n");
  expect(largs).toContain("--state\nunstarted\n");

  // Rows are "identifier<TAB>state<TAB>title"; the tab inside the second title is flattened.
  const rows = await read(rofiStdin);
  expect(rows).toContain("AI-1\tTodo\tFirst issue");
  expect(rows).toContain("AI-2\tIn Progress\tSecond tab");

  // The launch runs in the background inside a terminal, so poll for the spawned args.
  await waitForFileContains(terminalArgs, ["pohunek-launch-issue", "ui", "AI-1"], "rofi-issue terminal");
  expect(await read(terminalArgs)).not.toContain("lin_secret_should_not_leak");
});

test("rofi-issue derives the assignee from whoami when none is configured", async () => {
  const box = await sandbox("rofi-issue-derive");
  const linear = join(box.bin, "linear-wrapper");
  const rofi = join(box.bin, "rofi");
  const terminal = join(box.bin, "terminal");
  const linearArgs = join(box.root, "linear.args");
  const terminalArgs = join(box.root, "terminal.args");

  // `auth whoami` has no --json mode; the display name comes from its labelled output.
  await writeExecutable(
    linear,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_LINEAR_ARGS"; done
if [ "$1" = "auth" ] && [ "$2" = "whoami" ]; then
  printf 'Workspace: Keboola\\n  Display name: zajca\\n  Email: x@example.test\\n'
  exit 0
fi
if [ "$1" = "issue" ] && [ "$2" = "query" ]; then
  printf '[{"identifier":"AI-9","title":"Derived"}]\\n'
fi
`,
  );
  await writeExecutable(
    rofi,
    `#!/bin/sh
cat >/dev/null
printf 'AI-9\\tDerived\\n'
`,
  );
  await writeExecutable(
    terminal,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_TERMINAL_ARGS"; done
`,
  );
  const configDir = await writeConfig(box.root, [
    ["linear_cli", linear],
    ["rofi_bin", rofi],
    ["terminal", terminal],
    ["host", "local"],
  ]);

  const result = await runScript("pohunek-rofi-issue", ["ui", "linear"], box, configDir, {
    POHUNEK_TEST_LINEAR_ARGS: linearArgs,
    POHUNEK_TEST_TERMINAL_ARGS: terminalArgs,
  });

  expect(result.status, failureContext(result)).toBe(0);
  const largs = await read(linearArgs);
  expect(largs).toContain("whoami\n");
  expect(largs).toContain("--assignee\nzajca\n");
  await waitForFileContains(terminalArgs, ["pohunek-launch-issue", "ui", "AI-9"], "rofi-issue derive terminal");
});

test("rofi-issue requires a known issue source and never defaults one", async () => {
  const box = await sandbox("rofi-issue-source");
  const configDir = await writeConfig(box.root, [["host", "local"]]);
  const cases: [readonly string[], string][] = [
    [["ui"], "usage: pohunek-rofi-issue <project> <linear|github> [action]"],
    [["ui", "jira"], "unknown issue source 'jira'"],
    [["ui", "github", "babysit"], "only starts the 'implement' action"],
    [["ui", "linear", "a", "b"], "usage: pohunek-rofi-issue"],
  ];
  for (const [args, message] of cases) {
    const result = await runScript("pohunek-rofi-issue", args, box, configDir);
    expect(result.status, failureContext(result)).not.toBe(0);
    expect(result.stderr).toContain(message);
  }
});

const GITHUB_KEY = "github-issue:keboola/connection#42";

/** Envelope of `pohunek-work list --json` (contract 4) with the given rows. */
function listEnvelope(items: readonly object[], protocol = { minimum: 4, maximum: 4 }): string {
  return JSON.stringify({ cli_version: "0.3.0", protocol, ok: { items, orphaned_sessions: [], unlinked_sessions: [], projects: [] } });
}

function issueRow(key: string, title: string, actions: readonly string[], state = "open"): object {
  return {
    key,
    project: "ui",
    issue: { id: key, title, state, url: "https://example.test/x" },
    pull_request: null,
    actions: actions.map((name) => ({ name, delegable: true })),
  };
}

interface GithubPicker {
  readonly box: Awaited<ReturnType<typeof sandbox>>;
  readonly configDir: string;
  readonly env: Record<string, string>;
  readonly rofiStdin: string;
  readonly terminalArgs: string;
  readonly workArgs: string;
}

/** Stubs `pohunek-work`, rofi and the terminal; rofi selects `selection` (default: the first row). */
async function githubPicker(tag: string, listJson: string, listStatus = 0, selection = ""): Promise<GithubPicker> {
  const box = await sandbox(tag);
  const work = join(box.bin, "pohunek-work");
  const rofi = join(box.bin, "rofi");
  const terminal = join(box.bin, "terminal");
  const listFile = join(box.root, "list.json");
  const rofiStdin = join(box.root, "rofi.stdin");
  const terminalArgs = join(box.root, "terminal.args");
  const workArgs = join(box.root, "work.args");
  await Bun.write(listFile, listJson);
  await writeExecutable(
    work,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_WORK_ARGS"; done
cat "$POHUNEK_TEST_LIST_FILE"
exit "$POHUNEK_TEST_LIST_STATUS"
`,
  );
  await writeExecutable(
    rofi,
    `#!/bin/sh
cat >"$POHUNEK_TEST_ROFI_STDIN"
if [ -n "$POHUNEK_TEST_SELECTION" ]; then printf '%s\\n' "$POHUNEK_TEST_SELECTION"; else head -n 1 "$POHUNEK_TEST_ROFI_STDIN"; fi
`,
  );
  await writeExecutable(
    terminal,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_TERMINAL_ARGS"; done
`,
  );
  // No linear_cli: the GitHub path must not need it.
  const configDir = await writeConfig(box.root, [
    ["pohunek_work_bin", work],
    ["rofi_bin", rofi],
    ["terminal", terminal],
    ["host", "local"],
  ]);
  const env = {
    POHUNEK_TEST_LIST_FILE: listFile,
    POHUNEK_TEST_LIST_STATUS: String(listStatus),
    POHUNEK_TEST_ROFI_STDIN: rofiStdin,
    POHUNEK_TEST_TERMINAL_ARGS: terminalArgs,
    POHUNEK_TEST_WORK_ARGS: workArgs,
    POHUNEK_TEST_SELECTION: selection,
  };
  return { box, configDir, env, rofiStdin, terminalArgs, workArgs };
}

test("rofi-issue github lists the rows that offer implement and runs `do <key> implement` in the terminal", async () => {
  const listJson = listEnvelope([
    issueRow(GITHUB_KEY, "Fix the\ttab\nbug", ["implement", "babysit"], "In progress"),
    issueRow("github-issue:keboola/connection#43", "Already running", ["attach"]),
    issueRow("linear:AI-1", "Linear row", ["implement"]),
    issueRow("github:keboola/connection#9", "A pull request", ["implement"]),
    issueRow("github-issue:keboola/connection#44; rm -rf ~", "Hostile key", ["implement"]),
    issueRow("github-issue:keboola/$(touch x)#45", "Hostile owner", ["implement"]),
  ]);
  const picker = await githubPicker("rofi-gh", listJson);

  const result = await runScript("pohunek-rofi-issue", ["ui", "github"], picker.box, picker.configDir, picker.env);

  expect(result.status, failureContext(result)).toBe(0);
  expect(await read(picker.workArgs)).toBe("list\n--json\n--project\nui\n");
  // One row: key, state and title with the tab and newline flattened; every other row is dropped.
  expect(await read(picker.rofiStdin)).toBe(`${GITHUB_KEY}\tIn progress\tFix the tab bug\n`);
  await waitForFileContains(picker.terminalArgs, ["pohunek-work\ndo\n" + GITHUB_KEY + "\nimplement\n--project\nui\n"], "github rofi-issue terminal");
  // `do` confirms on the terminal itself: no --yes.
  expect(await read(picker.terminalArgs)).not.toContain("--yes");
});

test("rofi-issue github starts nothing when no row offers implement", async () => {
  const picker = await githubPicker("rofi-gh-none", listEnvelope([issueRow(GITHUB_KEY, "Running", ["attach"])]));
  const result = await runScript("pohunek-rofi-issue", ["ui", "github"], picker.box, picker.configDir, picker.env);
  expect(result.status, failureContext(result)).toBe(0);
  expect(await read(picker.rofiStdin)).toBe("");
  expect(await read(picker.terminalArgs)).toBe("");
});

test("rofi-issue github refuses a hand-typed selection that is not a github-issue key", async () => {
  const picker = await githubPicker("rofi-gh-typed", listEnvelope([issueRow(GITHUB_KEY, "T", ["implement"])]), 0, "github-issue:o/r#1; touch pwned");
  const result = await runScript("pohunek-rofi-issue", ["ui", "github"], picker.box, picker.configDir, picker.env);
  expect(result.status, failureContext(result)).not.toBe(0);
  expect(result.stderr).toContain("invalid issue key");
  expect(await read(picker.terminalArgs)).toBe("");
});

test("rofi-issue github refuses a multi-line selection whose first line is a valid key", async () => {
  const picker = await githubPicker("rofi-gh-multiline", listEnvelope([issueRow(GITHUB_KEY, "T", ["implement"])]), 0, `${GITHUB_KEY}\njunk`);
  const result = await runScript("pohunek-rofi-issue", ["ui", "github"], picker.box, picker.configDir, picker.env);
  expect(result.status, failureContext(result)).not.toBe(0);
  expect(result.stderr).toContain("more than one line");
  expect(await read(picker.terminalArgs)).toBe("");
});

test("rofi-issue linear refuses a multi-line selection whose first line is a valid id", async () => {
  const box = await sandbox("rofi-issue-linear-multiline");
  const linear = join(box.bin, "linear-wrapper");
  const rofi = join(box.bin, "rofi");
  const terminal = join(box.bin, "terminal");
  const terminalArgs = join(box.root, "terminal.args");
  await writeExecutable(linear, `#!/bin/sh\nprintf '[{"identifier":"AI-1","title":"T","state":{"name":"Todo"}}]\\n'\n`);
  await writeExecutable(rofi, `#!/bin/sh\ncat >/dev/null\nprintf 'AI-1\\njunk\\n'\n`);
  await writeExecutable(terminal, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_TERMINAL_ARGS"; done\n`);
  const configDir = await writeConfig(box.root, [
    ["linear_cli", linear],
    ["rofi_bin", rofi],
    ["terminal", terminal],
    ["linear_assignee", "zajca"],
    ["host", "local"],
  ]);
  const result = await runScript("pohunek-rofi-issue", ["ui", "linear"], box, configDir, { POHUNEK_TEST_TERMINAL_ARGS: terminalArgs });
  expect(result.status, failureContext(result)).not.toBe(0);
  expect(result.stderr).toContain("more than one line");
  expect(await read(terminalArgs)).toBe("");
});

test("rofi-issue github fails clearly on an unusable list envelope", async () => {
  // The error envelope has the shape of `reportError` in plugin/src/cli-errors.ts: `err` is `{class, code, msg}`.
  const cases: [string, string, number, string][] = [
    ["error envelope", JSON.stringify({ cli_version: "x", protocol: { minimum: 4, maximum: 4 }, err: { class: "configuration", code: "config_invalid", msg: "bad config" } }), 2, "reported an error: bad config"],
    ["unsupported contract", listEnvelope([], { minimum: 5, maximum: 5 }), 0, "does not include supported version 4"],
    ["previous contract", listEnvelope([], { minimum: 3, maximum: 3 }), 0, "does not include supported version 4"],
    ["not json", "not json", 0, "not valid JSON"],
    ["no items", JSON.stringify({ protocol: { minimum: 4, maximum: 4 }, ok: {} }), 0, "no ok.items list"],
    ["failed list", listEnvelope([issueRow(GITHUB_KEY, "T", ["implement"])]), 2, "failed with exit status 2"],
  ];
  for (const [label, json, status, message] of cases) {
    const picker = await githubPicker(`rofi-gh-bad-${label.replaceAll(" ", "-")}`, json, status);
    const result = await runScript("pohunek-rofi-issue", ["ui", "github"], picker.box, picker.configDir, picker.env);
    expect(result.status, `${label}: ${failureContext(result)}`).not.toBe(0);
    expect(result.stderr, label).toContain(message);
    expect(await read(picker.rofiStdin), label).toBe("");
    expect(await read(picker.terminalArgs), label).toBe("");
  }
});

test("rofi-issue github accepts a partial list (exit 3) and still shows its rows", async () => {
  const picker = await githubPicker("rofi-gh-partial", listEnvelope([issueRow(GITHUB_KEY, "T", ["implement"])]), 3);
  const result = await runScript("pohunek-rofi-issue", ["ui", "github"], picker.box, picker.configDir, picker.env);
  expect(result.status, failureContext(result)).toBe(0);
  expect(await read(picker.rofiStdin)).toBe(`${GITHUB_KEY}\topen\tT\n`);
});

test("rofi-issue github needs pohunek_work_bin and linear needs no pohunek_work_bin", async () => {
  const box = await sandbox("rofi-issue-keys");
  const rofi = join(box.bin, "rofi");
  await writeExecutable(rofi, "#!/bin/sh\ncat >/dev/null\nexit 1\n");
  const noWork = await writeConfig(box.root, [
    ["rofi_bin", rofi],
    ["terminal", "unused-terminal"],
  ]);
  const github = await runScript("pohunek-rofi-issue", ["ui", "github"], box, noWork);
  expect(github.status).not.toBe(0);
  expect(github.stderr).toContain("missing required config key 'pohunek_work_bin'");

  // The Linear path asks for linear_cli, never for pohunek_work_bin.
  const linear = await runScript("pohunek-rofi-issue", ["ui", "linear"], box, noWork);
  expect(linear.status).not.toBe(0);
  expect(linear.stderr).toContain("missing required config key 'linear_cli'");
  expect(linear.stderr).not.toContain("pohunek_work_bin");
});

test("rofi merges local and remote hosts, multi-selects and reconciles marks", async () => {
  const box = await sandbox("rofi");
  const pohunek = join(box.bin, "pohunek");
  const rofi = join(box.bin, "rofi");
  const swaymsg = join(box.bin, "swaymsg");
  const terminal = join(box.bin, "terminal");
  const calls = join(box.root, "calls.log");
  const rofiStdin = join(box.root, "rofi.stdin");
  const terminalArgs = join(box.root, "terminal.args");

  // `host discover` lists NetBird peers only (box, down), never the local daemon: the
  // switcher must add `local` itself.
  await writeExecutable(
    pohunek,
    `#!/bin/sh
printf 'pohunek' >>"$POHUNEK_TEST_CALLS"
for arg in "$@"; do printf ' %s' "$arg" >>"$POHUNEK_TEST_CALLS"; done
printf '\\n' >>"$POHUNEK_TEST_CALLS"
if [ "$1" = "host" ] && [ "$2" = "discover" ]; then
  printf '[{"name":"box","classification":"reachable_daemon"},{"name":"down","classification":"reachable_daemon"}]\\n'
  exit 0
fi
if [ "$1" = "--host" ] && [ "$3" = "session" ] && [ "$4" = "list" ]; then
  case "$2" in
    # project_label carries a JSON newline escape: the switcher must collapse it to a
    # space so the row stays one tab-safe line and no fragment leaks as a target.
    local) printf '%s\\n' '[{"id":"s-1","agent":"claude","state":"running","activity":"blocked","project_id":"p-ui","project_label":"ui\\nevil","branch":"feat/x"}]' ;;
    box) printf '[{"id":"s-2","agent":"codex","state":"running","activity":"working"}]\\n' ;;
    down) printf 'host down\\n' >&2; exit 9 ;;
    *) printf '[]\\n' ;;
  esac
  exit 0
fi
exit 1
`,
  );
  // Multi-select: echo every offered row; the error row is dropped by the target extraction.
  await writeExecutable(
    rofi,
    `#!/bin/sh
cat >"$POHUNEK_TEST_ROFI_STDIN"
cat "$POHUNEK_TEST_ROFI_STDIN"
`,
  );
  await writeExecutable(
    swaymsg,
    `#!/bin/sh
printf 'swaymsg' >>"$POHUNEK_TEST_CALLS"
for arg in "$@"; do printf ' %s' "$arg" >>"$POHUNEK_TEST_CALLS"; done
printf '\\n' >>"$POHUNEK_TEST_CALLS"
if [ "$1" = "-t" ] && [ "$2" = "get_tree" ]; then
  printf '{"nodes":[{"marks":["pohunek:box/s-old"],"nodes":[],"floating_nodes":[]}],"floating_nodes":[]}\\n'
fi
`,
  );
  await writeExecutable(
    terminal,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_TERMINAL_ARGS"; done
`,
  );
  const configDir = await writeConfig(box.root, [
    ["pohunek_bin", pohunek],
    ["rofi_bin", rofi],
    ["swaymsg_bin", swaymsg],
    ["terminal", terminal],
    // Generous so the stub `session list` is never killed by the per-host deadline
    // under load, which would turn a host into an error row.
    ["list_timeout_seconds", "30"],
    // The stub get_tree never shows new marks, so one fast attempt keeps the test short
    // while still issuing the `mark --add` call.
    ["mark_retry_count", "1"],
    ["mark_retry_interval_seconds", "0"],
  ]);

  const result = await runScript("pohunek-rofi", ["--filter", "state=running"], box, configDir, {
    POHUNEK_TEST_CALLS: calls,
    POHUNEK_TEST_ROFI_STDIN: rofiStdin,
    POHUNEK_TEST_TERMINAL_ARGS: terminalArgs,
  });

  expect(result.status, failureContext(result)).toBe(0);
  // Both selections come back, local first; the newline in local's project label did not
  // split its row into a second line whose fragment would leak as an extra target.
  expect(result.stdout).toBe("local/s-1\nbox/s-2\n");
  const rows = await read(rofiStdin);
  expect(rows).toContain("local/s-1\tui evil\tfeat/x\tclaude\trunning\tblocked");
  expect(rows.split("\n").some((line) => line.startsWith("evil"))).toBe(false);
  // Columns: host/session, project, branch, agent, state, activity; a missing project and branch show `-`.
  expect(rows).toContain("box/s-2\t-\t-\tcodex\trunning\tworking");
  expect(rows).toContain("!down\tERROR\t");
  // The per-host `session list` lines interleave (concurrent appends), so only the
  // sequential swaymsg calls are asserted.
  const callsText = await read(calls);
  // A deselected window is closed; closing detaches, never stops.
  expect(callsText).toContain('[con_mark="pohunek:box/s-old"] kill');
  expect(callsText).not.toContain("pohunek-banner:");
  await waitForFileContains(terminalArgs, ["local/s-1", "box/s-2"], "terminal args");
  expect(await read(terminalArgs)).not.toContain("pohunek-session-banner");
});
