# Using `watch` and driving pohunek work from an agent

This guide covers two things: getting a desktop notification when a work item
becomes your turn (`pohunek-work watch`), and how a coding agent operates
pohunek work without its context growing or spinning while nothing changes.

## `pohunek-work watch`

`watch` polls the same pipeline as `list` (Linear, GitHub and the pohunek
daemon) every `[watch] poll_interval_secs` and sends one desktop notification
through `[notify] command` for each row that becomes the owner's turn.

```bash
pohunek-work watch                      # every configured project
pohunek-work watch --project widgets    # one pohunek project label
```

A label with no project file is rejected at start (`unknown_project`, exit 2).
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
- A failing notification command is logged (`watch_notify_failed`) and is not
  retried on the next poll.

### Running it

`pohunek` refuses to answer when the process has `POHUNEK_SESSION_ID` set
without `POHUNEK_DAEMON_ID`, which is the case inside a pohunek agent session.
Every poll then reports `pohunek: origin_environment` and `watch` never gets a
baseline. Start `watch` from a normal terminal or a service, or run it as
`env -u POHUNEK_SESSION_ID pohunek-work watch` from inside a session.

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

No skill or MCP server for pohunek work exists in this repository; the
interface for an agent is the CLI.

### Commands an agent uses

| Command | Use |
| --- | --- |
| `pohunek-work list --mine --json` | the rows where it is the owner's turn, with `on_turn`, `actions[]` (primary first), `sessions[]` and per-source status |
| `pohunek-work do <key> <action> --dry-run --json` | the plan of an action; changes nothing |
| `pohunek-work do <key> <action> --yes --json` | runs the plan after the owner confirmed it |
| `pohunek-work doctor` | setup problems; the exit code names the first failed check |

Rules for the agent:

- Run `--dry-run` first, show the plan, and add `--yes` only after the owner
  confirmed. Without a terminal a write action refuses with
  `confirmation_required`.
- Never run `merge`; it is refused (`not_supported`).
- Exit code 2 is an error: stop. Exit code 3 means `list` printed rows but at
  least one source was unavailable: rows may be missing or `unknown`, so do not
  act on absence.
- Every `do` re-reads fresh data and refuses when the row's rule no longer
  holds. The agent must not cache rows between steps.

### Keeping context flat

Nothing is stored by the plugin, so an agent never has to remember state; it
re-reads it.

1. One pass per session. The agent runs `list --mine --json`, trims it with
   `jq` to the fields it needs (`key`, `on_turn.reason`, the first
   `actions[].name`, session `state`) and leaves out titles, summarizes,
   proposes, and ends.
2. Real work happens in the sessions that `do` launches, one per action and
   worktree. The pull request is the durable result; the agent reads only the
   session `state` and the pull request, not transcripts.
3. The next pass starts in a fresh session (or after `/clear`), not in the old
   context.

### Not spinning when nothing changes

An agent should not poll. Let `watch` do the change detection and start the
agent on demand:

- `watch` is a deterministic process; an idle poll costs no model tokens.
- When it notifies, open an agent session and run one pass as above.
- Do not start an agent from a timer: an agent run without a terminal cannot
  get the owner's confirmation, so the unattended path may only notify or
  propose, never run `do --yes`.
