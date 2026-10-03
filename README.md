# pohunek-work

Home of the pohunek user surfaces. Each surface owns a top-level folder with
its own toolchain files and its own CI job, so a change to one surface never
runs the checks of another.

| Folder | Surface |
|--------|---------|
| [`plugin/`](plugin/README.md) | `pohunek-work` workflow plugin CLI (Bun) |

CI (`.github/workflows/ci.yml`) computes the changed surfaces, runs only their
jobs on pull requests (everything on `main`, schedule and manual dispatch), and
reports one always-present `ci` check.
