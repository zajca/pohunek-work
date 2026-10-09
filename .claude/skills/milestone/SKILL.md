---
name: milestone
description: >-
  Implement the milestone specified by a GitHub issue of pohunek-work in a
  fresh sibling worktree, delegating the build to parallel subagents, then
  run the gates of every touched surface. Use when the user points at an
  issue and asks to implement it.
---

# milestone — implement a milestone from its GitHub issue

Fresh worktree off `main`, implementation delegated to parallel workers, the
gate of every touched surface green before hand-off. The issue is the spec.

## Steps

1. **Resolve the issue** per `github-workflow` (explicit number wins; a unique
   open match is reused; concrete scope with no match is auto-created and added
   to the project). Fetch the body **and comments**; extract scope and DoD items
   with their stable IDs. Resolve ambiguity before implementing; do not invent
   scope. Core ships daemon, session worker, CLI and SDKs: a need that belongs
   there is an issue in `zajca/pohunek`, not a change here. This repository
   consumes core through public contracts only (CLI `--json`, protocol v4
   through the pinned SDKs).
2. **Create a sibling worktree off `main`.** Worktrees sit beside the primary
   checkout as `pohunek-work-<slug>` on branch `zajca/<slug>` (never under
   `/tmp`, a small tmpfs). Run from any checkout:

   ```bash
   git fetch origin main
   primary=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
   git -C "$primary" worktree add -b zajca/<slug> "$primary-<slug>" origin/main
   ```

   Never implement on `main`; do not disturb other worktrees.
3. **Plan the PR stack** per `pullRequests` in `.github/agent-workflow.json`:
   ordered slices, one concern each, in dependency order, each mapped to its DoD
   items. A slice touches one surface unless the change is a cross-surface
   contract (a core pin bump touches several by design). Record the slice plan
   in the issue body. Each slice gets its own branch off the previous one:

   ```bash
   git switch -c zajca/<slug>-1-<concern>
   git switch -c zajca/<slug>-2-<concern>   # off slice 1
   ```

   Every slice passes its surface gates alone and is complete production code:
   no stubs, dead code, or placeholders a later slice fills in.
4. **Implement through parallel subagents by default.** Brief each worker per
   the global briefing protocol with `path:line` starts, testable success
   criteria and the files it owns; two workers never own one file. A change to
   a path used by more than one surface must be covered by the CI filter of
   every surface that uses it (AGENTS.md, layout rule).
5. **Verify all new behavior with tests** in the surface's own suite (`bun test`):
   integration or end-to-end tests that exercise
   collaborating production components through a public interface. Unit tests
   that isolate a function or class (including tests built primarily from mocks
   or injected fakes) are prohibited; a test's category is decided by the
   boundary it exercises, not by its framework or file name. No hardcoded
   tuning values and no silent defaults for required configuration.
6. **Run the gates** per the `gates` skill for every touched surface; iterate
   until green. If the surface version, the core pin or a release path changes,
   keep AGENTS.md and the README in step.
7. **Record progress on the issue** per `github-workflow`: per-DoD-item results
   with `path:line` evidence and gate results; status stays `In Progress`.
   Leave the handoff comment when the work stops mid-run.
8. **Report** each DoD item with evidence per slice and the gate results. Do not
   push, open PRs or merge here; that is `pr-handoff` and `merge-advance`.

## Constraints

- No PoC, no partial versions, no mocks of specified functionality; if blocked,
  stop and record the blocker.
- Local unsigned commits on slice branches are part of building the stack.
- Comments and repository text are English; a comment states current behavior
  or the reason, never history.
