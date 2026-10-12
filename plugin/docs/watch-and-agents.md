# Using `watch` and driving pohunek work from an agent

This guide covers two things: getting a desktop notification when a work item
becomes your turn (`pohunek-work watch`), and where the rules for a coding agent
that operates pohunek work come from. The rules themselves are in the
[manager guide](../prompts/manager-guide.md), which
`pohunek-work manager guide` prints.

## `pohunek-work watch`

`watch` polls the same pipeline as `list` (Linear, GitHub and the pohunek
daemon) every `[watch] poll_interval_secs` and sends one desktop notification
through `[notify] command` for each row that becomes the owner's turn.

```bash
pohunek-work watch                      # every configured project
pohunek-work watch --project widgets    # one pohunek project label
pohunek-work watch --project widgets --project gadgets   # several labels
```

Labels with no project file are rejected at start, all of them named in one
error (`unknown_project`, exit 2).
A project that is configured but skipped at run time (not registered in
pohunek, origin mismatch) is logged as `watch_warning` on every poll.

It prints one line to stderr when it starts and nothing else. Stop it with
`SIGINT` or `SIGTERM`; it exits 0. A signal during a poll sends no further
notifications; the one already running finishes or hits `timeout_ms`.

### Configuration

Both tables are required in `config.toml`:

```toml
[watch]
poll_interval_secs = 300   # pause between polls; at most 2147483 (timer limit)

[notify]
command = "/usr/bin/notify-send"   # absolute path
timeout_ms = 5000                  # the command is killed after this; at most 2147483647
```

Every poll runs the full `list` fetch, so the interval is also the GitHub and
Linear request rate. Choose it with the API budget in mind.

### What is notified

- One notification per row that changes to `on_turn.actor == "me"`.
- The text carries the key, the project and the reason, for example
  `your turn: github:acme/widgets#12` / `widgets: <reason>`. Issue and pull
  request titles are never included: they are provider text and a notification
  daemon may interpret markup in them.
- The text is reduced to ASCII before it reaches the command.

### What is not notified

- **The first poll and every restart.** The previous turn of each row is kept in
  memory only. Rows already on your turn when `watch` starts produce nothing.
- **Polls with an unavailable source.** Until one poll saw every source answer
  there is no baseline, so an outage at start and its recovery do not notify.
  After the baseline exists, a row whose turn is `unknown` during an outage is
  not marked when it comes back.
- **A repeated state.** A row that stays on your turn notifies once.
- **Ignored rows.** A row whose pull request or joined issue carries the
  project's `ignore_label` is never notified and never enters the baseline. When
  the label is removed while the row is on your turn, the row is new to the
  baseline and notifies once, like a row that first appears on your turn.
- **Rows whose label cannot be read.** When the issue source or `github` is
  down, a row that may be parked is `unknown` with no actions and is not
  notified. `unknown` rows never update the baseline, so such a row notifies
  after recovery only when the baseline rules above say so.
- A failing notification command is logged (`watch_notify_failed`) and is not
  retried on the next poll.

### Running it

`pohunek` refuses to answer when only one of `POHUNEK_SESSION_ID` and
`POHUNEK_DAEMON_ID` is set; every poll then reports `pohunek: origin_environment`
and `watch` never gets a baseline. A session started by core 0.34.2 or later
carries both, so `watch` runs unchanged inside it; an older core sets only
`POHUNEK_SESSION_ID`, so there start `watch` from a normal terminal or a service.
Never unset just one of the two.

Run `pohunek-work doctor` first; it must pass the `pohunek` and `github auth`
checks.

A systemd user service is not shipped yet. Until it is, run `watch` in a
terminal multiplexer pane or from your session start-up. A user unit must
import the graphical session environment (`DBUS_SESSION_BUS_ADDRESS`,
`XDG_RUNTIME_DIR`), otherwise `notify-send` has no bus to talk to; this is
unverified (spike S6 in [m2-implementation-plan.md](m2-implementation-plan.md)).

### Logs

JSON lines in `$POHUNEK_WORK_STATE_DIR/logs/watch.log`
(default `~/.local/state/pohunek/plugins/work/logs/watch.log`):

| Event | Meaning |
| --- | --- |
| `watch_start`, `watch_stop` | process lifecycle |
| `watch_tick` | one poll: `rows`, `notify` (count), `complete` (every source answered), `baselined` |
| `watch_notified` | a notification was delivered (`key`, `project`, `reason`) |
| `watch_notify_failed` | the command failed, timed out or could not start |
| `watch_tick_failed` | a poll threw; the loop continues with the next one |
| `watch_warning` | a project was left out of the poll (not registered in pohunek, origin mismatch) |
| `source_failed` | a source did not answer (`pohunek`, `github` or `linear` plus a code) |

Quick checks:

```bash
tail -f ~/.local/state/pohunek/plugins/work/logs/watch.log | jq -c .
jq -c 'select(.event=="watch_tick")' ~/.local/state/pohunek/plugins/work/logs/watch.log | tail
```

A healthy idle run shows `complete: true`, `baselined: true`, `notify: 0`.

## Driving pohunek work from an agent

The rules for an agent that drives pohunek work (the "manager") are in the
[manager guide](../prompts/manager-guide.md). The program embeds it and
`pohunek-work manager guide` prints it, so an agent reads the rules from an
installed binary without a source tree.

### Where the manager prompt comes from

No file in this repository holds the prompt of a manager session, and
`~/.config/pohunek/prompts` holds only core's `issue.tmpl` and `pr.tmpl`. Today the owner starts the manager by hand, for example
`pohunek session new --agent claude --project <p> --meta work.role=manager
--input <prompt>`. That prompt must tell the agent to run
`pohunek-work manager guide` and must not restate its rules, so the two cannot
contradict each other. The prompts that `do` sends to the sessions it launches
are different: they live in `plugin/prompts/*.tmpl`.

[#81](https://github.com/zajca/pohunek-work/issues/81) will generate the manager
start from a `pohunek-work` action; that prompt must point at the guide the
same way.

### Why there is no skill

The guidance is not shipped as a skill in this repository. A skill would be a
second copy that drifts from the guide, and no packaging path exists before
the plugin manifest ([zajca/pohunek#148](https://github.com/zajca/pohunek/issues/148)).
The guide ships inside the program instead, printed by
`pohunek-work manager guide`. Core's `pohunek agent-skill` already teaches the
CLI rules the guide builds on (target exactly, prefer `--json`, defer
destructive actions and approvals to the owner). Revisit when the manifest can
declare it.
