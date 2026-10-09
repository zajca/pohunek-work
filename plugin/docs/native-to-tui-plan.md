# Native GUI to `pohunek-work` TUI

Status: implementation plan for [issue #133](https://github.com/zajca/pohunek-work/issues/133). The parity baseline is the final `native/docs/gui.md` on `main` before native removal. This plan covers behavior that GUI still shipped, including the separate `pohunek-gui --new-session` window. It does not restore the older Linear, GitHub, review, worktree-management or Agents-monitor surfaces that the GUI guide explicitly excluded. The existing `pohunek-work tui` work-item view remains the default entry point.

## 1. Product shape

One terminal application has four top-level views. Work keeps the current plugin list and actions. Sessions, Hosts and Activity replace the remaining native desktop control plane. A second command, `pohunek-work new-session`, opens only the session form in a terminal window and exits after creating and attaching, or on cancellation. An Assistant form is available from the main TUI.

```text
pohunek-work  [Work] [Sessions] [Hosts] [Activity]       local connected
Needs you  3    Running  8    Ready  2    Unavailable  1

> connection  Codex awaiting approval             local · codex · 2 subagents
  pohunek    Claude working on issue #133         laptop · claude
  unassigned shell at prompt                       local · shell

Selected: connection / Codex awaiting approval
Current attention: approval required
Recent activity: agent blocked 10:42; subagent completed 10:39
Enter detail   o attach   n new session   a assistant   ? help
```

```text
New session                         project: connection @ local  [change/search]
Action/template: blank session      agent: codex
Name: [                                    ]
Prompt: [                                   ]
        [                                   ]
Advanced: branch [                 ]  base [                 ]
Tab to Create and attach; Enter confirms   Esc cancel
```

At narrow widths the detail pane becomes a full-screen detail view; the selected row and filter survive return and resize. The terminal shows one status/error line and never hides a partial host failure behind an empty list. Terminal strings originating from daemon, provider or session metadata are sanitized before rendering.

## 2. Framework decision

Use **Ink 7.1.1** with **React 19.2.4**, pinned in `plugin/package.json` and `bun.lock`. [Ink 7.1.1](https://github.com/vadimdemedes/ink/releases/tag/v7.1.1) has an alternate-screen mode and [`suspendTerminal()`](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md) to hand the terminal to `pohunek attach` or a confirmation prompt and redraw on return. [Ink 7.0](https://github.com/vadimdemedes/ink/releases/tag/v7.0.0) raised its floor to React 19.2 and Node 22; Bun compatibility and release-bundle packaging require this repository's own acceptance test. Pinning the existing 7.1 line avoids coupling the migration to the newer 8.x major release.

[OpenTUI](https://opentui.com/docs/getting-started/runtime-support/) provides richer widgets and Bun support, but its Core loads a platform-specific native package. Its [standalone executable guide](https://opentui.com/docs/reference/standalone-executables/) requires target and Linux libc selection plus matching native artifacts at build time. That adds a cross-platform packaging axis to the very migration intended to remove one. Ink is the first choice, conditional on a real PTY spike for input, resize, `suspendTerminal()`, terminal restoration, the noarch Bun JS release bundle, and macOS/Linux behavior. If that spike fails, record the failure and reassess OpenTUI with an explicit build/packaging gate; do not replace production behavior with a mocked renderer.

Keep the plugin's current data and action contracts behind a view-model boundary. The renderer should own layout, focus and keys; public CLI/SDK adapters own data, errors and lifecycle. Reuse the current `do` confirmation handover and URL validation. Avoid a second confirmation policy in React components.

## 3. Parity checklist

| Native GUI behavior at removal | TUI destination and acceptance |
| --- | --- |
| Cross-host sessions grouped as Needs you, Running, Ready and Unavailable; project chips; stable ordering | Sessions view groups and counts rows identically, filters by project, labels partial or disconnected hosts, and preserves selection across refresh. |
| Session detail, current attention, recent activity, read-only worktree path and branch | Detail view reads a fresh inspect result, shows each section and refuses actions whose capability disappeared. |
| Open, resume, stop, remove with confirmation, fork, rename and metadata editing | Detail actions use public owner contracts; stop/remove revalidate the current runtime, and remove shows the worktree consequence before confirmation. External, conflicting and incompatible sessions remain read-only. |
| Running and recent Claude/Codex subagent tree, nested by parent, plus running count on row | Show provider, type, lifecycle, activity and age; orphaned children appear at the root. Verify the public data source before implementing. |
| Work links, browser/folder opener, copy branch/path | Prefer the complete `work.link.*` set over `link.*`; validate HTTPS links and local absolute folders at action time. A remote path is copyable but never opened locally. |
| Hosts modal with connection, last error and read-only governance state | Hosts view distinguishes loading, failed, never enrolled, enrolled and quarantined. It offers no governance mutation. |
| Activity modal: Recent, Unread, Archived, newest-first; opening marks read; linked session navigation | Activity view retains all scopes, read transition and host/session navigation. Unread informational history does not enter Needs you. |
| Desktop notices for new `action_required` or `error` records | A watcher using public notification events issues notices through configured platform commands and deduplicates create/update replay. Existing work-item `watch` remains separate until a shared owner is verified. |
| New session form: project/host search, action/template, agent, name, prompt and advanced branch; creation and attach | Main TUI form implements these fields with project preselection and runtime capability validation. Submitting twice never creates two sessions. |
| Assistant form with project/host/agent and launch | TUI invokes the public `pohunek assistant` command for an intent-only request, presents its result and attaches to the created session. Free-form text needs a core CLI stdin contract before the TUI can safely send it. |
| Standalone dialog-only launch via compositor shortcut | `pohunek-work new-session` presents only the form in a terminal, creates once, attaches in that terminal, then exits. Esc before submission creates nothing. |
| Configuration errors and loss of daemon/host connectivity | Show typed actionable errors without crashing; keep last good rows marked stale and prevent writes that lack fresh evidence. |

## 4. Public contract map

The installed `pohunek` CLI exposes `session new/list/inspect/stop/fork/rm/resume/rename/metadata/screen`, `project list/actions/action`, `host discover/inspect/governance inspect`, `notifications list/watch/read/ack/archive`, `assistant` and `attach`. These commands were checked with `--help` during planning; their JSON shapes, per-host routing and error envelopes must be captured with real daemon integration fixtures before an adapter is considered complete. Session creation accepts `--project`, `--agent`, `--name`, `--branch`, `--base-branch`, `--input-stdin`, `--json` and `--host`; a remote machine path requires `--yes` on the JSON path. Avoid interpolated shell strings: pass fixed argv and initial prompt on stdin.

The existing `pohunek-work list --json` and `do` contracts continue to feed Work. Core CLI JSON supplies the new views, including subagents, metadata and host governance. Never import daemon or removed GUI internals. Verify that `pohunek assistant --json` returns a usable created-session identity before using it for attach; an unknown or timed-out result must tell the owner how to find the session instead of retrying creation. The current core CLI accepts a free-form Assistant request only as a positional process argument. The TUI therefore sends `request: null` and exposes the intent selector only until core provides a public stdin request contract.

## 5. Keys and process lifecycle

Work uses `Enter` for its first action, `a` for the action chooser, `t` to attach, `o` to open a URL, `m` to toggle mine/all, `f` to cycle actor, `P` to cycle projects, `/` to search and `h` to hide stale pull requests. Top-level view switching uses `1` Work, `2` Sessions, `3` Hosts and `4` Activity. `Tab` moves focus within the new-session and Assistant forms. In Sessions, `Enter` opens detail, `o` attaches or resumes, `n` opens New session and `a` opens Assistant. In Activity, `Enter` marks the record read and opens its linked session. `?` opens help; `Esc` closes one overlay or form; `q` quits outside a form or child handover. Resolve key collisions by view rather than changing existing Work keys.

When `pohunek attach` owns the terminal, Ink must suspend input and output, restore normal modes for the child, then redraw on return. Ctrl-C during the child must not kill the parent TUI. On process exit or signal, restore alternate-screen, cursor and raw-mode state. The CLI is authoritative for session lifetime; exiting either TUI process never stops a session.

The standalone Sway binding `$mod+n` runs `pohunek-new-session`, which starts a terminal with `pohunek-work new-session`. `launcher.conf` chooses `terminal` and `pohunek_work_bin`; `setup sway --new-session-keybind` changes the key. The form opens with project search focused. On successful `session new`, store the returned host/id before calling attach. If attach fails, lock creation, display that host/id and offer **Retry attach** or **Close**. A retry only calls attach; it never calls `session new` again. A launch timeout with unknown outcome prompts inspection by project/host before any retry. The dialog process does not mutate the main TUI's saved filter/selection or emit its own desktop notice.

## 6. Delivery and testable definition of done

1. **PR 1: remove native.** Delete `native/`, native CI/release/install paths and native-only packaging. Retain the common core pin in `web/core-sdk.json`. The three remaining surface gates and packaging gate pass.
2. **PR 2: TUI parity.** Add Ink and React, replace the current rendering driver, add Sessions, Hosts, Activity, session actions, Assistant and New session, then update launcher/README instructions. The PR is complete only when the items below pass. If the diff needs splitting, each additional PR must preserve a usable Work TUI and the final PR closes the parity DoD.

Acceptance checks for PR 2:

- Linux and macOS PTY runs verify startup, keys, Unicode paste, resize, narrow layout, child attach, child Ctrl-C, detach, and terminal restoration after normal exit and SIGTERM. The release job runs a PTY smoke check against the unpacked noarch Bun JS archive entry point.
- A real daemon integration scenario has local and discovered remote hosts, one blocked, working, idle and unavailable session, and partial host failure. Session grouping, details, host status and stale writes match the parity table.
- Real CLI/SDK boundaries cover successful and refused resume, stop, remove, fork, rename and metadata edits; changed state between display and action refuses the write. No action on an external/conflicting/incompatible runtime mutates the daemon.
- Notification lifecycle tests cover Recent/Unread/Archived, read-on-open, replay deduplication, unresolved attention and quiet history.
- New session and Assistant tests cover local and remote projects, template and blank launches, unsupported agent, canceled form, launch failure, attach failure, and unknown creation outcome. A created session is never silently duplicated or hidden.
- `plugin` lint, typecheck and tests pass; launchers and packaging gates pass for touched paths. The plugin release archive starts the TUI and standalone command on supported platforms without a source checkout.

The remaining product risk is terminal behavior in the owner's actual Linux and macOS terminals. Record those manual PTY observations alongside automated gates before claiming full parity.
