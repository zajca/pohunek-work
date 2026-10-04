---
name: merge-advance
description: >-
  Merge a finished PR stack into main bottom-up on GitHub, verify the landing,
  clean up branches and worktree, then update the issue and project status.
  Use when asked to land a finished milestone.
---

# merge-advance — land a stack and update tracking

## Preconditions

- Every PR of the stack meets the merge criteria: required checks green, the
  automated review of the exact head present with no unanswered actionable
  finding (`review` in `.github/agent-workflow.json`), no unresolved human
  review request, the DoD items the slice owns met with evidence.
- Never merge red, and never an upper slice before the ones below it.
- The issue is known (explicit number, otherwise `github-workflow` resolution).

## Steps

1. **Merge bottom-up**: `gh pr merge <n> --merge` for the bottom slice; then
   retarget the next with `gh pr edit <next> --base main` and rebase it onto
   `origin/main` when needed; re-check its CI and review on the new head; repeat.
2. **Verify the landing**: `git fetch origin`, confirm each merge commit is on
   `origin/main`, and watch the `main` CI run of the final commit to green. A
   red `main` is fixed at once in a new PR.
3. **Record the landing** per `github-workflow`: comment the merge commits and
   gate evidence. A landed lower slice is a progress comment. Close the issue
   as completed and set the project to `Done` only after the whole stack is
   verified on `origin/main` with the DoD met. Verify every write from the API
   response.
4. **Clean up** from a checkout other than the one being removed:

   ```bash
   primary=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
   git -C "$primary" worktree remove "$primary-<slug>"
   git -C "$primary" branch -d zajca/<slug> zajca/<slug>-1-<concern> ...
   git -C "$primary" worktree prune
   ```

   Verify with `git worktree list`; reconcile stragglers.
5. **Next work**: if the next milestone is unplanned, hand over to `plan-phase`.
6. **Report** the merge commits, cleanup, and the verified issue and project
   updates.

## Constraints

- Never sign commits; no `Co-Authored-By` or generated-by footer.
- Issue and project writes follow `github-workflow` safe persistence; a blocked
  write is reported as blocked.
- Do not release here; that is the `release` skill.
