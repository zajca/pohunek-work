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

- `native/Cargo.toml` `[workspace.dependencies]`: the core crates by git `rev`
  (a release tag once one exists), all on the same revision, plus
  `native/Cargo.lock`.
- `.github/workflows/ci.yml` (`launchers` job): `POHUNEK_RELEASE` and
  `POHUNEK_MUSL_SHA256`, the core release whose `pohunek` binary the launcher
  rendering tests run.
- `web/` (once its SDK dependency lands): `@pohunek/protocol`, `@pohunek/sdk` and
  `@pohunek/testkit` by the release tarball URLs of that core release;
  `bun.lock` records the integrity.

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
is the single required status. Jobs exist for `plugin/`, `launchers/` and
`native/`; `web/` has none yet because its core SDK dependency is not pinned
(it follows with the web slice of
[#10](https://github.com/zajca/pohunek-work/issues/10)). A new surface adds a
filter entry, a job and an entry in the `ci` job's `needs`.
