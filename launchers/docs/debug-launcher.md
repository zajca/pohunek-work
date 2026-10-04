---
type: Runbook
id: runbook/debug-launcher
title: Debug launcher behavior
description: Diagnose launcher problems by separating scripts, config, daemon health, and project action resolution.
source_kind: manual
intents: [debug, setup, help]
since: 0.3.3
---

# Debug Launcher Behavior

Use this runbook when a launcher keybinding or menu does not start the expected
session.

1. Run `pohunek-work doctor` and read the `warn` lines for rofi, swaymsg,
   python3, the terminal, the installed scripts and the sway include.
2. Verify daemon health with `pohunek health --json`.
3. Check the installed scripts with `pohunek-work setup scripts`: `unchanged`
   means they match this version, `skipped` means a file differs. Replace them
   with `pohunek-work setup scripts --force` when the difference is not an edit
   to keep.
4. Check launcher config setup with `pohunek-work setup config`. Do not use
   `--force` unless the user wants existing files overwritten.
5. Print or update sway integration with `pohunek-work setup sway --print` or
   `pohunek-work setup sway`.
6. If the launcher targets a project action, run
   `pohunek project actions <id-or-label> --json` and
   `pohunek project action <id-or-label> <action> --json`.
7. If a session starts but does not appear where expected, use
   `pohunek session list --json` and `pohunek session inspect <target> --json`.

On macOS the rofi/sway launcher does not apply: steps 3 and 5 are skipped by
`pohunek-work setup` (an explicit `pohunek-work setup sway` reports `skipped` and
exits successfully), and `pohunek-work doctor` checks only the terminal. The
runtime directory, worker, launchd and filesystem-privacy checks belong to
`pohunek doctor`.

Keep launcher diagnosis layered: first daemon health, then installed assets, then
project/action resolution, then session state.

## Running the launcher tests

The tests live in `launchers/tests` (their own `package.json`, run with Bun) and
execute the scripts under the shell named by `POHUNEK_TEST_SHELL`, for example
`dash`, `bash` or `sh`; there is no default. CI runs them under `dash` and
`bash` on Ubuntu, where `/bin/sh` is dash, and, without `launch-render.test.ts`
(no macOS `pohunek` release binary exists), under macOS `/bin/sh`.

```sh
cd launchers
bun install --frozen-lockfile
POHUNEK_TEST_SHELL=dash POHUNEK_TEST_BIN=/path/to/pohunek bun run test
```

`POHUNEK_TEST_BIN` names a `pohunek` binary that provides `prompt render` and
`prompt link`; only `launch-render.test.ts` needs it, and a missing value fails
that file instead of skipping it. `lib-timeout.test.ts` uses `ps` and `python3`.
The installed copies of the scripts are compared byte for byte with these files by
the `pohunek-work` tests in `plugin/tests/setup/assets.test.ts`.
