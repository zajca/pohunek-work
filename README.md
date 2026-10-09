# pohunek-work

Home of the pohunek user surfaces. Each surface owns a top-level folder with
its own toolchain files, lockfile and CI job, so a change to one surface never
runs the checks of another.

| Folder | Surface | Toolchain |
|--------|---------|-----------|
| [`plugin/`](plugin/README.md) | `pohunek-work` workflow CLI and work-item TUI | Bun |
| [`web/`](web/docs/web-control-center.md) | Owner web control center (backend, client core, Svelte SPA) | Bun workspace |
| [`launchers/`](launchers/docs/launcher.md) | rofi, sway and Linear/GitHub launch scripts, installed by `pohunek-work setup` | shell + Bun tests |

## Public contracts only

Every surface consumes pohunek through its public contracts: the CLI with
`--json` and the public protocol (v4), through the SDKs of one pinned core
release. Core internals are never imported, and core ships no UI.

## Core pin

Release packaging records one core release of
[`zajca/pohunek`](https://github.com/zajca/pohunek). Keep these references
aligned when bumping core:

- `.github/workflows/ci.yml` (`launchers` job): `POHUNEK_RELEASE` and
  `POHUNEK_MUSL_SHA256`, the core release whose `pohunek` binary the launcher
  rendering tests run.
- `web/core-sdk.json`: the core commit (`coreRev`) of that release and where its
  `@pohunek/protocol`, `@pohunek/sdk` and `@pohunek/testkit` tarballs are
  downloaded (`assetBaseUrl`, `sdkVersion`, the release `vSDKVERSION`).
  `web/package.json` carries the resulting URLs in its `catalog` (refresh it
  with `bun run core-sdk:sync` in `web/`) and `web/bun.lock` records the
  integrity of the published tarballs. `packaging/core-pin` resolves the shared
  core reference from this pin; see
  [`web/docs/core-sdk.md`](web/docs/core-sdk.md).

The TypeScript SDK handshake requires the daemon's `health.protocol_version` to
equal `PROTOCOL_VERSION`, so the web control center moves in lockstep with the
core protocol version.

Bump procedure: change every pin above to the same core release, refresh the
lockfiles, and run every surface's CI, including the real-daemon end-to-end
tests against that release's binaries. Because the pins sit in different
surfaces, a bump pull request runs the jobs of each surface it touches.

## CI

`.github/workflows/ci.yml` computes the changed surfaces (`changes` job), runs
only their jobs on pull requests, runs everything on `main`, the weekly
schedule and manual dispatch, and reports one always-present `ci` check that
is the single required status. Jobs exist for `plugin/`, `launchers/`,
`web/` (Linux and macOS, against the core binaries and SDK tarballs
of the revision in `web/core-sdk.json`) and the shared `packaging/`. A new
surface adds a filter entry, a job and an entry in the `ci` job's `needs`.

## Releases

Each surface is released by its own tag with its own version. Pushing the tag
runs `.github/workflows/release.yml`, which calls the CI workflow for that
surface as its gate, builds only that surface's archives, and attaches them to
a GitHub release once every archive and checksum has a build-provenance
attestation:

| Tag | Release assets | Version source |
| --- | --- | --- |
| `web-vX.Y.Z` | `pohunek-web` Linux archive and the ad-hoc signed macOS archive | `web/package.json` |
| `launchers-vX.Y.Z` | `pohunek-launchers` archive | `launchers/package.json` |
| `plugin-vX.Y.Z` | `pohunek-work-plugin` archive: the `pohunek-work` CLI sources and prompt templates, plus the `launchers/` files the CLI embeds (`plugin/` and `launchers/` keep their sibling layout) | `plugin/package.json` |

The macOS archives are aarch64-apple-darwin. Raise the surface's version in its
source file before tagging: `packaging/resolve-release` fails the release when
the tag's version differs from the sources, and when the prefix is not one of
the three surfaces. Every archive has a `.sha256` file and a `MANIFEST` that
records the pinned core version from `web/core-sdk.json`. Core ships the CLI,
daemon and worker archives; this repository builds none of them.

Download an archive with `gh release download web-vX.Y.Z -R zajca/pohunek-work -p
'<archive>*'` (needs `gh auth login`; use the tag of the surface you want), or,
while the repository is public, from the asset URL with `curl -LO`. Verify it
with `sha256sum -c <archive>.sha256`.

Every archive and checksum carries a GitHub build-provenance attestation made
by the `attest` job of the release workflow; check a download with
`gh attestation verify <archive> --repo zajca/pohunek-work`.

A manual run of the workflow (Actions, Release, a surface and its version
`X.Y.Z`) builds that surface, including its macOS archive, and publishes and
attests nothing.

### macOS archives

The macOS web archive is signed ad hoc with no Apple account: the workflow has
no signing secret, environment or repository variable. Provenance comes from
the attestation above, not from a signer identity. The `pohunek-web` binary is
signed with the ad-hoc identity, without the hardened runtime and without
entitlements, and `packaging/macos/verify-signed --adhoc` checks the shipped
bytes in the `verify-macos` job and in the `macos-package` CI job.

Install with Homebrew from the shared tap `zajca/homebrew-pohunek`:

```bash
brew install zajca/pohunek/pohunek-web   # web control center
```

Homebrew downloads do not carry the quarantine attribute, so Gatekeeper does not
block them. An archive downloaded in a browser is quarantined and Gatekeeper
may refuse an executable that Apple has not vetted. After verifying the
attestation, remove its `com.apple.quarantine` attribute with `xattr -d`.

A published `web-vX.Y.Z` release is passed on to the tap by
`.github/workflows/notify-tap.yml`: it sends a `pohunek-work-release` repository
dispatch (formula and tag) with the repository secret `TAP_DISPATCH_PAT`, a
fine-grained token limited to `zajca/homebrew-pohunek`, and the tap bumps that
formula. `launchers-v*` and `plugin-v*` releases have no formula and send
nothing.

The packaging scripts and their tests live in `packaging/`, shared by every
surface's release.
