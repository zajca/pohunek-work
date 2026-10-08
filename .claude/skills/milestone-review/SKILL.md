---
name: milestone-review
description: >-
  Read-only review of a branch or PR stack against its GitHub issue's
  definition-of-done, with path:line evidence per item, then delegation of
  discrepancy fixes and a gate re-run. Use when asked for a detailed review of
  a branch or to verify a milestone matches its spec.
---

# milestone-review — verify a branch against its issue

Reviews an implemented branch or stack against the DoD recorded on its issue,
then drives fixes for any gap. It verifies scope and delegates corrections; it
does not implement scope itself.

## Inputs

- The issue (explicit number, otherwise per `github-workflow` resolution).
- The branch or worktree (for example `../pohunek-work-<slug>`); for a stack,
  the ordered slice branches and the slice plan on the issue.

## Steps

1. **Load the DoD**: live body and comments, every item with its stable ID, and
   the slice plan (slice to DoD items).
2. **Review read-only, item by item.** Verdict (met / partial / missing) with
   `path:line` evidence. Check the repository conventions: new behavior verified
   by integration or end-to-end tests (that exercise collaborating production
   components through a public interface; unit tests are prohibited),
   no hardcoded tuning values, no silent defaults, secrets never in code or logs,
   comments that state behavior and never history, and for `native/` the
   `.agents/rust-guidelines/` rules. Check the boundary: no import of core
   internals. For a deeper pass run specialist reviewers in parallel
   (`security-reviewer`, `silent-failure-hunter`, `devils-advocate`,
   `performance-reviewer` for data-heavy diffs) and synthesize before reporting.
3. **Record findings** as one issue comment (verdict table plus confirmed
   gaps). Status stays `In Progress`.
4. **Delegate fixes** per confirmed gap to a worker with `path:line` context
   and the DoD item it must satisfy. Keep review findings and fix work
   traceable. Verified out-of-scope findings become follow-up issues; an unmet
   original DoD item is never moved to one.
5. **Re-run the gates** (`gates` skill) on the branch after fixes. For a stack,
   review each slice against its own diff (`git diff <lower>...<slice>`) and
   flag a slice that mixes concerns, exceeds the `pullRequests` size cue
   without reason, or depends on a later slice. Fixes go to the owning slice;
   branches above are restacked.
6. **Final verdict**: each DoD item with final status and evidence, gate
   results, and a plain statement whether the work matches the issue; record it
   as an issue comment.

## Constraints

- The review pass is read-only; changes happen only through delegated fixes.
- Do not report a gap as fixed without re-reading the code and re-running the
  affected gate.
- Do not merge, close the issue or set `Done` here.
