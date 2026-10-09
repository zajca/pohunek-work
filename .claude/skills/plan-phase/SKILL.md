---
name: plan-phase
description: >-
  Plan the next piece of pohunek-work interactively: review the current state,
  resolve open questions ONE at a time with the user deciding, then record a
  complete end-to-end plan as a GitHub issue. Use when the user asks to plan or
  design a feature or milestone before implementing it.
---

# plan-phase — plan work into a GitHub issue

Produces the spec the `milestone` and `deliver-issue` skills later implement:
a complete plan recorded as an issue, reached through a question-and-decision
pass with the user. No local plan file is the authority.

## Steps

1. **Resolve the target issue** per `github-workflow`: explicit number, else
   dedup; concrete new scope with no match is auto-created and added to the
   project. Create it when planning starts so decisions land somewhere live.
2. **Ground yourself in the current state.** Read `README.md`, `AGENTS.md`, the
   docs of the surface involved (`plugin/docs/rfc.md` and the other
   `plugin/docs/` plans, `web/docs/`, `launchers/docs/`), the core pin
   documentation in the README, and the open issues touching the same
   surfaces. Skim the code the work will touch.
3. **Frame the work**: purpose, key assumptions, which surface owns it, and the
   constraints: core only through public contracts, pre-1.0 so no
   backward-compatibility shims, secrets never in code or logs.
4. **Resolve open questions one at a time.** For each, state the problem and
   offer 2-3 options with trade-offs; wait for the decision; record decision
   and rationale in the issue body. Never batch questions or pick silently.
5. **Write the complete plan into the issue body**: scope, design and
   decisions, surfaces affected (including any core contract or pin impact and
   the `zajca/pohunek` issues it depends on), a testable DoD list with stable
   IDs (`D1`, `D2`, ...), and a proposed PR stack (ordered slices mapped to DoD
   items, per `pullRequests` in `.github/agent-workflow.json`). Ensure the
   issue is in the project.
6. **Confirm**: summarize the plan and DoD, link the issue, and say it is ready
   for `milestone` or `deliver-issue`.

## Hard rules

- No PoC, no minimal versions unless the user asks for reduced scope; best
  solution over fastest.
- A plan does not authorize implementation or merge.
- Being `Todo` does not mean the proposed design is accepted; acceptance is an
  explicit decision on the issue.
