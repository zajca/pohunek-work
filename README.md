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

All surfaces are built and tested against one core release `vX.Y.Z` of
[`zajca/pohunek`](https://github.com/zajca/pohunek):

- `native/Cargo.toml` `[workspace.dependencies]`: the core crates by git `rev`
  (a release tag once one exists), all on the same revision.
- `web/package.json`: `@pohunek/protocol`, `@pohunek/sdk` and `@pohunek/testkit`
  by the release tarball URLs of that core release; `bun.lock` records the
  integrity.

The TypeScript SDK handshake requires `daemonVersion === PROTOCOL_VERSION`, so
the UIs move in lockstep with the core protocol version.

Bump procedure: change the pin in `native/` and `web/` together, refresh
`native/Cargo.lock` and `web/bun.lock`, and run every surface's CI, including
the real-daemon end-to-end tests against that core release's binaries. A pin
bump touches `native/` and `web/` only, so only their jobs run on the pull
request.

## CI

`.github/workflows/ci.yml` computes the changed surfaces (`changes` job),
runs only their jobs on pull requests, runs everything on `main`, the weekly
schedule and manual dispatch, and reports one always-present `ci` check that
is the single required status. A new surface adds a filter entry, a job and an
entry in the `ci` job's `needs`.
