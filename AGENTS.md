# AGENTS.md

Canonical guide for any coding agent working in this repository. Keep it short,
accurate and current: when a command, folder or convention changes, update this
file in the same change.

## What this repository is

`pohunek-work` holds the user surfaces of pohunek (see the
[README](README.md)): the `plugin/` workflow CLI, the `web/` control center, the
`native/` Iced GUI and the `launchers/`. Core (`zajca/pohunek`) ships the daemon,
session worker, CLI and SDKs and no UI. This repository consumes core through
public contracts only (CLI `--json`, protocol v3 through SDKs pinned to one core
release); never import core internals. Pre-1.0: do not add backward-compatibility
shims unless asked.

## Layout rule

Every surface owns a top-level folder with its own toolchain files and lockfile
(`package.json` + `bun.lock`, or `Cargo.toml` + `Cargo.lock`). The repository root
has no shared workspace. A path used by more than one surface must be listed in
the CI filter of every job that uses it.

## Gates per surface

Run the gate of every surface you touch; CI is the source of truth and runs only
the jobs of changed surfaces on pull requests.

```bash
# plugin/ and launchers/ (Bun)
cd plugin && bun install --frozen-lockfile && bun run check   # lint, typecheck, tests
cd launchers && bun install --frozen-lockfile && bun run check   # lint, typecheck, tests
# `bun test` in launchers/ needs POHUNEK_TEST_SHELL (sh, bash or dash) and, for
# the rendering tests, POHUNEK_TEST_BIN (absolute path of a core `pohunek` binary)

# native/ (Cargo workspace; run with POHUNEK_* variables unset)
cd native
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
eval "$(scripts/build-core-binaries)"   # builds the pinned pohunekd, pohunek-sessiond, pohunek; exports their paths
cargo nextest run --workspace --all-features
cargo test --doc --workspace

# web/ (Bun; core binaries and SDK tarballs come from web/core-sdk.json)
cd web
eval "$(bun scripts/build-core-binaries.ts)"
bun scripts/serve-core-sdk.ts --run bun install --frozen-lockfile
bun run typecheck && bun run lint && bun test
bun run test:e2e                                           # Playwright Chromium
POHUNEK_E2E=1 bun test backend/test/real-daemon.e2e.test.ts

# packaging/ (shared release scripts)
python3 -m unittest discover -s packaging/tests
python3 -m unittest discover -s native/scripts/tests
```

The `gates` skill (`.claude/skills/gates/SKILL.md`) maps changed paths to the
surfaces whose gate to run and lists the full CI-mirror commands.

## Rust rules (native/)

Before creating or editing any `.rs` file, read the vendored Pragmatic Rust
Guidelines: `.agents/rust-guidelines/SKILL.md` is the index; always read
`11_universal_guidelines.md`. Apply `M-CANONICAL-DOCS`, prefer
`#[expect(..., reason = "...")]` over `#[allow]`, keep headless state and I/O in
`gui-core` and the Iced view in `gui`, and use typed `thiserror` errors.

## Agent workflow

Development runs through the skills in `.claude/skills/`, which mirror the core
repository's loop and read `.github/agent-workflow.json` (repository, project,
surfaces, pull request rules; no project or field IDs are hardcoded):

- `plan-phase` records a plan and a DoD (`D1`, `D2`, ...) as a GitHub issue.
- `milestone` implements an issue in a sibling worktree (`../pohunek-work-<slug>`
  on `zajca/<slug>`) through parallel subagents, as a stack of small PRs.
- `gates` runs the CI gate of every touched surface; `milestone-review` checks
  a branch against its DoD.
- `pr-handoff` publishes the stack; `merge-advance` merges it bottom-up and
  verifies the landing; `release` cuts one surface's tag.
- `deliver-issue` chains all of it autonomously: plan, implement, gate,
  publish, loop on CI and the automated review of every pushed head, merge
  bottom-up, verify, close the issue and file follow-ups.
- `github-workflow` holds the shared rules for issues and the Pohunek Project
  (user `zajca`, project 1, shared with `zajca/pohunek`).

A need that belongs to core goes to an issue in `zajca/pohunek`, never into a
workaround here.

### Accepted harness trade-offs

- Invoking `deliver-issue` is the owner's explicit request to commit, push,
  open the issue's pull requests and merge them once CI is green and the
  automated review of the exact head (the `hermes-codex-review` review) has no
  unanswered actionable finding. It never authorizes releases, tags,
  force-pushes to `main` or work outside the issue.
- The same invocation lets agents create issues, comment, link sub-issues and
  set the project status on `zajca/pohunek-work` (and file follow-ups in
  `zajca/pohunek`) without asking; destructive project edits stay excluded.
- `pr-handoff` publishes without a further ask only when invoked by
  `deliver-issue` or on the owner's request.

## Releases and macOS signing

Each surface is released by its own tag and version: `gui-vX.Y.Z`,
`web-vX.Y.Z`, `launchers-vX.Y.Z` and `plugin-vX.Y.Z` (no bare `vX.Y.Z` tag).
`.github/workflows/release.yml` runs only the jobs of the tagged surface:
`prepare` (the only job that reads the tag name or the dispatch inputs) calls
`packaging/resolve-release`, which fails unless the tag's version equals the
version in the surface's sources (`native/Cargo.toml`, `web/package.json`,
`launchers/package.json`, `plugin/package.json`); `gate` fails the release
unless exactly that surface's jobs succeeded. Bump the surface's version before
tagging. `gui` and `web` publish the Linux and the macOS archives together;
there is no opt-out for macOS. The core pin (`packaging/core-pin --require-web`)
is shared by every surface and recorded in every manifest, so a release of any
surface fails while `native/Cargo.toml` and `web/core-sdk.json` disagree. macOS
archives are ad-hoc signed (`packaging/macos/package --adhoc-release`) and no
job uses a secret, environment or
repository variable. Only `attest` holds `id-token: write` and
`attestations: write` and it checks out nothing and runs no downloaded file;
only `publish` holds `contents: write`. `packaging/tests/test_release_workflow.py`
pins these boundaries; changing a job's permissions or steps means updating its
allowlist on purpose. Distribution is the Homebrew tap `zajca/homebrew-pohunek`
(formulae `pohunek-gui`, `pohunek-web`), owned by core, which consumes the
`gui-v*` and `web-v*` release assets. After a published `gui-v*` or `web-v*`
release, `.github/workflows/notify-tap.yml` (a `workflow_run` of `Release`, the
only workflow with a secret, `TAP_DISPATCH_PAT`) sends the tap a
`pohunek-work-release` repository dispatch with the formula and the tag; the tap
bumps that formula. `packaging/tests/test_notify_tap_workflow.py` pins it. Verify a release asset
with `gh attestation verify <archive> --repo zajca/pohunek-work`.

## Conventions

- Comments and all repository text are English. A comment states current
  behavior or the reason, never history ("previously", "moved from").
- No hardcoded tuning values; no silent defaults for required configuration.
- Secrets never enter code, logs, errors or agent context.
- Commits are unsigned, concise, with no `Co-Authored-By` or generated-by footer.
- Work is tracked in GitHub Issues (this repository and `zajca/pohunek`); pull
  requests are small, sequential and each passes its surface's gate alone.
- The core pin and its bump procedure are documented in the README.
