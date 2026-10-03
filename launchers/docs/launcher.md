---
type: Guide
id: guide/launcher
title: Launcher setup
description: Install and verify the local launcher scripts, config, and sway keybindings.
source_kind: manual
intents: [setup, debug, help]
---

# Launcher Setup

The launcher integration is local filesystem setup. `pohunek-work setup` writes
the launcher scripts, default configuration, and an optional sway drop-in; the
files come from this repository's `launchers/` directory and are embedded in the
`pohunek-work` binary, so a compiled binary needs no source tree. The scripts
call the `pohunek` CLI (`session`, `project action`, `prompt render`,
`prompt link`, `host discover`, `attach`), which must be installed separately.

Install locations follow the XDG rules of `pohunek`: `XDG_DATA_HOME` (default
`$HOME/.local/share`) holds `pohunek/bin/` with the scripts, `XDG_CONFIG_HOME`
(default `$HOME/.config`) holds `pohunek/launcher.conf`, `pohunek/prompts/` and
the sway config at `sway/`. A set XDG variable must be an absolute path without
`..` components; without an XDG variable and `HOME` the command fails instead of
guessing.

The rofi/sway launcher is a Linux capability. On macOS `pohunek-work setup`
writes only the config and templates and reports the scripts and the sway
drop-in as skipped, `pohunek-work setup sway` succeeds without writing anything,
and `pohunek-work doctor` checks only the terminal. The optional `terminal=` key
in `launcher.conf` is still read: on macOS `pohunek-work doctor` checks that the
whole value resolves to one executable (the launcher runs it as a single program
name, so a value with arguments such as `kitty -e` is reported; use a wrapper
script).

Use the split setup commands when diagnosing or applying changes:

1. `pohunek-work setup scripts` installs the launcher scripts into the data
   directory bin path.
2. `pohunek-work setup config` writes default launcher configuration and prompt
   templates (`issue.tmpl`, `pr.tmpl`, `review.tmpl`). `issue.tmpl` and
   `pr.tmpl` are the host-level prompt templates the pohunek daemon falls back to
   when a project action names a template without an in-repo copy; `review.tmpl`
   is GUI-only: the native GUI reads and renders it directly to build a
   review-dispatch session's prompt.
3. `pohunek-work setup sway` writes the sway drop-in, or
   `pohunek-work setup sway --print` prints the snippet for manual review.
   `--keybind` and `--issue-keybind` choose the keys (defaults `$mod+p` for the
   session switcher and `$mod+i` for the Linear issue picker).

`pohunek-work setup` with no subcommand runs all three (scripts and drop-in on
Linux, config only on macOS) and prints the next steps. Every command accepts
`--json`, which prints one envelope (`cli_version`, `protocol`, `ok`) per
invocation; with `sway --print --json` the snippet is part of the payload.

An existing file is never replaced without `--force`. A file whose content (and,
for scripts, mode) already matches is reported as `unchanged`; a file that
differs is reported as `skipped` and left alone, so a local edit survives a
re-run. After upgrading `pohunek-work`, run `pohunek-work setup scripts --force`
to replace the installed scripts (with `--force` the obsolete
`pohunek-session-banner` script is removed as well), and
`pohunek-work setup config --force` only when the defaults should replace your
edits. `--force` replaces a file through a rename, so a symbolic link at the
target is replaced and its referent is not written.

The `$mod+i` binding starts `pohunek-rofi-issue`, which takes a project argument
(`pohunek-rofi-issue <project> [action]`); edit the generated drop-in or bind a
wrapper that supplies it.

Verify the result with `pohunek-work doctor`. Besides its configuration, pohunek,
GitHub and Linear checks it reports the launcher requirements as `warn` lines
that never change the exit code: `bin:rofi`, `bin:swaymsg`, `bin:python3` (every
script needs it), `terminal` (`terminal=` in `launcher.conf` or `$TERMINAL`),
`launcher_scripts` (is `pohunek-rofi` installed) and `sway_include` (does the
sway config include `config.d`). When the install directories cannot be derived
from the environment a single `launcher_paths` warning replaces the path-based
checks.

After setup, verify daemon health and project/action resolution before blaming
the launcher UI. The launcher ultimately depends on the same daemon, project,
session, and action surfaces the `pohunek` CLI documents (sessions and
projects).

`pohunek attach` itself belongs to the `pohunek` CLI; it reads the attach keys of
`launcher.conf` from the same config directory. Attach uses raw terminal
passthrough by default, preserving the terminal's
native scrollback. Ctrl-\ temporarily freezes the visible agent screen and opens
a session menu together with a one-row status banner. The menu owns kill
confirmation (`k` then `y`), detach (`d`), new session in the same worktree
(`n`), fork (`f`), and rename (`r`). Agent output received while the menu is
open is buffered; closing the menu restores the frozen screen, replays that raw
output, and resumes passthrough without losing terminal modes or scroll margins.
The rofi/sway switcher only opens marked attach terminals; it does not create a
separate banner window. There are no banner settings in `launcher.conf`.

Whenever an attach attempt ends — detach, session stop, typed failure,
unexpected EOF, or reconnect — the CLI restores normal terminal output modes
after replaying any buffered menu output. This disables mouse and focus
reporting, bracketed paste, alternate-screen state, and TUI cursor/scroll modes
before returning control to the parent shell.

Attach terminals automatically retry after an unexpected daemon stream close.
`attach_reconnect_seconds` controls the retry window, and
`attach_reconnect_interval_seconds` controls the minimum delay between attempts.
`attach_reconnect_max_attempts` caps consecutive attempts within that window,
including failures where inspect still reports a running session. The
replacement daemon reconciles with the existing per-session worker, so Codex,
Claude, Hermes, and plain shell sessions retain the same PTY, child PID, and
runtime id. A typed worker-stream failure is surfaced once and is not retried. A
lost worker cannot be reconstructed by retrying attach; inspect `runtime.state`
and use explicit native recovery only when supported. Set
`attach_reconnect_seconds=0` to disable retry behavior.

## Work-item Links

`pohunek-launch-issue` and `pohunek-launch-pr` render the action's prompt with
`pohunek prompt render` (the same shared renderer the GUI uses), then build the
session-link metadata with a sibling client-side subcommand, `pohunek prompt link --provider <linear_issue|github_pr>
--item-id <id> --url <url>`, reading the same provider JSON from stdin. It
derives `link.branch` from the provider JSON and prints the five canonical
`link.provider`/`link.kind`/`link.id`/`link.url`/`link.branch` lines. Neither
subcommand talks to the daemon.

`launchers/lib.sh`'s `pohunek_link_meta` helper wraps that call, and
`pohunek_run_session_new` forwards each line as a repeated `session new --meta
key=value` flag, so the link is written atomically in the same `session.new`
call that starts the agent — never as a separate post-launch step. Because
both surfaces build the metadata from the one shared implementation, a link
written by a launch script is byte-identical to one written by the GUI for the
same work item; the native GUI follows the same convention.
