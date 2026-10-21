import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { read, removeSandboxes, runScript, sandbox, writeConfig, writeExecutable } from "./helpers.ts";

afterEach(removeSandboxes);

test("new-session keybind launches the standalone form in the configured terminal", async () => {
  const box = await sandbox("new-session");
  const terminal = join(box.bin, "terminal");
  const work = join(box.bin, "pohunek-work");
  const args = join(box.root, "terminal.args");
  await writeExecutable(terminal, '#!/bin/sh\nprintf "%s\\n" "$@" > "$POHUNEK_TEST_TERMINAL_ARGS"\n');
  await writeExecutable(work, "#!/bin/sh\nexit 0\n");
  const configDir = await writeConfig(box.root, [["terminal", terminal], ["pohunek_work_bin", work]]);
  const result = await runScript("pohunek-new-session", [], box, configDir, { POHUNEK_TEST_TERMINAL_ARGS: args });
  expect(result.status).toBe(0);
  expect(await read(args)).toBe(`-e\n${work}\nnew-session\n`);
});

test("new-session keybind rejects arguments without launching a terminal", async () => {
  const box = await sandbox("new-session-args");
  const terminal = join(box.bin, "terminal");
  const args = join(box.root, "terminal.args");
  await writeExecutable(terminal, '#!/bin/sh\nprintf "%s\\n" "$@" > "$POHUNEK_TEST_TERMINAL_ARGS"\n');
  const configDir = await writeConfig(box.root, [["terminal", terminal]]);
  const result = await runScript("pohunek-new-session", ["unexpected"], box, configDir, { POHUNEK_TEST_TERMINAL_ARGS: args });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("usage: pohunek-new-session");
  expect(await read(args)).toBe("");
});
