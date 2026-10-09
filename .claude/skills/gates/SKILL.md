---
name: gates
description: >-
  Run the pohunek-work CI gate of every surface a branch touches (plugin,
  launchers, web, packaging) and report the results honestly. Use
  before declaring any change done, when a branch must be verified, or
  whenever a run of the repository gates is requested. This is the shared
  verification block the milestone, pr-handoff, merge-advance and
  deliver-issue skills rely on.
---

# gates — run the CI gate of each touched surface

CI (`.github/workflows/ci.yml`) is the source of truth. On a pull request it
runs only the jobs of the surfaces the diff touches; this skill mirrors those
jobs so a local pass lines up with CI. Never claim a gate passed without
running it; report failures with the real output. A gate that cannot run here
is reported as CI-only with the reason, never silently skipped.

## 1. Pick the surfaces

Map the changed paths (`git diff --name-only origin/main...HEAD`) to surfaces
the same way the `changes` job does:

| Changed path | Gates to run |
| --- | --- |
| `plugin/**` | plugin, packaging |
| `launchers/**` | launchers, plugin, packaging |
| `web/**` | web, packaging (when `web/packaging/**` or `web/release/**`) |
| `packaging/**` | web, packaging, macOS packaging (CI-only) |
| `.github/workflows/ci.yml` | every surface, packaging, macOS packaging (CI-only) |
| Other `.github/workflows/**` | packaging |

A full core pin bump changes `web/core-sdk.json` and the `launchers` job's
`POHUNEK_RELEASE` in `ci.yml`, so it runs every surface, including the
real-daemon end-to-end tests.

## 2. Run the gates

Run each surface from its own folder with every `POHUNEK_*` variable unset
(zsh does not word-split `$VAR`, so run through `bash`):

```bash
bash -c 'for v in $(compgen -e | grep "^POHUNEK_"); do unset "$v"; done; <command>'
```

Never print variable values.

**plugin/**

```bash
cd plugin && bun install --frozen-lockfile && bun run check   # lint, typecheck, tests
```

**launchers/** — `bun test` needs `POHUNEK_TEST_SHELL` (`sh`, `bash` or
`dash`) and, for the rendering tests, `POHUNEK_TEST_BIN` (absolute path of a
core `pohunek` binary, for example the one
`eval "$(bun scripts/build-core-binaries.ts)"` exports from `web/`). Set them
only for this gate.

```bash
cd launchers && bun install --frozen-lockfile && bun run check
```

**web/** — the core SDK tarballs and binaries come from `web/core-sdk.json`.

```bash
cd web
eval "$(bun scripts/build-core-binaries.ts)"   # exports POHUNEK_DAEMON_BIN, POHUNEK_WORKER_BIN, POHUNEK_CLI_BIN
bun scripts/pack-core-sdk.ts --verify-reproducible
bun scripts/sync-core-sdk.ts --check
bun scripts/serve-core-sdk.ts --run bun install --frozen-lockfile
bun run typecheck && bun run lint && bun test
bunx playwright install --only-shell chromium && bun run test:e2e
POHUNEK_E2E=1 bun test backend/test/real-daemon.e2e.test.ts
```

Unset the other `POHUNEK_*` variables first, then `eval` the build output in
the same shell so the exported binary paths survive. The `web` job in
`ci.yml` is authoritative for the real-daemon test's environment and for the
release-archive audit step.

**packaging/** — scripts every release uses:

```bash
python3 -m unittest discover -s packaging/tests
```

CI also lints the workflows and shellchecks the packaging scripts (the
`packaging` job lists the exact files); run `actionlint` and `shellcheck` on
the files you changed when they are installed. Shell scripts stay POSIX: CI
runs them under `dash` and macOS `/bin/sh`.

**CI-only**: the macOS jobs (`web-macos`, `macos-package`) and
anything needing a macOS runner. Name them as CI-only in the evidence.

## 3. Report

1. A step is green only after it exits 0.
2. On failure, capture the failing output, fix the cause (or delegate it), and
   re-run the whole surface gate; a step that "passed last time" is not
   skipped.
3. Report a compact status per gate: pass, fail with the first failing lines,
   or skipped with the reason. If a gate failed or was skipped, say so
   plainly.

A local pass does not guarantee CI green; CI is the arbiter. Never weaken a
test or lint rule to get green.
