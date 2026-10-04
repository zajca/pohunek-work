# pohunek-work TUI: Plan

- **Status:** T0 to T4 implemented (2026-10-02); T5 waits for M2c. Open questions decided (section 11). **Builds on:** [`rfc.md`](rfc.md) sections 9, 10, 14; [`m2-implementation-plan.md`](m2-implementation-plan.md)
  sections 2a (D8-D15), 4 (rules of every write action), 5 (M2b, M2c).
- **Constraints:** no change in `zajca/pohunek`, installed pohunek CLI only; no new state (memory only).

## 1. Goals and non-goals

**Goals:** (1) a full-screen terminal view of every work item and its `on_turn`, opening on the owner's rows
and refreshing itself; (2) run the row's action (`implement`, `babysit`, `fix-ci`, `rebase`, `review`,
`ready`) with the exact argv confirmed in the process that runs it; (3) attach to a linked agent session and
return to a refreshed view; (4) `unknown`/partial data, refusals and errors are as visible as data.

**Non-goals:** `merge` (never offered; rule 7/9 rows say "manual on GitHub", D10); desktop notifications
(`watch` owns `notify-send`, c.2); persisted cache, history or "seen" markers; a `--profile` override (D8);
mouse, colors, Unicode output; replacing rofi (global hotkey), `/work` (agent) or `watch` (notifier).

## 2. User stories (daily loop)

| # | As the owner I want to ... | Served by |
| --- | --- | --- |
| U1 | open `pohunek-work tui` and see my-turn rows first, with reason and rule | `mine` view, detail pane |
| U2 | see at once when data is partial or a row is `unknown`, so a dead source never looks like "nothing to do" | partial banner, hidden-unknown counter |
| U3 | preview what an action would run (argv, branch, prompt) without running it | `p` = `do --dry-run --json` |
| U4 | run the row's action, confirming the exact argv before anything is written | Enter = handover to `do` |
| U5 | attach to the agent waiting for me (rule 1), answer, press Ctrl-], land back refreshed | `t` = handover to `do attach` |
| U6 | notice rows that became mine while the TUI is open | `*` marker, optional terminal bell |
| U7 | narrow the view by project, actor or text; open the PR/issue for manual steps (merge, request review) | `P`, `f`, `/`; `o` |

## 3. Technology decision

The UI is a fixed layout: header, scrolling rows, a detail pane, a status line and one overlay. All text is
reduced to printable ASCII (section 6), so every character is one column wide and layout is easy. The hard
part is handing the terminal to a child (attach, `do` prompts) and taking it back.

| Criterion | A: in-house driver | B: OpenTUI core (imperative, no React) | C: Ink 7 (React) |
| --- | --- | --- | --- |
| Status 2026-10 | n/a | 0.5.14 (2026-09-30), pre-1.0, several releases a week | 7.1.1 (2026-07-16), stable |
| Bun | Bun stdin/stdout only | Bun-first (`engines.bun >=1.3`) | `engines` lists Node >=22 only; runs on Bun, Bun-specific issues reported |
| `bun build --compile` | trivial | documented, embeds the native library | pure JS, works |
| Footprint (measured) | 0 runtime deps, as the repo today | 11 packages, `libopentui.so` ~6 MB per libc (Zig via FFI), `web-tree-sitter` peer | 38 packages incl. React, yoga-layout; JSX in tsconfig |
| Handover | own suspend/resume (T0 spike) | `renderer.suspend()` / `resume()` | `suspendTerminal()` |
| Tests | pure golden frames, fake TTY streams | `createTestRenderer`, `mockInput`, `captureCharFrame` | `ink-testing-library` 4.0.0, last release 2024-05 |

A Go (Bubble Tea v2.0.10) or Rust (ratatui 0.30) binary was rejected. It brings a second toolchain and a
second binary, and it cannot share the types in `src/types/item.ts`, so the contract would be copied by hand.

**Recommendation: A, with B as the named fallback.**

- **Security first.** A long-running process that renders untrusted provider text should not load a 6 MB
  native library that changes several times a week. The plugin keeps zero runtime dependencies.
- **No framework is needed.** ASCII-only output needs no grapheme or width handling, there is no flexbox or
  mouse, and a full redraw per event is cheap.
- **Testable.** The view is a pure `(state, size) -> Frame`, so golden frames need no library test renderer.
- **Reversible.** Only `terminal.ts` depends on the renderer. If T0 finds key decoding or handover
  unreliable in the owner's terminal, it is swapped for an OpenTUI core adapter pinned exactly
  (`"@opentui/core": "0.5.14"`); model, reducer and view stay.

## 4. Architecture

### 4.1 Process model: the TUI only consumes the contract

`pohunek-work tui` is a subcommand of `src/main.ts`, so it ships in whatever build `pohunek-work` uses. It
runs `list --json` and `do ...` as **child processes of `[tui] self_bin`**. It never imports the pipeline
(`commands/list.ts`, `sources/*`, `actions/launch.ts`).

**Gains:** no credentials in the long-running process (`gh auth token` and the keyring read happen only in
short-lived children); one versioned contract (list v1, do v1) shared with rofi and `/work` and exercised
daily; the existing per-command JSON logs cover every child; plan reviewed = plan run, because `do`
confirms in the process that executes (M2 section 4, rule 2). **Costs:** a spawn per refresh (negligible
next to the network), a runtime envelope decoder, no in-TUI confirmation modal (4.4). **Enforcement:** an
ESLint `no-restricted-imports` rule limits `src/tui/**` to types from `types/item.ts` and
`actions/types.ts`, plus `log.ts`, `util/exec.ts`, `config/`, `paths.ts`.

| Child | argv (array, never a shell) | stdio |
| --- | --- | --- |
| refresh | `[self_bin, "list", "--json"]` | piped via `util/exec.ts`, `list_timeout_ms` |
| preview | `[self_bin, "do", key, action, "--project", project, "--dry-run", "--json"]` | piped, `list_timeout_ms` |
| write | `[self_bin, "do", key, action, "--project", project, "--json"]` | stdin, stderr inherited; stdout piped |
| attach | `[self_bin, "do", key, "attach", "--project", project]` | all inherited |

**Rules:**

- **No `--mine` or `--project` for `list`.** Filters are client-side, so toggling one needs no refetch.
- **`do` always gets `--project`.** Without it, `resolveRow` refuses with `ambiguous_item`.
- **Read `list` stderr even under `--json`.** It carries warnings and `source unavailable:` lines. Keep
  at most `stderr_max_lines`, sanitized and shown.
- **Exit 3 still parses stdout.**

### 4.2 Modules

```text
src/commands/tui.ts   wiring: config, logger, terminal, refresh timer
src/tui/model.ts      State, Event, update(state, event) -> [State, Effect[]] (pure)
src/tui/view.ts       view(state, size) -> Frame (readonly SafeText[]) (pure)
src/tui/safe.ts       toSafe(): the only constructor of the branded SafeText type; decode.ts: envelope checks
src/tui/children.ts   runList and preview (piped); handover (foreground spawn, 4.4)
src/tui/actions.ts    action allowlist, key/project validation, argv builders
src/tui/terminal.ts   raw mode, alternate screen, key decoding, SIGWINCH, suspend/resume, restore
```

### 4.3 Refresh model and sharing with `watch`

**Refresh** is single-flight (at most one `list` child). A run starts on the timer
(`refresh_interval_secs` after the previous run ends), on `r` (ignored with a note while one is in flight)
and after every handover. A failed or timed-out run keeps the last good data, shown with its age and
`STALE` after `stale_after_secs`.

**Sharing with `watch`:** no shared cache (that would be new state), so both poll independently (R2). c.2
should write its transition detection as a pure exported function over `ListItem[]` (e.g.
`transitionsToMe(prev, next)`); the TUI reuses it for the `*` marker and, like `watch`, re-baselines at
start. Event-driven refresh (`pohunek notifications watch --json`) waits for S4 and the c.2 event source (T5).

### 4.4 Handover: `do` confirmations and `attach`

**The TUI never confirms a write; `do` does.** A TUI modal fed by `--dry-run` and then a `--yes` run would
execute a plan rebuilt from fresh data, which breaks M2 section 4, rule 2. The dry-run is only the read-only
preview `p`.

Handover sequence (`children.ts`):

1. Suspend: stop reading stdin, raw mode off, cursor on, leave the alternate screen.
2. Install a no-op SIGINT handler, because Ctrl-C at `do`'s y/N prompt hits the whole foreground group.
3. Spawn the child **in the TUI's own process group**. `util/exec.ts` cannot be used: its
   `detached: true` makes a background group, which gets SIGTTIN on TTY reads.
4. Await exit, remove the handler, drain stray stdin bytes; after a write child or a non-zero exit print
   `press Enter to return` (a clean attach detach returns directly).
5. Resume: alternate screen, raw mode, full redraw, refresh.

**Write children.** The write child prints its plan (action, key, profile, branch or cwd, the `command:`
argv, the prompt) and asks `[y/N]` itself. From its `do --json` stdout, success goes to the status line, a
typed refusal (`RefusalCode`, exit 2) to the detail pane, and `confirmation_required` after "N" shows as
"cancelled". A child killed by a signal (Ctrl-C after `y`: `do`'s detached `session new` may survive) or
without a decodable envelope shows "interrupted, outcome unknown: check `pohunek session list`", then refreshes.

**Requirements on M2b, both met without a contract change:** (1) `do <key> attach` runs `pohunek attach <id>`
through `execInteractive` with all three stdio streams inherited, in the same process group, and reports by exit
code (0 after a detach, 2 with the refusal on stderr); `tests/util/exec.test.ts` drives a grandchild through it.
(2) Every `do --json` ok payload carries the action at `ok.plan.action` and, after a run, a per-action `result`
(`dry_run: true` has none; attach outside a dry run prints no JSON). The TUI decodes it by `DO_CONTRACT_VERSION`
and refuses an unknown version; `tests/tui/do-contract.test.ts` decodes real `runDo` output.

### 4.5 Actions per row

`list --json` fills `ListItem.actions` (`rowActions` in `src/output/list.ts`): r3 `review`, r4 `babysit`, r5
`fix-ci` (failed check) or `rebase` (conflict), r6 `ready`, r8 `implement`, r7 and r9 none (manual), and
`attach` last on every row with a live linked session, which covers r1 and r11 (a row without one gets no
`attach`, because `do` would refuse it). `babysit`, `fix-ci` and `rebase` start in the worktree of a linked
session, so they are listed only when a linked session owns one (`do` refuses with `no_worktree` otherwise);
the row keeps its `on_turn` reason. `merge` is never listed. Every action carries `delegable: false`
(empty policy); launch actions carry the `profile` `do` would use (project `[profiles]` replacing the global
table), omitted when none is configured. One implementation serves the TUI, rofi (c.4) and `/work` (c.5);
`do` stays the authority and can still refuse.

The TUI checks independently:

- **Fixed allowlist:** `implement`, `babysit`, `fix-ci`, `rebase`, `review`, `ready`, `attach`. Anything
  else, **including `merge` if the contract ever lists it**, is "unsupported" and not executable.
- **Key shape:** `^(linear:[A-Z][A-Z0-9]*-[0-9]+|github:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]+)$`.
- **Project shape:** `^[A-Za-z0-9][A-Za-z0-9_.-]*$`.

`parseArgs` with `strict: true` would read a leading `-` as an option, so a mismatch is refused in the TUI.

### 4.6 Screen, data display and keys

**Rows:** `*`, KEY, PROJECT (with more than one project), TURN (`me: respond (r4)`), PR, REVIEW, CHECKS,
SESSIONS, TITLE (truncated); sorted `me`, `unknown`, `agent`, `reviewer`, `paused`, then key. **Header:** counts per
actor (`paused` only when non-zero), filters, data age, `STALE`; a **partial banner** with `project: source=code` for each non-`ok`
`projects[]` entry; in the `mine` view **`N unknown rows hidden (f)`**, because an unknown row may be the
owner's turn. **Detail pane** (full screen on Tab below `detail_min_width`): `on_turn` with a one-line rule
description; issue (id, state, title, URL); PR (draft, review decision, checks, mergeable, `fix_delivered` /
`threads_answered` / `rerequested`); sessions (id, name, role, state, activity); actions with the primary
marked; the row's `sources`; the last preview, refusal or child stderr. `s` shows `orphaned_sessions` and
`unlinked_sessions`.

| Key | Effect | Key | Effect |
| --- | --- | --- | --- |
| `j`/`k`, Down/Up | move | `g`/`G`, PgUp/PgDn | jump / page |
| Enter | primary action (handover to `do`) | `a` | choose among the row's actions |
| `p` | preview (`--dry-run`) into the detail pane | `t` | attach (only when listed) |
| `o` | open PR or issue URL | `r` | refresh now |
| `m` | toggle mine / all | `f` | actor filter: all, me, agent, reviewer, paused, unknown |
| `P` | cycle project filter | `/` | text filter on key and title; Esc clears |
| `s` | sessions view | Tab | detail pane focus / full screen |
| `?` | help | `q`, Ctrl-C | quit (outside a handover) |

### 4.7 Empty and error states

| State | Shown | Last good data |
| --- | --- | --- |
| first load | `loading...`; only `q`, `?` active | - |
| no rows / filter hides all | `no open work items (N projects polled)` / `no rows match <filter> (N hidden)` | kept |
| exit 3 (partial) | partial banner; rows render; `unknown` rows explained | kept |
| exit 2 `err` envelope (e.g. `config_invalid`) | full screen: class, code, message; `r` retries | kept, stale |
| timeout or unparsable output | status line error, logged | kept, stale |
| `protocol` range excludes v1 (a `cli_version` mismatch is only a header warning) | full screen "incompatible pohunek-work at `self_bin`", no rows | dropped (never guess) |
| terminal too small | `terminal too small` | kept |

## 5. Logging

`createLogger({command: "tui"})` writes JSON lines to the existing logs directory: `tui_start`,
`refresh_done` (`duration_ms`, `exit_code`, `items`, `source_failures`), `preview`, `handover_start` (`key`,
`action`, `argv`), `handover_end` (`exit_code`, refusal code), `open_url` (`key`, host), `terminal_restore`,
`tui_error`. Titles, bodies and child stdout are never logged; the children log themselves.

## 6. Security

- **Strict ASCII.** `toSafe()` applies NFKD, drops combining marks (Czech titles stay readable) and maps
  any other character outside 0x20-0x7E to `?`, removing ESC, OSC 8, OSC 52 (clipboard write), bidi
  overrides and zero-width characters. `view.ts` accepts only the branded `SafeText`, so titles, URLs,
  session names, `err.msg` and child stderr cannot reach a frame unsanitized. The same `toAscii`
  (`src/output/sanitize.ts`) renders the `list` table and every plan or result line `do` prints for a
  terminal, so `do`'s handover screen is strict ASCII too (Q4); the prompt sent on stdin keeps `sanitizeCell`
  (C0/C1 only), so an agent still reads diacritics.
- **No shell.** Argv arrays only. Key, project and action are validated (4.5). The prompt never passes
  through the TUI.
- **No secrets.** The TUI never calls `gh auth token` or `secret-tool`. Children inherit the environment
  unchanged, and the `log.ts` redaction applies.
- **`merge` is never executable.** The allowlist excludes it and tests pin that.
- **`o` is a new sink.** The URL must parse, use `https:` and have a host exactly in `open_url_hosts`; the
  parsed `href` goes as one argv element to `open_command`, spawned detached with stdio ignored (browser
  chatter must not reach the frame); anything else is refused and shown sanitized.
- **Terminal restore.** Raw mode off, main screen, cursor on: on exit, on an uncaught exception, and on
  SIGTERM and SIGHUP.

## 7. Configuration

`[tui]` is a new required table in `config.toml`. There are no defaults: a missing or unknown key fails at
startup with the file and key named. There are no per-project overrides.

| Key | Type | Meaning |
| --- | --- | --- |
| `self_bin` | absolute path | `pohunek-work` for children (not on PATH today; same pattern as `pohunek.bin`, `gh_bin`) |
| `refresh_interval_secs` | int > 0 | pause between the end of one refresh and the next |
| `list_timeout_ms` | int > 0 | timeout of `list` and preview children; process group killed |
| `stale_after_secs` | int > 0 | data age that shows `STALE` |
| `stale_pr_days` | int > 0 | days without a change after which `h` hides a pull request nothing runs for |
| `initial_view` | `"mine"` / `"all"` | view on start |
| `bell_on_transition` | bool | terminal bell when a row becomes `me` |
| `open_command` | absolute path | e.g. `/usr/bin/xdg-open` |
| `open_url_hosts` | non-empty string list | e.g. `["github.com", "linear.app"]` |
| `stderr_max_lines` | int > 0 | child stderr lines kept for display |
| `detail_min_width` | int > 0 | columns below which the detail pane goes full screen on Tab |

**Migration:** the loader requires every table, so `[tui]` breaks `list`, `do` and `watch` until the
installed config has it, the same as `[actions]` in M2a. T1 therefore ships with the machine-management
installer update (`clients/zajca/pohunek-work/`), and `doctor` reports the missing table.

## 8. Testing

- **Reducer:** keys, filters, selection kept by key across refreshes, stale timing with a fake clock,
  single-flight, re-baseline.
- **Golden frames** (`tests/fixtures/tui/*.txt`, from `tests/fixtures/output/list-contract.json` plus new
  fixtures): every 4.7 state at widths 80 and 160, partial banner, hidden-unknown counter, detail pane per
  rule. One test asserts that every character of every frame is in 0x20-0x7E.
- **Hostile text through `toSafe`:** ESC/CSI, OSC 8/52, U+202E, zero-width, newlines, 10 kB titles, Czech
  diacritics. Frames stay ASCII and within width.
- **Decoder:** malformed JSON, `err` envelope, protocol outside v1, `cli_version` mismatch, exit 3 with
  stderr, unknown action names.
- **Fake spawn:** exact argv per child (4.1) with `--project`; keys starting with `-` or of a bad shape
  refused; a property test over all rules and actions shows no action argv element is `merge`; a signal-killed
  write child yields "interrupted, outcome unknown".
- **Terminal driver on fake TTY streams:** enter/leave sequences, suspend/resume order, SIGINT handler only
  during a handover, restore after a thrown error, key decoding (arrows, PgUp/PgDn, lone Esc, Ctrl-C).
- **T2 contract test:** `actions` per rule, `attach` only with a live linked session, never `merge`.
- **Manual real-terminal checks** per milestone (section 9), because mocks cannot see TTY behavior.

## 9. Milestones

| # | Content | Depends on | Done when (the owner can try it) |
| --- | --- | --- | --- |
| T0 | Spike in `scripts/`: driver prototype built with `bun build --compile`, handover to `pohunek attach` on a scratch shell session; result recorded here | nothing | in the owner's sway terminal: keys decode, resize redraws, typed `y` reaches a child prompt, Ctrl-C there does not kill the TUI, Ctrl-] returns, no stray bytes, terminal restored after `kill`. Decides A or B |
| T1 | Read-only TUI: 4.1-4.3, 4.6, 4.7, logging, `[tui]` plus installer update | T0; parallel with M2b | one working day with `pohunek-work tui` instead of `list`; every 4.7 state reached once (network off gives the partial banner). **Checkpoint:** GraphQL rate-limit cost of one `list` run measured (`gh api rate_limit` before/after) and `refresh_interval_secs` derived from it with `watch` running |
| T2 | `actions` filled in `list --json` (4.5), contract fixture updated | before M2c c.4, c.5 | `pohunek-work list --json \| jq '.ok.items[] \| {key, on_turn, actions}'` matches the rule table for the current rows |
| T3 | Preview `p`, write handover (Enter, `a`), refusal display, `o` | M2b b.1, b.2 and the 4.4 result shape; T2 | one `babysit` and one `ready` from the TUI, confirmed in `do`'s prompt; effects re-checked in `pohunek session list` and on GitHub; "N" shows "cancelled" and nothing ran |
| T4 | Attach handover | M2b b.3 with the 4.4 stdio requirement | from a rule 1 row: attach, answer, Ctrl-], back in the view; after refresh the row has left `me` |
| T5 | Live refresh from pohunek events, `*` and bell via the shared transition function | M2c c.1 (S4), c.2 | a blocking agent appears as a marked `me` row within seconds; a TUI restart marks nothing |

**T0 result (2026-10-02): A stays, B is not needed.** The driver is `src/tui/terminal.ts`; the spike is
`scripts/spike-terminal.ts`, built with `bun build --compile` (Bun 1.4.2). It ran in a pseudo-terminal
(Python `pty`, 80x24, `TERM=xterm-256color`) against a throwaway `shell` session started with
`pohunek session new --agent shell --cwd <scratch dir>` (pohunek CLI 0.31.6, protocol 3), removed afterwards.
Verified there:

- Raw mode and the alternate screen on start; arrows (CSI and SS3), PgUp/PgDn, a lone Esc and plain keys
  decode; a size change redraws at the new size. Bun's `resize` event on stdout reports the new size, while
  `process.stdout.columns` read inside a `SIGWINCH` handler is still stale, so the driver uses `resize`.
- `process.stdin.pause()` stops Bun from reading fd 0, so a child spawned with inherited stdin (same process
  group, not detached) gets every byte. A typed `y` reached a `[y/N]` prompt read the same way as `do`'s
  `terminalConfirm`; the terminal was in cooked mode with echo during the handover.
- Ctrl-C at the child prompt ended the child (`signal=SIGINT`) and not the TUI (no-op SIGINT handler).
- Bytes typed at `press Enter to return` were discarded, never delivered as keys.
- `pohunek attach <id>`: typed input reached the session shell, Ctrl-] detached back into the view without
  the Enter prompt, and the next key was the only key delivered (no stray bytes).
- Terminal restored (cooked mode with echo, main screen, cursor on) after `q`, SIGTERM (exit 143), SIGHUP
  (exit 129), SIGTERM during a handover, and an uncaught exception.

**Not verified (needs the owner's sway terminal):** the real terminal emulator's key sequences (only xterm
sequences were sent), real window resizes from sway, keyboard layouts and dead keys, and how the TUI looks.
These checks are the first thing to do when T1 is deployed.

**T1-T4 pseudo-terminal check (2026-10-02).** The compiled `pohunek-work tui` ran in the same harness with a
scratch config whose `self_bin` was a script printing fixture envelopes and imitating `do`'s plan and `[y/N]`
prompt (no real item, no write). Passed: refresh, partial banner, list stderr, mine/all, text filter, sessions
view, full-screen detail at 80 columns, detail pane after a resize to 160, help; Enter with `y` (done, exact
argv, refresh after), with `n` (cancelled) and with Ctrl-C at the prompt (TUI survives, "interrupted, outcome
unknown"); a refusal in the detail pane; `p` preview; `o` (one argv element, opener output kept off the screen);
attach to the scratch shell session with typed input and Ctrl-] back without the Enter prompt; restore after
`q` and SIGTERM. **Not verified:** the T1-T4 "done when" checks against the owner's real rows (one working day,
the GraphQL cost of one `list` run, one real `babysit` and `ready`, a rule 1 attach), which need the deployed
binary and config.

**Ordering:** T0 and T1 (read-only) run alongside M2b; T2 lands before rofi (c.4) and `/work` (c.5), which
reuse it; T3 and T4 follow M2b; T5 follows c.2. From M2c the TUI reuses `watch`'s transition function and event source. Nothing comes from rofi or `/work`:
they remain separate front-ends on the same contract.

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| R1 Handover edge cases (signals, stray input, broken terminal) | T0 spike in the real terminal, restore on every exit path, driver tests |
| R2 TUI and `watch` polling together exhaust the GitHub rate limit | single-flight, interval from the T1 measurement, manual refresh, event-driven refresh in T5 |
| R3 The in-house driver grows into a framework | scope fixed by 4.6; OpenTUI adapter as fallback, core unchanged |
| R4 Contract drift between `self_bin` and the TUI build | protocol range check, full-screen refusal, never a guess; non-ASCII on `do`'s handover screen: Q4 |

## 11. Open questions for the owner

**Decided 2026-10-02: every recommended answer** (1 A, B only as the fallback, which T0 did not need; 2 the
handover; 3 yes; 4 yes; 5 `[watch] poll_interval_secs`, i.e. `refresh_interval_secs = 300` in the installed
config). Until c.2 exists, the `*` marker and the bell run on the TUI's own polls through
`transitionsToMe` in `src/tui/rows.ts`, a pure function over `ListItem[]` that `watch` can reuse (4.3).

1. **Renderer: in-house driver (A) or OpenTUI core (B) from the start?**
   *Recommended:* A, decided finally at T0, with B as the fallback.
2. **Where are writes confirmed:** `do`'s own prompt after a handover, or a TUI modal backed by a new
   `do --expect-plan <digest>` that refuses when the fresh plan differs?
   *Recommended:* the handover. It adds no contract surface and keeps the one tested confirmation path.
   Revisit if the screen switch annoys in daily use.
3. **Fill `actions` in `list --json` now (T2), before the stage E policy?**
   *Recommended:* yes, with `delegable: false` everywhere, so TUI, rofi and `/work` share one mapping.
4. **Make strict ASCII the shared sanitizer for all terminal output** (the `list` table and `do`'s plan
   text), not a TUI-only rule?
   *Recommended:* yes. Move `toSafe` next to `sanitizeCell`. The prompt on stdin stays unchanged; only its
   display is sanitized.
5. **Which refresh interval until T1 measures the cost?**
   *Recommended:* the value of `[watch] poll_interval_secs`. Lower it only if the measurement shows
   headroom with `watch` running.
