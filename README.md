# pohunek-work

Home of the pohunek user surfaces. Each surface owns a top-level folder with
its own toolchain files, lockfile and CI job, so a change to one surface never
runs the checks of another.

| Folder | Surface | Toolchain |
|--------|---------|-----------|
| [`plugin/`](plugin/README.md) | `pohunek-work` workflow plugin CLI | Bun |
| [`web/`](web/docs/web-control-center.md) | Owner web control center (backend, client core, Svelte SPA) | Bun workspace |
| [`native/`](native/docs/gui.md) | Native Iced GUI (`pohunek-gui`) and its headless core | Cargo workspace |
| [`launchers/`](launchers/docs/launcher.md) | rofi, sway and Linear/GitHub launch scripts, installed by `pohunek-work setup` | shell + Bun tests |

## Public contracts only

Every surface consumes pohunek through its public contracts: the CLI with
`--json` and the public protocol (v3), through the SDKs of one pinned core
release. Core internals are never imported, and core ships no UI.

## Core pin

Every surface is built and tested against one core release of
[`zajca/pohunek`](https://github.com/zajca/pohunek). The pin lives in these
places, which a bump must change together:

- `native/Cargo.toml` `[workspace.dependencies]`: the core crates by git `tag`
  (one core release tag, the same on every crate), plus `native/Cargo.lock`.
- `.github/workflows/ci.yml` (`launchers` job): `POHUNEK_RELEASE` and
  `POHUNEK_MUSL_SHA256`, the core release whose `pohunek` binary the launcher
  rendering tests run.
- `web/core-sdk.json`: the core commit (`coreRev`) of that release and where its
  `@pohunek/protocol`, `@pohunek/sdk` and `@pohunek/testkit` tarballs are
  downloaded (`assetBaseUrl`, `sdkVersion`, the release `vSDKVERSION`).
  `web/package.json` carries the resulting URLs in its `catalog` (refresh it
  with `bun run core-sdk:sync` in `web/`) and `web/bun.lock` records the
  integrity of the published tarballs. `packaging/core-pin` fails when the web
  pin and `native/Cargo.toml` name different core commits or tags; see
  [`web/docs/core-sdk.md`](web/docs/core-sdk.md).

The TypeScript SDK handshake requires the daemon's `health.protocol_version` to
equal `PROTOCOL_VERSION`, so the UIs move in lockstep with the core protocol
version.

Bump procedure: change every pin above to the same core release, refresh the
lockfiles, and run every surface's CI, including the real-daemon end-to-end
tests against that release's binaries. Because the pins sit in different
surfaces, a bump pull request runs the jobs of each surface it touches.

## CI

`.github/workflows/ci.yml` computes the changed surfaces (`changes` job), runs
only their jobs on pull requests, runs everything on `main`, the weekly
schedule and manual dispatch, and reports one always-present `ci` check that
is the single required status. Jobs exist for `plugin/`, `launchers/`,
`native/`, `web/` (Linux and macOS, against the core binaries and SDK tarballs
of the revision in `web/core-sdk.json`) and the shared `packaging/`. A new
surface adds a filter entry, a job and an entry in the `ci` job's `needs`.

## Releases

Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml`: it calls the CI
workflow as its gate, then builds the Linux `pohunek-gui` archive (with a
headless Wayland smoke test), the web control center archives, the launchers
archive and the signed, notarized macOS `Pohunek.app` and web archives, and
attaches them to a GitHub release. Every archive has a `.sha256` file and a
`MANIFEST` that records the pinned core version; `packaging/core-pin` reads it
from `native/Cargo.toml` and fails the release when `web/core-sdk.json` or the
GUI version disagrees. Core ships the CLI, daemon and worker archives; this
repository builds none of them.

Download an archive with `gh release download vX.Y.Z -R zajca/pohunek-work -p
'<archive>*'` (needs `gh auth login`), or, while the repository is public, from
the asset URL with `curl -LO`. Verify it with `sha256sum -c <archive>.sha256`.

A manual run of the workflow (Actions, Release, version `X.Y.Z`) builds
everything and publishes nothing. The macOS signing job needs the secrets
`MACOS_CERTIFICATE_P12_BASE64`, `MACOS_CERTIFICATE_PASSWORD`,
`APPLE_NOTARY_KEY_P8_BASE64`, `APPLE_NOTARY_KEY_ID` and
`APPLE_NOTARY_ISSUER_ID` in the `macos-signing` environment and the repository
variable `MACOS_TEAM_ID`; without them the job fails before any work and no
macOS archive is published. A dry run without credentials sets
`skip_macos_signing`. A tag release without macOS archives needs the explicit
repository variable `RELEASE_WITHOUT_MACOS=true`; with any other value or none,
a missing credential stops the release. The packaging scripts and their tests live in
`packaging/`, shared by `native/` and `web/`.
