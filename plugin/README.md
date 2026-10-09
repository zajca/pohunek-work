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
from the open GitHub issues of `repo` that are assigned to the owner and that
the required key `issue_signal` marks as started or paused: `labels` (the
`started_labels` and `paused_labels` lists), `project` (the option names of a
single-select field of a GitHub Project, for example `Status`, set with the
`status_*` keys) or `both`. An issue shows up only when it is assigned **and**
carries the configured signal, so an unassigned or unmarked issue produces no row.
See RFC 11.3.

Each project file also names who reviews its pull requests with the required key
`reviews`: `session` (`do <key> review` launches a pohunek review session) or
`external` (the project's own pipeline reviews). With `external`, a row whose
review is requested from the owner is on the agent's turn (`external review`,
rule 3), offers no `review` action, is not notified by `watch`, and
`do <key> review` refuses with `not_supported`.

A project file may set the optional table `[teardown]` with the required keys `argv`
(an array whose first element is an absolute program path; no shell, no placeholders) and
`timeout_ms` (positive integer). `do <key> cleanup` runs that command in the session worktree
before it removes the session; without the table nothing runs. See the `cleanup` entry below.

A project file may set the optional key `ignore_label`. Rows whose pull request
or joined issue carries that label (compared case-insensitively) are hidden from
`list` (`list --mine` included), refused by `do` and never notified by `watch`;
without the key the feature is off. `list --include-ignored` shows them (JSON
`ignored: true`, no actions, the computed `on_turn` kept; the table marks the key with `(ignored)`), and the table ends
with `N ignored row(s) hidden (use --include-ignored)` when rows are hidden; the
JSON `omitted_ignored` counts the hidden rows that `--mine`, `--finished-hours`,
`--stale-days` and `--project` would have listed (0 with the flag). `do <key> <action>` on an
ignored row fails with `precondition_failed` unless `--include-ignored` is
passed, also with `--dry-run`.

Each session of a `list --json` row carries `indicator` (`waiting_input` when a
blocked notification of the session is open, `lost`, `running`, or the raw state
such as `stopped` or `done`) and `updated_at` (the session's last change, or
null). `waiting_input` comes from `agent_blocked` and `approval_required`
notifications only; telling a working live session from one waiting for input by
its `activity` depends on core (`zajca/pohunek#544`). The table shows
`<role>:<indicator>`, or the `activity` for a session whose indicator is `running`.
`list --mine --finished-hours <n>` also keeps rows not on your turn whose agent
work ended in the last `n` hours: no session is running or waiting for input and
a session is `stopped` or `done` with an `updated_at` inside the window. The
flag needs `--mine`; `on_turn` is unchanged.

The issue source lists only started issues assigned to the owner (Linear) or
open issues with a started or paused label (GitHub), so a pull request can join
an issue it does not return, for example one parked with the label and moved to
Backlog. For a project with `ignore_label` the plugin then asks the issue source
whether any candidate issue of the pull request carries the label: the issue it
joined to, the issue its branch names, every closing reference (GitHub) and every
issue it is attached to (Linear), archived issues and issues of other teams
included (batched by `[linear] page_size` or `[github] issue_page_size`; nothing
is asked otherwise). When that lookup, the
issue source or `github` fails, a row that may be parked is `unknown`, offers no
action (`attach` included), is refused by `do` and is not notified by `watch`.

The result is one table with a derived `on_turn` column, a set of named
actions (`implement`, `babysit`, `fix-ci`, `rebase`, `review`, `ready`,
`attach`) shared by the CLI, rofi, notifications and an agent skill (merging
stays manual),
and a path toward a managing agent that runs those actions for the owner under
an explicit policy.

## Status

M0 and M1 are merged: `pohunek-work list` and `doctor`. M2a and M2b are in
progress (see [docs/m2-implementation-plan.md](docs/m2-implementation-plan.md)):

- `pohunek-work tui` opens the full-screen Ink interface. Work lists items from
  the plugin's public CLI output and hands actions to `pohunek-work do`.
  Sessions, Hosts and Activity use public `pohunek --json` commands. Press
  `1`–`4`, left/right arrows, or click a tab to switch views. Up/down arrows select a row; Enter or a
  click opens its detail in every view, and Esc returns to the list. Opening a
  Work item shows its next action and available choices before anything runs;
  click an action or select it with arrows and press Enter to preview its plan,
  then choose Run to execute it. Opening a notification keeps
  its message visible and offers an explicit Open session action. Use the wheel
  to move through lists and click labeled actions in each detail. Press `?` for
  the available keys. The Work view supports
  `m` (mine/all), `f` (actor), `P` (project), `/` (search) and `h` (hide stale
  pull requests). Session detail exposes attach, resume, fork, stop, remove,
  rename, metadata, screen, work link, folder and copy actions. Activity has
  Recent, Unread and Archived scopes. Partial host failures are shown in the
  interface and block writes on affected hosts;
- `pohunek-work new-session` opens the session form alone, then attaches in the
  same terminal. In the main TUI, `n` opens that form and `a` in Sessions opens
  the Assistant form. Click a field or use Tab to change focus; click a visible
  choice to select it, use the wheel to browse longer choice lists, or use
  arrows to change a host, project, agent or action template. Clicking the
  focused field again leaves its value intact. Click Create and attach or focus it and
  press Enter. The Assistant
  currently supports intent-only launch: the core CLI exposes a free-form
  request only as a process argument, so the form does not send private request
  text through it. Esc cancels before creation; after creation, Enter retries
  attach without creating another session;
- `pohunek-work do <key> <implement|babysit|fix-ci|rebase|review> [--dry-run]`
  launches a linked session; `implement` also launches a `github-issue:` row: the
  branch is `<branch_prefix>/<issue_number_prefix><n>/<slug>` (the project's
  `branch_pattern` has to capture `<n>` from it) and the prompt carries the issue
  title and body, cut to `[actions] issue_body_max_length` characters, inside an
  untrusted-data block (both keys are required, `issue_number_prefix` may be empty);
  after `session new`, `do` waits up to the required `[actions] prompt_delivery_timeout_ms`
  (1..8000) for the session to become working and otherwise fails as `launch_unverified`
  naming the session (read its screen; the owner decides on removal); a failed `post-create`
  setup hook of core (host-global `~/.config/pohunek/hooks/post-create` or in-repo
  `.pohunek/hooks/post-create`, no plugin key; example for `keboola/connection` in
  [docs/rfc.md](docs/rfc.md) 10.1) makes `do` fail as `setup_failed` with the hook's message and
  detail, the session left running for the owner to remove; `review` starts in a fresh worktree of the pull
  request head and checks the checked-out commit after the launch; `babysit`, `fix-ci` and
  `rebase` start in the worktree of a linked session, or adopt the pull request's own head branch
  in a fresh worktree when none owns one (RFC 7.5). When the branch is already
  checked out, `do` refuses (`precondition_failed`, or `already_running` for a live
  session) and the message diagnoses the holder without changing anything: attach
  for a live session, a release command only when every `cleanup` check passes, the
  failed checks and the dirty or untracked entries (at most `[actions]
  holder_entries_listed`, each string cut at `holder_entry_max_length`; both
  required) otherwise, and "switch that checkout yourself" for a holder no pohunek
  session owns ([docs/watch-and-agents.md](docs/watch-and-agents.md#a-branch-that-is-already-checked-out));
- `pohunek-work do <key> ready [--dry-run]` runs `gh pr ready` on the owner's
  draft and re-reads the pull request to confirm it is no longer a draft;
- `pohunek-work do <key> attach` attaches the terminal to the one live linked
  session;
- `pohunek-work do <key> cleanup [--project <label>] [--include-ignored] [--dry-run] [--yes] [--json]`
  removes a finished session and its worktree; a row marked ignored (`ignore_label`) is refused without `--include-ignored`. `--dry-run` reads only, except for a `git fetch` of the configured remote into the remote-tracking ref of the session's repository (no work files; git may also run auto-maintenance in the repository); it prints the inventory
  (ignored entries that would be lost, ahead/behind, diff base and size, sessions
  sharing the worktree, the `session stop` and `session rm` argv) and the result
  of every check, and exits 0 even when a check fails. A real run needs `--yes`
  (no interactive prompt), refuses with `precondition_failed` naming every failed
  check and removes nothing; otherwise it re-reads the session first (a `working`
  or `blocked` session is refused with `precondition_failed`, nothing stopped),
  stops it, re-runs the checks, refuses when the sessions sharing the worktree
  changed since the evidence, runs the project's `[teardown]` command in the worktree
  (after a session-list recheck, and followed by every check again;a nonzero exit, a start failure or `timeout_ms` exceeded refuses with `command_failed`
  or `command_timed_out`; the session stays stopped and nothing is removed; `--dry-run`
  only shows it, `plan.teardown_argv`; `result.teardown_ran` reports the run), runs `session rm` (never
  `--accept-unconfirmed-cleanup`) and re-reads `session list`. An `rm` result
  with `removed=false` or failed worktrees is `command_unverified`: the session
  may be gone, check `pohunek session list` and the disk. It needs the `[actions]` keys `git_bin` (absolute path),
  `git_timeout_ms`, `cleanup_remote` (one safe ref segment) and
  `cleanup_timeout_ms`; `list` does not advertise it. Checks, JSON shape and
  refusal codes: [docs/watch-and-agents.md](docs/watch-and-agents.md#finished-sessions)
  and [docs/rfc.md](docs/rfc.md);
- `pohunek-work setup [scripts|config|sway] [--force] [--json]` installs the
  rofi/sway launcher scripts, the starter `launcher.conf` and prompt templates,
  and the sway drop-in from `launchers/` into the per-user XDG locations (the
  issue picker binding needs `--issue-project <p> --issue-source <linear|github>`;
  for GitHub it runs `pohunek-work list` and `pohunek-work do <key> implement`);
  `pohunek-work doctor` reports the launcher requirements (rofi, swaymsg,
  python3, terminal, installed scripts, sway include, and `pohunek_work_bin` for a
  GitHub issue project) as advisory `warn` lines
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

## Terminal setup

The required `[tui]` table in `config.toml` controls `self_bin`, refresh and
list timeouts, initial Work view, stale pull-request days, URL opener and allowed
hosts. `clipboard_command` is optional and must be an absolute executable
path; without it, the TUI displays branch and path text for manual selection.
The new session form calls the public core CLI with prompt text on stdin. Core
and the plugin binary must be installed separately. The plugin release archive
starts with `bun plugin/pohunek-work.js`.

On Sway, `pohunek-work setup sway` installs `$mod+n` for the standalone form
through `pohunek-new-session`, using `terminal` and `pohunek_work_bin` from
`launcher.conf`. Change the binding with `--new-session-keybind`. Run
`pohunek-work setup scripts --force` after an upgrade to install the launcher.
See [the launcher guide](../launchers/docs/launcher.md) and
[the native-to-TUI plan](docs/native-to-tui-plan.md) for the interaction model.

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
  this repository (`web/`) additionally speaks the public protocol
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
| [docs/work-overview.html](docs/work-overview.html) | Historical visual summary from September 2026 (open in a browser) |

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
- The Linear token's keyring service and the list of ignored CI checks for
  connection are configured for each installation.

## Related repositories

- [`zajca/pohunek`](https://github.com/zajca/pohunek) — the agent session
  manager this plugin extends.
- `zajca/machine-management` — plugin configuration, installer, systemd user
  unit, `/work` and `post-merge` skills (`clients/zajca/pohunek-work/`,
  `clients/zajca/skills/`).
