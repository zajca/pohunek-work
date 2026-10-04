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
# `bun run test` (part of `check`) runs the suite under a private TMPDIR and fails
# when a test leaves anything in it

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
`gui-v*` and `web-v*` release assets. Verify a release asset
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
