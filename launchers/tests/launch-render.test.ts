// Launch scripts end to end through the real prompt renderer: `pohunek prompt render` and
// `pohunek prompt link` come from the pohunek binary named by POHUNEK_TEST_BIN, the rest
// of pohunek, `gh` and `linear` are stubs.
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertMetaArgs,
  pohunekBin,
  POHUNEK_STUB,
  read,
  runScript,
  sandbox,
  writeConfig,
  writeExecutable,
} from "./helpers.ts";

function failureContext(result: { stdout: string; stderr: string }): string {
  return `stdout=${result.stdout} stderr=${result.stderr}`;
}

test("launch-pr resolves the action from the daemon and starts one session without token leak", async () => {
  const box = await sandbox("launch-pr");
  const pohunek = join(box.bin, "pohunek");
  const gh = join(box.bin, "gh");
  const pohunekArgs = join(box.root, "pohunek.args");
  const ghArgs = join(box.root, "gh.args");

  await writeExecutable(
    gh,
    `#!/bin/sh
for arg in "$@"; do printf '%s\\n' "$arg" >>"$POHUNEK_TEST_GH_ARGS"; done
printf '{"title":"Fix filters","body":"Body text","headRefName":"feature/filters","url":"https://example.test/pr/7"}\\n'
`,
  );
  await writeExecutable(pohunek, POHUNEK_STUB);
  const configDir = await writeConfig(box.root, [
    ["pohunek_bin", pohunek],
    ["gh_bin", gh],
    ["host", "local"],
    ["yes", "true"],
  ]);
  const recipe =
    '{"provider":"github_pr","agent":"claude","prompt_name":"pr","prompt_content":"PR ${number}: ${title}\\n${body}\\nbranch=${branch}\\nurl=${url}\\n"}';

  const result = await runScript("pohunek-launch-pr", ["ui", "7", "review-pr"], box, configDir, {
    POHUNEK_TEST_REAL_POHUNEK: pohunekBin(),
    POHUNEK_TEST_GH_ARGS: ghArgs,
    POHUNEK_TEST_POHUNEK_ARGS: pohunekArgs,
    POHUNEK_TEST_RECIPE_JSON: recipe,
    GITHUB_TOKEN: "ghp_secret_should_not_leak",
  });

  expect(result.status, failureContext(result)).toBe(0);
  const args = await read(pohunekArgs);
  expect(args).toContain("project\naction\nui\nreview-pr\n--json\n");
  expect(args).toContain("prompt\nrender\n");
  expect(args).toContain("prompt\nlink\n");
  expect(args).toContain("--provider\ngithub_pr\n");
  expect(args).toContain("--item-id\n7\n");
  expect(args).toContain("--host\nlocal\nsession\nnew\n");
  expect(args).toContain("--agent\nclaude\n");
  expect(args).toContain("--project\nui\n");
  expect(args).not.toContain("--repo");
  expect(args).toContain("--branch\nfeature/filters\n");
  assertMetaArgs(args, [
    ["link.branch", "feature/filters"],
    ["link.id", "7"],
    ["link.kind", "pull_request"],
    ["link.provider", "github"],
    ["link.url", "https://example.test/pr/7"],
  ]);
  expect(args).toContain("--yes\n");
  expect(args).toContain("PR 7: Fix filters\nBody text\nbranch=feature/filters\n");
  expect(args).not.toContain("ghp_secret_should_not_leak");
  expect(await read(ghArgs)).toContain("pr\nview\n7\n--json\n");
});

test("launch-issue uses the Linear seam and the daemon-resolved recipe", async () => {
  const box = await sandbox("launch-issue");
  const pohunek = join(box.bin, "pohunek");
  const linear = join(box.bin, "linear-wrapper");
  const pohunekArgs = join(box.root, "pohunek.args");

  await writeExecutable(
    linear,
    `#!/bin/sh
printf '{"id":"LIN-123","title":"Fix launcher","description":"Issue body","branchName":"lin-123-fix-launcher","url":"https://linear.test/LIN-123"}\\n'
`,
  );
  await writeExecutable(pohunek, POHUNEK_STUB);
  const configDir = await writeConfig(box.root, [
    ["pohunek_bin", pohunek],
    ["linear_cli", linear],
    ["host", "build-box"],
  ]);
  // The recipe sets a base branch; the launcher must thread it as --base-branch.
  const recipe =
    '{"provider":"linear_issue","agent":"codex","base_branch":"develop","prompt_name":"issue","prompt_content":"Issue ${id}: ${title}\\n${body}\\nbranch=${branch}\\n"}';

  const result = await runScript("pohunek-launch-issue", ["ui", "LIN-123"], box, configDir, {
    POHUNEK_TEST_REAL_POHUNEK: pohunekBin(),
    POHUNEK_TEST_POHUNEK_ARGS: pohunekArgs,
    POHUNEK_TEST_RECIPE_JSON: recipe,
    LINEAR_API_KEY: "lin_secret_should_not_leak",
  });

  expect(result.status, failureContext(result)).toBe(0);
  const args = await read(pohunekArgs);
  expect(args).toContain("--host\nbuild-box\nproject\naction\nui\nprocess-issue\n--json\n");
  expect(args).toContain("prompt\nrender\n");
  expect(args).toContain("prompt\nlink\n");
  expect(args).toContain("--provider\nlinear_issue\n");
  expect(args).toContain("--item-id\nLIN-123\n");
  expect(args).toContain("--host\nbuild-box\nsession\nnew\n");
  expect(args).toContain("--agent\ncodex\n");
  expect(args).toContain("--project\nui\n");
  expect(args).not.toContain("--repo");
  expect(args).toContain("--branch\nlin-123-fix-launcher\n");
  assertMetaArgs(args, [
    ["link.branch", "lin-123-fix-launcher"],
    ["link.id", "LIN-123"],
    ["link.kind", "issue"],
    ["link.provider", "linear"],
    ["link.url", "https://linear.test/LIN-123"],
  ]);
  expect(args).toContain("--base-branch\ndevelop\n");
  expect(args).toContain("Issue LIN-123: Fix launcher\nIssue body\n");
  // Auth stays inside the linear CLI's own seam: the token never reaches the pohunek command line.
  expect(args).not.toContain("lin_secret_should_not_leak");
});

test("launch-issue agent diverges per project recipe", async () => {
  // The agent comes entirely from the daemon-resolved recipe, never from the client config.
  const box = await sandbox("launch-divergence");
  const pohunek = join(box.bin, "pohunek");
  const linear = join(box.bin, "linear-wrapper");
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
  const claude = '{"provider":"linear_issue","agent":"claude","prompt_name":"issue","prompt_content":"P ${title}\\n"}';
  const codex = '{"provider":"linear_issue","agent":"codex-fast","prompt_name":"issue","prompt_content":"P ${title}\\n"}';

  async function launch(project: string, recipe: string, argsFile: string): Promise<string> {
    const result = await runScript("pohunek-launch-issue", [project, "LIN-1"], box, configDir, {
      POHUNEK_TEST_REAL_POHUNEK: pohunekBin(),
      POHUNEK_TEST_POHUNEK_ARGS: argsFile,
      POHUNEK_TEST_RECIPE_JSON: recipe,
    });
    expect(result.status, failureContext(result)).toBe(0);
    return read(argsFile);
  }

  const a = await launch("project-a", claude, join(box.root, "a.args"));
  const b = await launch("project-b", codex, join(box.root, "b.args"));
  expect(a).toContain("project\naction\nproject-a\nprocess-issue\n");
  expect(b).toContain("project\naction\nproject-b\nprocess-issue\n");
  expect(a).toContain("--agent\nclaude\n");
  expect(b).toContain("--agent\ncodex-fast\n");
  expect(a).not.toContain("--agent\ncodex-fast\n");
});

test("launch-issue rejects an unknown template variable without starting a session", async () => {
  const box = await sandbox("launch-issue-unknown-var");
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
  const recipe = '{"provider":"linear_issue","agent":"codex","prompt_name":"issue","prompt_content":"Issue ${id}: ${missing}\\n"}';

  const result = await runScript("pohunek-launch-issue", ["ui", "LIN-1"], box, configDir, {
    POHUNEK_TEST_REAL_POHUNEK: pohunekBin(),
    POHUNEK_TEST_POHUNEK_ARGS: pohunekArgs,
    POHUNEK_TEST_RECIPE_JSON: recipe,
  });

  expect(result.status).not.toBe(0);
  const args = await read(pohunekArgs);
  expect(args).toContain("project\naction\nui\nprocess-issue\n--json\n");
  expect(args).not.toContain("session\nnew\n");
  expect(result.stderr).toContain("unknown variable");
});

