# pohunek-work

A pohunek workflow plugin that answers one question for every open work item:
**who has to act next — me, an agent, or a reviewer?**

It joins three sources that are each correct on their own but never shown
together:

- **Linear** — issue state, cycle, assignee;
- **GitHub** — draft, reviews, review threads, checks, mergeability;
- **pohunek** — which agent session works on the item and whether it waits
  for an answer.

Each project file selects its issue source with the required key
`issue_source` (`linear` or `github`). `linear_team` and `paused_states` belong
to `linear` only, and the global `[linear]` table and keyring entry are needed
only while a Linear project is configured. A `github` project takes its issues
from the open GitHub issues of `repo` that are assigned to the owner and carry
one of its `started_labels` or `paused_labels`; an issue shows up only when it is
assigned **and** labelled, so an unassigned or unlabelled issue produces no row.
See RFC 11.3.

Each project file also names who reviews its pull requests with the required key
`reviews`: `session` (`do <key> review` launches a pohunek review session) or
`external` (the project's own pipeline reviews). With `external`, a row whose
review is requested from the owner is on the agent's turn (`external review`,
rule 3), offers no `review` action, is not notified by `watch`, and
`do <key> review` refuses with `not_supported`.

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
  launches a linked session; `implement` also launches a `github-issue:` row: the
  branch is `<branch_prefix>/<issue_number_prefix><n>/<slug>` (the project's
  `branch_pattern` has to capture `<n>` from it) and the prompt carries the issue
  title and body, cut to `[actions] issue_body_max_length` characters, inside an
  untrusted-data block (both keys are required, `issue_number_prefix` may be empty); `review` starts in a fresh worktree of the pull
  request head and checks the checked-out commit after the launch;
- `pohunek-work do <key> ready [--dry-run]` runs `gh pr ready` on the owner's
  draft and re-reads the pull request to confirm it is no longer a draft;
- `pohunek-work do <key> attach` attaches the terminal to the one live linked
  session;
- `pohunek-work setup [scripts|config|sway] [--force] [--json]` installs the
  rofi/sway launcher scripts, the starter `launcher.conf` and prompt templates,
  and the sway drop-in from `launchers/` into the per-user XDG locations;
  `pohunek-work doctor` reports the launcher requirements (rofi, swaymsg,
  python3, terminal, installed scripts, sway include) as advisory `warn` lines
  (see [launchers/docs/launcher.md](../launchers/docs/launcher.md));
- `pohunek-work do <key> merge` is refused (`not_supported`): merging stays
  manual.
- `pohunek-work watch [--project <label>]` polls the same pipeline every
  `[watch] poll_interval_secs` and sends one desktop notification (key and
  reason, no titles) through `[notify] command` when a row becomes the owner's
  turn. The previous turn of each row lives in memory only: a restart, or a
  poll with an unavailable source, never notifies for rows already on the
  owner's turn. It does not use `pohunek notifications watch` yet (spike S4);
  the systemd unit (c.3) is installed from machine-management. Usage and logs:
  [docs/watch-and-agents.md](docs/watch-and-agents.md).

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
- **Public contracts only.** The plugin talks to pohunek through its public
  CLI with `--json` (verified against pohunek 0.31.6). The other surfaces of
  this repository (`web/`, `native/`) additionally speak the public protocol
  through SDKs pinned to a core release; none of them reaches into core
  internals.
- **Owner-controlled autonomy.** What an agent may do without confirmation is
  versioned configuration that starts empty. `merge` is never delegable by
  default.

## Documents

| Document | Content |
| --- | --- |
| [docs/implementation-plan.md](docs/implementation-plan.md) | The complete plan before the next pohunek release: verified pohunek CLI surface, decisions, architecture, configuration, milestones M0–M3 with definitions of done, testing, risks |
| [docs/m2-implementation-plan.md](docs/m2-implementation-plan.md) | Refined plan for M2 (links and actions): decisions, verified pohunek facts, spikes, steps M2a-M2d with definitions of done, risks |
| [docs/watch-and-agents.md](docs/watch-and-agents.md) | How to run `watch` (configuration, what is and is not notified, logs) and how an agent drives pohunek work without growing context or spinning |
| [docs/rfc.md](docs/rfc.md) | Target design: joining rules, the `on_turn` rules, interfaces, actions, storage, per-project configuration, autonomy levels, full 28-step roadmap including the pohunek release, task layer and relay stages |
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
