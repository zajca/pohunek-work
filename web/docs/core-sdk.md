# Core SDK pin

The web workspace consumes three TypeScript packages that core owns:
`@pohunek/protocol`, `@pohunek/sdk` and `@pohunek/testkit`. Core publishes them
as per-package tarballs (`pohunek-ts-<package>-<version>.tgz`, compiled ESM plus
declarations, Node >= 20 or Bun) attached to a core release; the inner
`@pohunek/*` dependencies of each tarball point at the sibling tarballs of the
same release. This workspace installs the tarballs by URL and `web/bun.lock`
records their integrity.

## One source: `web/core-sdk.json`

```json
{
  "coreRepository": "https://github.com/zajca/pohunek",
  "coreRev": "<40-digit core commit>",
  "sdkVersion": "<version stamped into the tarballs>",
  "assetBaseUrl": "<where vSDKVERSION/pohunek-ts-<package>-SDKVERSION.tgz is served>"
}
```

- `coreRev` is the core commit everything is built against: the SDK tarballs,
  and the `pohunekd`, `pohunek-sessiond` and `pohunek` binaries the real-daemon
  tests drive. It must be the commit of the core tag (or the revision) pinned in
  `native/Cargo.toml`; `packaging/core-pin` fails the release (and the packaging
  tests) when the two differ.
- `assetBaseUrl` is `https://github.com/zajca/pohunek/releases/download` for a
  core release, or `http://127.0.0.1:<port>/releases/download` to develop against
  an unreleased core commit (see below).
- `web/package.json` carries the resulting URLs in its `catalog`; the three
  workspace members reference them as `catalog:`. `bun run core-sdk:sync`
  rewrites the catalog from the pin and CI runs it with `--check`.

## Developing against an unreleased core: pack and serve

`web/scripts/pack-core-sdk.ts` (`bun run core-sdk:pack`) packs the three tarballs
into `web/.core-sdk/assets`:

1. It uses a core checkout at `coreRev` (`--core-checkout DIR` for an existing,
   clean clone; otherwise a shallow clone kept in `web/.core-sdk/core`).
2. It runs `bun install --frozen-lockfile` there and core's
   `sdk/ts/scripts/pack-release.ts` with `SOURCE_DATE_EPOCH` set to the pinned
   commit's time, `--version` set to `sdkVersion` and `--base-url` set to
   `<assetBaseUrl>/v<sdkVersion>`.
3. With `--verify-reproducible` it packs a second time and fails when any
   tarball differs.

`web/scripts/serve-core-sdk.ts` (`bun run core-sdk:serve`) serves that directory
at the address the pin names, exactly like a release download URL. With
`--run COMMAND...` it serves only while the command runs, which is how the
dependencies are installed (`bun run core-sdk:install`, or
`bun scripts/serve-core-sdk.ts --run bun install` to refresh `bun.lock` after a
pin change). A pin that names a core release makes both scripts no-ops, so
workflows can run them unconditionally.

The bytes are reproducible for one host zlib, so the packing and the lockfile
must use the Bun version pinned in `web/package.json`: Bun 1.4.2 packs the same
commit into different bytes, which fails the frozen install's integrity check.
Bun 1.4.2 also fails the backend test `tunnel open refreshes identity ownership
before dialing cached address`, so this workspace stays on 1.3.11 while
`plugin/` and `launchers/` use 1.4.2.

## Cutover to a core release

1. Set `coreRev` to the release commit, `sdkVersion` to `X.Y.Z` and
   `assetBaseUrl` to `https://github.com/zajca/pohunek/releases/download`.
2. Run `bun run core-sdk:sync`, then `bun install` (no packing, no server) to
   refresh `bun.lock`. The integrity of the release tarballs comes from core's
   release workflow, so it can differ from the locally packed bytes.
3. Bump `native/Cargo.toml` to the same commit or tag. `packaging/core-pin` also
   resolves the tag `vX.Y.Z` and fails unless it points at `coreRev`.

`web/scripts/build-core-binaries.ts` keeps building the test binaries from
`coreRev` with `cargo install --locked --git ... --rev` after the cutover.
