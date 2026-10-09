---
name: release
description: >-
  Release one surface of pohunek-work (plugin, launchers or web) by
  bumping its version, tagging <surface>-vX.Y.Z, and verifying the Release
  workflow builds, attests and publishes its archives. Use when the user asks
  to cut or publish a version of a surface.
---

# release — cut and publish one surface

Each surface has its own tag and version (`web-vX.Y.Z`, `launchers-vX.Y.Z`,
`plugin-vX.Y.Z`; no bare `vX.Y.Z`). The `Release` workflow
(`.github/workflows/release.yml`) runs only the tagged surface's jobs.
Releasing needs the owner's explicit request; `deliver-issue` never releases.

## Preconditions

- On `main`, up to date with `origin/main`, working tree clean.
- The `main` CI run of the commit being released is green.
- The tag does not exist yet.
- The core pin is valid: `packaging/core-pin` resolves the core
  release named by `web/core-sdk.json`.

## Steps

1. **Pick surface and version** from the request. The version source is in
   `.github/agent-workflow.json` (`surfaces`): the surface's `package.json`.
2. **Bump the version first**, in a small PR through the normal loop (gate of
   that surface, merge on green). Refresh any lockfile the surface owns.
   Do not tag before the bump has landed on `main`.
3. **Check the tag against the sources** on the landed commit:

   ```bash
   packaging/resolve-release --surface <surface> --version X.Y.Z
   ```

   It prints `surface`, `version`, `tag` and exits 1 on any mismatch.
4. **Dry run (optional)**: dispatch the Release workflow manually with the
   surface and version; it builds and publishes and attests nothing.
5. **Tag and push** from `main`:

   ```bash
   git tag -a <surface>-vX.Y.Z -m "<surface> X.Y.Z"
   git push origin <surface>-vX.Y.Z
   ```

6. **Verify, do not trust.** Watch the run to completion
   (`gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"`),
   then `gh release view <tag>` and confirm every archive and its `.sha256` is
   attached. Verify one archive: `gh attestation verify <archive> --repo zajca/pohunek-work`.
7. **Record it** per `github-workflow` on the issue the release completes.
8. **Report** the tag, the workflow conclusion (failing job if any), and the
   attached assets. Web publishes Linux and macOS archives together;
   there is no opt-out for macOS. Distribution through the Homebrew tap
   `zajca/homebrew-pohunek` is owned by core.

## Constraints

- Never tag from a red commit or before the bump landed.
- Do not change a release job's permissions or steps without updating
  `packaging/tests/test_release_workflow.py` on purpose.
- Report "released" only after the workflow and the GitHub release are checked.
