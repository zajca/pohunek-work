# pohunek-work

A pohunek workflow plugin that answers one question for every open work item:
**who has to act next — me, an agent, or a reviewer?**

It joins three sources that are each correct on their own but never shown
together:

- **Linear** — issue state, cycle, assignee;
- **GitHub** — draft, reviews, review threads, checks, mergeability;
- **pohunek** — which agent session works on the item and whether it waits
  for an answer.

The result is one table with a derived `on_turn` column, a set of named
actions (`implement`, `babysit`, `fix-ci`, `rebase`, `review`, `ready`,
`attach`) shared by the CLI, rofi, notifications and an agent skill (merging
stays manual),
and a path toward a managing agent that runs those actions for the owner under
an explicit policy.

## Status

M0 and M1 are merged: `pohunek-work list` and `doctor`. M2a and M2b are in
progress (see [docs/m2-implementation-plan.md](docs/m2-implementation-plan.md)):

- `pohunek-work do <key> <implement|babysit|fix-ci|rebase|review> [--dry-run]`
  launches a linked session; `review` starts in a fresh worktree of the pull
  request head and checks the checked-out commit after the launch;
- `pohunek-work do <key> ready [--dry-run]` runs `gh pr ready` on the owner's
  draft and re-reads the pull request to confirm it is no longer a draft;
- `pohunek-work do <key> attach` attaches the terminal to the one live linked
  session;
- `pohunek-work do <key> merge` is refused (`not_supported`): merging stays
  manual.

Every action plans from fresh data and refuses with a typed code when its rule
no longer holds; every write action asks for confirmation unless `--yes` is
given.

## Design principles

- **The pohunek daemon stays generic.** It knows sessions, worktrees,
  projects, tasks, events, notifications and opaque metadata — never Linear,
  GitHub or work items. Everything specific lives here, following the
  workflow plugin model of
  [zajca/pohunek#148](https://github.com/zajca/pohunek/issues/148).
- **No new state.** Linear, GitHub and pohunek remain the sources of truth.
  The only write is session metadata (`work.link.*`, `work.role`) at launch;
  `on_turn` is computed at read time and never stored.
- **CLI only.** The plugin talks to pohunek through its public CLI with
  `--json` (verified against pohunek 0.31.6) and needs no change in the
  pohunek repository before its next release.
- **Owner-controlled autonomy.** What an agent may do without confirmation is
  versioned configuration that starts empty. `merge` is never delegable by
  default.

## Documents

| Document | Content |
| --- | --- |
| [docs/implementation-plan.md](docs/implementation-plan.md) | The complete plan before the next pohunek release: verified pohunek CLI surface, decisions, architecture, configuration, milestones M0–M3 with definitions of done, testing, risks |
| [docs/m2-implementation-plan.md](docs/m2-implementation-plan.md) | Refined plan for M2 (links and actions): decisions, verified pohunek facts, spikes, steps M2a-M2d with definitions of done, risks |
| [docs/rfc.md](docs/rfc.md) | Target design: joining rules, the ten `on_turn` rules, interfaces, actions, storage, per-project configuration, autonomy levels, full 28-step roadmap including the pohunek release, task layer and relay stages |
| [docs/work-overview.html](docs/work-overview.html) | Visual summary with diagrams (open in a browser) |

## Milestones

| Milestone | Outcome | Depends on pohunek release |
| --- | --- | --- |
| M0 Foundations | repository tooling, config loader, pohunek CLI wrapper, installer in machine-management, `doctor` | no |
| M1 Read-only overview | `pohunek-work list [--mine] [--json]` with all ten rules | no |
| M2 Links and actions | linked launches, actions, `watch` notifications, rofi, `/work` skill, cleanup and adoption | no |
| M3 Agent proposes | action log, policy, manager session at autonomy level 1 | no |
| Packaging and beyond | #148 package, zajca/pohunek#325–#328, provider extraction, task layer (#182), relay (#185) | yes |

## Open decisions

- **D2 — language and runtime.** Recommended: TypeScript on Bun (`strict`,
  ESLint, Bun test). Must be confirmed before M0.2.
- The keyring service name used by pohunek GUI for the Linear token, and the
  list of ignored CI checks for connection, are filled in during M0.

## Related repositories

- [`zajca/pohunek`](https://github.com/zajca/pohunek) — the agent session
  manager this plugin extends.
- `zajca/machine-management` — plugin configuration, installer, systemd user
  unit, `/work` and `post-merge` skills (`clients/zajca/pohunek-work/`,
  `clients/zajca/skills/`).
