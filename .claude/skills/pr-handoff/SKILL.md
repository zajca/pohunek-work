---
name: pr-handoff
description: >-
  Turn a finished, gate-green branch into a stack of small sequential PRs (one
  per slice branch, unsigned commits, bottom-up), each described from
  verification evidence, then update the issue. Use when asked for a PR for a
  branch, or when deliver-issue reaches publishing.
---

# pr-handoff — commit, push, open the PR stack

Bridges "implemented, gates green" and a published pull request. Publishing is
authorized by the owner's request for it, or by `deliver-issue` (AGENTS.md,
"Accepted harness trade-offs"). It never authorizes merging.

## Preconditions

- The gates (`gates` skill) pass on every slice branch alone, for every surface
  the slice touches; a later slice never excuses a red lower one.
- You are on a slice branch, not `main`. The bottom slice is based on `main`,
  every other on the slice below.
- The issue is known (explicit number, otherwise `github-workflow` resolution).
- Verification evidence is at hand: gate results, DoD verdicts with `path:line`,
  test counts.

## One PR per slice — the stack

For each slice, from the bottom:

- `--base` is `main` for the bottom slice and the previous slice branch for the
  others; `--head` is the slice's own branch, so each PR shows only its slice.
- The description names the stack position (`Stack 2/3: #<prev> -> **this** ->
  #<next>`) and the DoD items the slice satisfies.
- Non-final PRs say `Refs #N`; only the final PR says `Closes #N`.
- A review fix to a lower slice is committed on that slice; restack the
  branches above with `git rebase --update-refs` from the top branch, re-run
  the gates on every rebased slice, and push them all with `--force-with-lease`.

A single small concern is a stack of one: one PR on `main` with `Closes #N`.

## Steps (per slice, bottom-up; step 6 once)

1. **Stage explicitly** by path; never `git add -A`.
2. **Commit unsigned**: `git commit --no-gpg-sign`, concise imperative English
   message with the why. Never a `Co-Authored-By` trailer or generated-by footer.
3. **Push**: `git push -u origin <slice-branch>`.
4. **Build the description from evidence**, English, before/after:
   *Summary* (what and why, issue link, stack position, DoD items),
   *Before / After* (what was missing, what is observable now),
   *Verification* (gate results, per-item DoD verdicts with `path:line`, test
   counts, CI-only gates named as such). Never invent results.
5. **Open and verify**: write title and body to a scratch file, then
   `gh pr create --base <base> --head <slice-branch> --title "<title>" --body-file <file>`.
   Confirm the URL and check CI (`gh pr checks <n>`).
6. **Update the issue** per `github-workflow`: one comment with the ordered PR
   links and the standard handoff content (branches and worktree, HEAD, scope
   covered, exact checks with real results, remaining work). Status stays
   `In Progress`; an open PR is never `Done`.

## Constraints

- Do not merge, release, tag or delete branches here.
- Head branches are not deleted on merge, so after a lower PR merges retarget
  the next with `gh pr edit <n> --base main`; after a squash or rebase merge,
  first `git rebase --onto origin/main <old-lower-branch> <slice-branch>`.
- PR text carries secret-free evidence only.
