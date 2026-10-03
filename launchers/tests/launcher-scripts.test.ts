// Behaviour of the launcher scripts against stub `pohunek`, `gh`, `linear`, `rofi`,
// `swaymsg` and terminal binaries. Scenarios that stop before a prompt is rendered need
// no real pohunek binary; the rendering scenarios are in launch-render.test.ts.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  POHUNEK_STUB,
  read,
  runScript,
  sandbox,
  scriptPath,
  waitForFileContains,
  writeConfig,
  writeExecutable,
} from "./helpers.ts";

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

  const result = await runScript("pohunek-rofi-issue", ["ui"], box, configDir, {
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

  const result = await runScript("pohunek-rofi-issue", ["ui"], box, configDir, {
    POHUNEK_TEST_LINEAR_ARGS: linearArgs,
    POHUNEK_TEST_TERMINAL_ARGS: terminalArgs,
  });

  expect(result.status, failureContext(result)).toBe(0);
  const largs = await read(linearArgs);
  expect(largs).toContain("whoami\n");
  expect(largs).toContain("--assignee\nzajca\n");
  await waitForFileContains(terminalArgs, ["pohunek-launch-issue", "ui", "AI-9"], "rofi-issue derive terminal");
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
