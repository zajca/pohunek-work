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
```

## Rust rules (native/)

Before creating or editing any `.rs` file, read the vendored Pragmatic Rust
Guidelines: `.agents/rust-guidelines/SKILL.md` is the index; always read
`11_universal_guidelines.md`. Apply `M-CANONICAL-DOCS`, prefer
`#[expect(..., reason = "...")]` over `#[allow]`, keep headless state and I/O in
`gui-core` and the Iced view in `gui`, and use typed `thiserror` errors.

## Conventions

- Comments and all repository text are English. A comment states current
  behavior or the reason, never history ("previously", "moved from").
- No hardcoded tuning values; no silent defaults for required configuration.
- Secrets never enter code, logs, errors or agent context.
- Commits are unsigned, concise, with no `Co-Authored-By` or generated-by footer.
- Work is tracked in GitHub Issues (this repository and `zajca/pohunek`); pull
  requests are small, sequential and each passes its surface's gate alone.
- The core pin and its bump procedure are documented in the README.
