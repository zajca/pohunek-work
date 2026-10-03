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
archive and the ad-hoc signed macOS `Pohunek.app` and web archives
(aarch64-apple-darwin), and attaches them to a GitHub release once every
archive and checksum has a build-provenance attestation. Every archive has a
`.sha256` file and a `MANIFEST` that records the pinned core version; `packaging/core-pin` reads it
from `native/Cargo.toml` and fails the release when `web/core-sdk.json` or the
GUI version disagrees. Core ships the CLI, daemon and worker archives; this
repository builds none of them.

Download an archive with `gh release download vX.Y.Z -R zajca/pohunek-work -p
'<archive>*'` (needs `gh auth login`), or, while the repository is public, from
the asset URL with `curl -LO`. Verify it with `sha256sum -c <archive>.sha256`.

Every archive and checksum carries a GitHub build-provenance attestation made
by the `attest` job of the release workflow; check a download with
`gh attestation verify <archive> --repo zajca/pohunek-work`.

A manual run of the workflow (Actions, Release, version `X.Y.Z`) builds
everything, including the macOS archives, and publishes and attests nothing.

### macOS archives

The macOS archives are signed ad hoc with no Apple account: the workflow has
no signing secret, environment or repository variable. Provenance comes from the attestation above, not from a signer
identity. The `Pohunek.app` bundle and the `pohunek-web` binary are signed
inside-out with the ad-hoc identity, without the hardened runtime and without
entitlements, and `packaging/macos/verify-signed --adhoc` checks the shipped
bytes in the `verify-macos` job and in the `macos-package` CI job.

Install with Homebrew from the shared tap `zajca/homebrew-pohunek`:

```bash
brew install zajca/pohunek/pohunek-gui   # Pohunek.app
brew install zajca/pohunek/pohunek-web   # web control center
```

Homebrew downloads do not carry the quarantine attribute, so Gatekeeper does not
block them. An archive downloaded in a browser is quarantined and Gatekeeper
refuses an app that Apple has not vetted: open it once from Finder with Control-click, Open
(or remove the attribute with `xattr -dr com.apple.quarantine Pohunek.app`)
after verifying the attestation. The ad-hoc signature has no stable signer
identity, so macOS treats a new version of the app as a new program: after an
upgrade the Keychain asks once more for permission to use the stored
credentials; choose Always Allow again.

The packaging scripts and their tests live in `packaging/`, shared by `native/`
and `web/`. The packaging scripts and their tests live in
`packaging/`, shared by `native/` and `web/`.
