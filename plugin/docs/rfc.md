# RFC: Work Overview — A Pohunek Workflow Plugin Over Linear, GitHub and Agent Sessions

- **Status:** Draft
- **Date:** 2026-09-30
- **Owner:** zajca
- **Scope:** `pohunek-work`, an out-of-process pohunek workflow plugin that
  joins Linear issues, GitHub pull requests and pohunek agent sessions into
  one table, derives who is on turn for each work item, and exposes the same
  data and actions to the owner (CLI, rofi, notifications, agent skill) and to
  a managing agent. Includes the step-by-step roadmap from today's manual
  workflow to an agent that runs the workflow on the owner's behalf across
  several projects.
- **Builds on:** pohunek workflow plugins
  ([zajca/pohunek#148](https://github.com/zajca/pohunek/issues/148), project
  "Runtime plugin packages"), delegated task runs (#182), relay dark factory
  (#185)
- **Affected repositories:** `zajca/pohunek-work` (the plugin), `zajca/pohunek`
  (small generic core additions), `machine-management` (plugin configuration, skills, user units,
  Hermes), `keboola/connection` (agent skills that start work)
- **Visual summary:** [`work-overview.html`](work-overview.html)
- **Implementation plan before the next pohunek release:**
  [`implementation-plan.md`](implementation-plan.md)

## 1. Summary

Every open work item has three independent sources of state: Linear (issue
status, cycle), GitHub (draft, reviews, checks, threads) and pohunek (which
agent session runs, whether it waits for an answer). Each is correct on its
own, but none answers the question the owner asks several times a day: **who
has to act next on this item — me, an agent, or a reviewer?**

This RFC keeps the pohunek daemon generic. The daemon knows sessions,
worktrees, projects, tasks, events, notifications and opaque metadata. It
does not know Linear, GitHub, Jira or work items. Everything specific lives
in a workflow plugin as defined by #148: an external executable that calls
pohunek only through the typed CLI or SDK, receives its own config and state
directories from core, and cannot extend the daemon, the protocol, overlays or
the native GUI.

The plugin adds:

1. **One link** written at launch time: session metadata in the plugin's
   namespace (`work.link.*`, `work.role`), so every agent session is
   attributable to a work item.
2. **One derived column**, `on_turn`, computed at read time from the three
   sources by a fixed, ordered rule list (section 8). It is never persisted.
3. **One set of named actions** (`implement`, `babysit`, `fix-ci`, ...) used
   by every interface and later by a managing agent.

## 2. Motivation

### 2.1 Evidence from the connection sessions

An audit of the 255 Claude Code sessions in `~/Code/keboola/connection` over
the 45 days before 2026-09-30, of the pohunek state in
`~/.local/share/pohunek/` and of the Hermes workflows on vps2 found:

- **Status is rebuilt by hand, repeatedly.** Recurring prompts: "go through my
  open PRs, is anything waiting on me", "go through my Linear issues in the
  cycle and PRs, what do I have to do where", "go through project X, what can
  run in parallel", "review all my draft PRs". Several ran on the same projects
  on the same day (2026-09-22 and 2026-09-30 twice in parallel), individual
  sweeps took 20 to 55 user turns, and each produced a one-off table that went
  stale within hours.
- **The post-review loop does not close.** The owner repeatedly asks agents
  "why is it not pushed, answered and re-requested for review?". Nothing
  verifies the three steps independently of the agent's claim.
- **Sessions carry no link to work.** All 255 sessions report
  `gitBranch=master`; work is fanned out to subagents in worktrees without a
  trace. Every pohunek session for connection has empty `metadata` and almost
  none has a name, which leads to prompts such as "find the session where we
  solved ...".
- **Clutter accumulates.** 116 sessions have zero or one user message, the
  connection repository has 79 worktrees, and nothing removes them after merge.
- **The existing summary cannot see agents.** Hermes `pr-status` (08, 13 and
  16 h on vps2) reads only GitHub and Linear.

### 2.2 Why existing states are not enough

Most questions are answered by one field in one source (`isDraft`,
`review-requested:@me`, check conclusions, `reviewDecision`, pohunek
`activity` and `agent_blocked`, Linear state). Showing those fields side by
side covers most of the need. Two things are missing:

1. **The session-to-item link.** Without it, "an agent is working" cannot be
   attached to any issue or PR.
2. **Progress after "changes requested".** GitHub keeps `reviewDecision =
   CHANGES_REQUESTED` until the reviewer approves again. A PR where nothing
   happened and a PR where the fix was pushed, every thread answered and the
   review re-requested look identical. Telling them apart is a rule over
   several fields.

### 2.3 Why a plugin and not core

- The daemon must stay generic so pohunek can serve other trackers and code
  hosts, and other workflows, without core changes.
- #148 already defines the extension model: out-of-process, owner trust
  boundary, typed CLI/SDK, core-injected config and state directories, no
  daemon, protocol, overlay or native GUI extensions.
- Provider credentials already stay caller-side (per-project actions design,
  A.4); a plugin fetching its own provider data is the same rule.

## 3. Relationship to Existing Systems

- **Linear, GitHub and pohunek stay the sources of truth.** The plugin only
  reads them, except for the explicit actions of section 10.
- **Pohunek core stays the runtime authority** for PTYs, workers, worktrees,
  projects, tasks and host policy. The plugin is a same-UID owner process and
  uses only public owner APIs, as #148 states.
- **Per-project actions** (`project.action`, templates, prompts, agent
  profiles) remain the generic, core-owned way to resolve which agent profile
  and prompt template a launch uses. The plugin uses actions with
  `provider = "none"`, supplies the branch itself and renders the prompt
  itself, so it does not depend on core's provider kinds.
- **Existing provider coupling in core** (`ProviderKind { LinearIssue,
  GithubPr }` in `crates/protocol/src/project.rs`, providers in
  `crates/gui-core/src/providers/`, launcher scripts, `[providers.*]` in
  `gui.toml`) is moved into the plugin in step 16 of the roadmap.
- **Delegated task runs (#182)** become the execution layer in stage F.
  **Dark factory (#185)** is the target of autonomy level 3.
- **Hermes and SiYuan** stay the asynchronous summary and history.

## 4. Goals

1. One table per owner across configured projects: Linear issue, pull
   request, GitHub review and check state, linked agent session, who is on
   turn.
2. Every agent session started for a work item carries the plugin's link
   metadata, written atomically with `session.new`.
3. `on_turn` is computed deterministically at read time and covered by unit
   tests over fixtures. No derived state is persisted.
4. "Changes requested" hands the turn back to the reviewer only when the fix
   commit, the thread replies and the review re-request are verified on
   GitHub.
5. One set of named, idempotent actions is shared by every interface, human
   or agent.
6. The owner is notified only when an item transitions to the owner's turn.
7. `list --json` is a stable contract usable as input of a managing agent.
8. Adding a project is a configuration change, not a code change.
9. The pohunek daemon gains no knowledge of Linear, GitHub or work items.

## 5. Non-goals

- New workflow states in Linear or GitHub, or a database of work item state.
- Any plugin code inside the daemon or worker, new protocol methods defined by
  the plugin, or native GUI widgets (excluded by #148 for v1).
- An in-repository configuration layer for the plugin in v1 (section 11.3).
- Automatic merge, and automatic answers to agent questions or approvals.
- Estimating agent cost when the provider does not report it.

## 6. Terms

- **Work item.** A Linear issue, GitHub pull request or GitHub issue that the
  owner is assigned to, authored, or was asked to review, in a configured
  project.
- **Item key.** Project-scoped identity: `linear:DMD-2188`,
  `github-issue:keboola/connection#42`, `github:keboola/connection#8605`. A PR
  linked to an issue is shown on the issue's row.
- **Link.** Plugin-namespaced session metadata binding a session to an item
  key.
- **Role.** Purpose of a linked session: `implement`, `babysit`, `review`,
  `fix-ci`, `rebase`, `manager`.
- **On turn.** Derived actor who must act next: `me` (with a reason),
  `agent`, `reviewer`, or `unknown`; `paused` when the row's issue is in a
  configured paused state and nobody has to act.
- **Action.** A named, idempotent plugin operation on a work item.
- **Policy.** Owner configuration: which actions an agent may run without
  confirmation, with which profile, within which limits.
- **Manager.** An agent session with `role=manager` that reads the table and
  runs actions under the policy.

## 7. Joining the Sources

### 7.1 Launch-time link

The plugin launches every session for a work item itself, through
`pohunek project action <project> <action>` (agent profile and prompt
template) and `pohunek session new --branch ... --name ... --meta ...`, which
writes metadata atomically:

| Key | Example |
| --- | --- |
| `work.link.provider` | `linear` / `github` |
| `work.link.kind` | `issue` / `pull_request` |
| `work.link.id` | `DMD-2188` / `keboola/connection#8605` |
| `work.link.url` | issue or PR URL |
| `work.link.branch` | `zajca/DMD-2188/coalesce-buckets` |
| `work.role` | `implement` |

The session name is the key without the provider prefix (`DMD-2188`,
`PR-8605`; `acme/widgets#7` for a GitHub issue). Metadata values never contain secrets. Sessions launched by core's
own provider launch path with `link.*` keys are also recognized until step 16
removes that path.

`babysit`, `fix-ci` and `rebase` on a pull request whose linked sessions own no worktree launch
with `--project`, `--branch` and `--base-branch` naming the pull request's head branch and the same
metadata (7.5).

Agent skills that start work (`babysit-pr`, `ship-task`, `linear-issue` in
connection) call the plugin action instead of starting untracked subagents
from the main checkout.

### 7.2 Branch convention

Branches are `zajca/<KEY>/<slug>`; the project configuration carries the
pattern that extracts the key. A GitHub issue has a number, not a key, so its
branch is `zajca/<issue_number_prefix><n>/<slug>` with `[actions]
issue_number_prefix` (for example `issue-`, giving `zajca/issue-7/<slug>` and the
project pattern `^zajca/issue-(?P<key>[0-9]+)/`). `do` refuses with
`invalid_value` unless the project's `branch_pattern` captures exactly `<n>` from
the branch it would launch, so the session and its pull request join back to the
issue row.

### 7.3 Join precedence

For each pull request, the issue is the first match of the precedence of the
project's `issue_source`.

For `linear`:

1. `work.link.id` of a session whose `work.link.branch` equals the PR head ref;
2. a Linear attachment on the issue pointing at the PR URL;
3. the branch pattern applied to the PR head ref.

For `github` (the issue key is `<owner/name>#<number>` of the project's `repo`):

1. `work.link.id` of a session with `work.link.provider = github` and
   `work.link.kind = issue` whose `work.link.branch` equals the PR head ref and
   whose id names an issue of `repo`; a link of kind `pull_request` (or without a
   kind) carries a PR id of the same shape and never resolves to an issue;
2. the PR's `closingIssuesReferences` that point into `repo`; a PR that closes
   several issues joins the lowest-numbered one that is on the table, else the
   lowest-numbered one. GitHub fills the references only when the PR targets
   the repository's default branch, so a stacked PR (base branch other than the
   default) has none and falls through to the next level;
3. the branch pattern applied to the PR head ref, when its `key` capture is a
   decimal number `N` (resolves to `<repo>#N`); any other capture does not
   resolve.

A PR without a match is its own row flagged "no issue"; an issue without a PR
is its own row; a linked session whose key matches no row is listed as
orphaned.

Merged PRs of the owner (`merged_lookback_days` window, one search per project)
are resolved by the same precedence, but only to explain an issue's row: a
merged PR never becomes a row of its own, and it is attached only to an issue
without an open PR. When several merged PRs resolve to one issue, the most
recently merged one is kept. The merged lookup carries no closing references,
so for a `github` project a merged PR resolves by session link and branch
pattern only.

### 7.4 One worktree, one writer

A worktree is used by one live session at a time. A babysit session starts in
the implementation worktree only after the implementation session ended. The
plugin refuses a second live linked session on a worktree; with the task layer
the daemon enforces it (`task.start { worktree_of }`, task RFC invariant 11).

### 7.5 Adopting an existing pull request

`babysit`, `fix-ci` and `rebase` start in the worktree of a linked session that owns one
(`--cwd`). When no linked session owns a worktree, which is the case for a pull request opened
by hand or whose session was removed, the plugin adopts the pull request: it starts a fresh
worktree with `--project <p> --branch <head branch> --base-branch <head branch>`, so the local
branch is the pull request's head branch itself, not a copy. The session carries the usual
`work.link.*`, `work.role` and `work.rev` metadata, so it joins the row and the next action
reuses its worktree.

Adoption is refused with a typed code when the head branch cannot be checked out safely:

| Case | Code | Known to `list` |
| --- | --- | --- |
| the head lives in a fork (`isCrossRepository`) | `precondition_failed` | yes |
| the head branch is not a plain ref (option-like, `..`) or the head commit is not a full SHA | `invalid_value` | yes |
| an unlinked session of the project holds a worktree on the head branch | `precondition_failed` | yes |
| any other worktree holds the head branch (the primary checkout, a manual worktree) | `precondition_failed` | no, `project show` only |
| the worktrees cannot be read | `source_unavailable` | no |

`list` offers the action exactly when `do` would plan it, except for the last two rows: they need
`project show`, which `list` does not call for every row, so `list` still offers the action and
`do` refuses it. Core's own `worktree_branch_in_use` refusal is the backstop for a race.

Core checks an existing local branch out as it is (spike S9), so a stale local branch of the
same name yields a worktree at another commit without a warning. After the launch the plugin
reports `launch_unverified` on any daemon warning or when no worktree of the session is listed;
the advice then is to remove the session and bring the branch to the pull request head, never to
delete it. Core reports no head commit at creation (`session new`, `session show` and `session list`
carry none), so the guard against a wrong start is the prompt: the agent runs `git rev-parse HEAD`
before any change, stops on a difference, and sets the branch's upstream, which core does not set
for a branch it creates from `--base-branch`. The adopted session writes, so a head read after the
launch may be its own pull or rebase; the plugin therefore compares the worktree head from
`project show` with the pull request head SHA only to report a difference as a non-fatal warning
(`warnings` of `do` and `result.head_mismatch` with both commits in `--json`) that tells the owner to
check the session before acting. The `review` session is read-only, so there a differing head stays
`launch_unverified`.

## 8. The `on_turn` Column

### 8.1 Rules

Evaluated top to bottom; the first rule that holds decides.

| # | Condition | On turn | Source fields |
| --- | --- | --- | --- |
| 1 | A linked session has an unacknowledged `agent_blocked` or `approval_required` notification | me: answer agent | pohunek notifications |
| 2 | A linked session is live with `activity = working` | agent | pohunek session state |
| 12 | Evaluated right after 2: the row's issue is paused (Linear: a configured `paused_states` state; GitHub: a configured `paused_labels` label) | paused (no actions) | issue state or labels, join |
| 3 | Someone else's PR requests a review from me | me: review; with `reviews = "external"` (11.3): agent: external review | GitHub `reviewRequests`, project `reviews` |
| 4 | Changes requested and the fix is not fully delivered (8.2) | me: respond | reviews, timeline, threads, `reviewRequests` |
| 5 | The PR conflicts with its base; otherwise a check failed that is neither ignored nor a policy check; otherwise a policy check failed | me: rebase / fix CI / policy check: `<names>` | `statusCheckRollup`, `mergeable` |
| 6 | The PR is a draft | me: leave draft | `isDraft` |
| 7 | Approved, checks green, mergeable | me: merge | `reviewDecision`, checks, `mergeable` |
| 8 | Issue in a started state (Linear: state type `started`; GitHub: a `started_labels` label and no `paused_labels` label), assigned to me, with no PR and no live linked session | me: nothing runs | issue state or labels, assignee, join |
| 11 | Evaluated right after 8: same issue conditions, no PR, and a live linked session that is idle (rule 2 did not hold) | me: check agent | issue state or labels, assignee, join, pohunek session state |
| 13 | Evaluated right after 8: same issue conditions and no live linked session, and a merged PR resolves to the issue (7.3) | me: close or follow up | issue state or labels, assignee, join, merged PR search |
| 9 | Open non-draft PR with no pending review request and no decision | me: request review | `reviewRequests`, `reviewDecision` |
| 10 | Otherwise | reviewer | — |

Rule 5 checks in that order. A conflict comes first because a rebase reruns
every check, so fixing CI on a conflicting branch is wasted work. A policy
check (`policy_checks`, for example a required-label check) is a merge blocker
an agent cannot fix: when only policy checks fail, the reason names them in
configuration order and the row has no `fix-ci` action; when a CI check fails
as well, the reason is `fix CI` and the `fix-ci` prompt lists only the CI
checks.

Rule 3 depends on the project's `reviews` setting (11.3). With `reviews =
"session"` the review is the owner's and `review` is offered. With `reviews =
"external"` the project's own pipeline reviews the pull request, so the row is on
the agent's turn with the reason `external review`: it offers no `review`
action, `watch` does not notify it (it never becomes the owner's turn) and the
TUI shows the reason. A live linked session that is working still wins through
rule 2, so a session the pipeline starts with `work.link.*` metadata joins the
row.

Rule 12 is numbered last to keep the other numbers stable but is evaluated
right after rule 2: an issue the owner put on hold is not on anyone's turn, so
rules 3-11 never apply to its row, whatever its pull request needs (a conflict,
a failing check, a draft). On a row of a paused issue rules 1 and 2 still win:
a blocked agent still needs an answer and a working agent is still shown as
working. A paused row lists no actions and `do` refuses every action on it,
`attach` included. A Linear state name must match a `paused_states` entry
exactly; a GitHub label is matched against `paused_labels` case-insensitively,
as GitHub treats label names.
A paused issue without a pull request gets no row at all, so a session linked
to it, blocked or working, is not shown in `list`; it is not reported as
orphaned either. When the issue leaves the paused state, the row is evaluated
again and `watch` notifies if it lands on the owner's turn: after a poll in
which every source answered, `watch` drops rows that are no longer listed from
its baseline, so the returning row counts as new.

Rule 13 is numbered last to keep the other numbers stable but is evaluated right
after rule 8's conditions: a started issue assigned to the owner whose work
already merged is not "nothing runs", because `implement` would start a second
implementation of merged work. The row offers no action; the owner closes the
issue or decides on follow-up work. An open PR of the issue wins (it is the
row's PR and rules 3-10 apply), and a live linked session keeps rules 2 and 11.
The merged lookup is the separate source `github_merged`, reported next to
`github` in `sources`: only a row that would otherwise get rule 8 (started issue
assigned to me, no PR, no live session) depends on it. When it fails that row
is `unknown` with the reason `github_merged:<code>`, so a failed lookup never
falls back to rule 8; every other row, pull request rows included, is evaluated
as if the lookup had succeeded. A merge older than `merged_lookback_days` is not
seen.

An idle live session without a pending notification does not match rule 2;
the row falls through and the session is shown in its own column. Rule 11 is numbered
last to keep rules 1-10 stable but is evaluated right after rule 8: an issue that is
started, assigned to me and has no PR, with an idle live session, is on my turn because
the agent ended its turn and nothing else will move the row.

### 8.2 Rule 4 in detail

For each human reviewer whose latest review is `CHANGES_REQUESTED` (review
`R`), the turn belongs to the reviewer only when all hold:

1. **Fix delivered.** A `PullRequestCommit` or `HeadRefForcePushedEvent`
   timeline event exists after `R.submittedAt`.
2. **Threads answered.** Every unresolved thread with a comment by `R.author`
   ends with a comment by the PR author or a configured agent identity posted
   after `R.submittedAt`.
3. **Review re-requested.** `R.author` is in `reviewRequests` again as a
   user.

`R` is the reviewer's latest review that is `CHANGES_REQUESTED`, `APPROVED` or
`DISMISSED`; `COMMENTED` and pending reviews are skipped, because a comment
does not clear a requested change on GitHub. A newer `APPROVED` or `DISMISSED`
review therefore ends `R`, and a newer `COMMENTED` review does not count as a
re-request. Fix delivery is judged by the commit date of the timeline commit
(GitHub exposes no push time), so a fix committed before `R` and pushed after
it is not recognized; a force push event is.

Reviews by configured AI reviewer accounts never create an `R`.

### 8.3 Missing data

A pull request with `mergeable = UNKNOWN` is neither a conflict (rule 5) nor
mergeable (rule 7). When it is otherwise merge-ready (authored, approved,
checks green or none) the row is `unknown` with the reason
`github:mergeable_unknown` until GitHub reports a value. A `reviewDecision` of
`REVIEW_REQUIRED` counts as "no decision" in rule 9.

If a source needed by a rule is unavailable, the row shows `on_turn =
unknown` with the stable error code of that source. Rules are never evaluated
on partial data and `unknown` is never shown as `reviewer`. Rule 12 needs the
project's issue source (`linear`, or `github_issues` for a `github` project)
for every row joined to an issue key: while it is unavailable such a row is
`unknown` with the source's code, because its issue may be paused. Rows not
joined to an issue (review requests, pull requests without an issue key) and
projects with an empty `paused_states` (or `paused_labels`) and no `ignore_label`
do not depend on the issue source for rule 12. A project with `ignore_label`
needs the issue source for every row whose issue may carry the label: a row
joined to an issue key and, for a Linear project, an authored pull request
without a key while the source is down (it may be linked to its issue by a
Linear attachment only). It also needs `github` for every row without pull
request data (an issue row): while `github` is down the open pull request that
carries the label is missing. Such a row is `unknown` with the failing source's
code before rules 1 and 2 are evaluated, offers no action (`attach` included),
`do` refuses it and `watch` neither notifies it nor prunes its baseline.

The issue source lists only started issues assigned to the owner (Linear) or
open issues with a started or paused label (GitHub), so an authored pull request
can join an issue the list does not return, for example one the owner parked
with the ignore label and moved to Backlog. For a project with `ignore_label`,
two kinds of row (pull request not itself ignored, issue not returned) trigger
one targeted lookup per project and poll: a row joined to an issue key, and, for
a Linear project, an authored row that resolved to no key while the issue
source answered (`noIssue`), whose pull request may still be linked by a Linear
attachment. Linear is asked for the labels of the issues with those keys and of
the issues of `linear_team` that carry the pull request URL as an attachment
(`attachments: { some: { url: { in } } }`); GitHub is asked for the labels of
the issues with those numbers. Requests are batched by the source's page size
(`[linear] page_size`, `[github] issue_page_size`), keep within the complexity
and node budgets validated at load, and follow the label and attachment pages
to their end. An issue that carries the label makes the row ignored; an issue
that does not, or no issue at all (an empty Linear result, a GitHub `NOT_FOUND`
for exactly that lookup), leaves the row as it is. Every spelling of a key that
was asked for is answered. Any other error, or a page that cannot be followed
(`truncated`), makes every row of the lookup `unknown` with the reason
`<source>:<code>` (`linear` or `github_issues`), under the same rules as above.
Nothing is asked without `ignore_label`, without such a row, or while the issue
source or `github` is down. GitHub needs no attachment lookup: a closing
reference, a branch capture and a session link all resolve to a key without the
issue list.

Documented limits, not hidden: a key of another Linear team than `linear_team`
or of another repository than `repo`, a key the project cannot parse, and an
archived Linear issue (`includeArchived` is left at its default) are not looked
up, so such a row is never made ignored by its issue. Rule 8 needs it for every row that has an issue.
Rule 13 needs the merged pull request lookup (`github_merged`, 8.1) and only
for the rows described there.

## 9. Interfaces

All interfaces use the same plugin library and the same actions.

| Interface | Form | Stage |
| --- | --- | --- |
| CLI | `pohunek-work list/do/attach/gc`; `pohunek work ...` once core can invoke plugin actions from the CLI (#325) | B |
| rofi | `pohunek-rofi-work`, shipped with the plugin: rows on my turn, Enter runs the row action | C |
| rofi issue picker | `pohunek-rofi-issue <project> <linear\|github>`: for `github` the `github-issue:` rows of `list --json` that offer `implement`, Enter runs `pohunek-work do <key> implement` in a terminal | C |
| Notifications | `pohunek-work watch` posts through `notification.create` on transition to `me` | C |
| Agent skill `/work` | reads `list --json`, runs `do` | C |
| GUI or web panel | the native GUI (`native/`) and the web control center (`web/`) of this repository; showing plugin data in them is a separate design (question 1) | — |

### 9.1 `list --json`

Versioned envelope matching the pohunek CLI (`{cli_version, protocol,
ok|err}`, with the plugin's own contract version). The `list` contract is
version 4: version 2 added `on_turn.actor` `paused` and `on_turn.rule` 12;
version 3 adds the source status `unused`, which a source reports for a project
that does not use it (`sources.linear` of a project with `issue_source =
"github"`, `sources.github_issues` of a project with `issue_source = "linear"`),
the source `github_issues` (the GitHub issue lookup of a `github` project), the
`github-issue:` row key and the `on_turn` value `{"actor": "agent", "reason":
"external review", "rule": 3}` of a project with `reviews = "external"`. `unused` is not a failure: it never appears in the
list of unavailable sources and never makes `list` exit partial. Version 4 adds the row field `ignored` (a row carrying the project's
`ignore_label`; it has no actions but keeps its computed `on_turn`) and the
payload field `omitted_ignored` (the number of ignored rows left out of `items`
that `--mine`, `--stale-days` and `--project` would have listed; 0 with
`--include-ignored`). `list` and `list --mine` hide ignored rows unless
`--include-ignored` is passed (the table marks such a row's key with `(ignored)`); without it the table ends with
`N ignored row(s) hidden (use --include-ignored)` when N > 0.
A consumer
pinned to an older version gets an `incompatible` outcome instead of a payload
it cannot decode. `do` and `setup` version their envelopes separately
(both 1). Illustrative item:

```json
{
  "key": "linear:DMD-2188",
  "project": "connection",
  "issue": {"id": "DMD-2188", "title": "...", "state": "In Progress", "url": "..."},
  "pull_request": {
    "id": "keboola/connection#8605", "draft": false,
    "review_decision": "CHANGES_REQUESTED", "checks": "success", "mergeable": "MERGEABLE",
    "fix_delivered": false, "threads_answered": true, "rerequested": false
  },
  "no_issue": false,
  "issue_key": "DMD-2188",
  "sessions": [{"id": "s-...", "name": "PR-8605", "role": "babysit", "state": "terminal", "activity": null}],
  "on_turn": {"actor": "me", "reason": "respond", "rule": 4},
  "actions": [
    {"name": "babysit", "delegable": false, "profile": "claude-otel"},
    {"name": "attach", "delegable": true}
  ],
  "ignored": false,
  "sources": {"linear": "ok", "github": "ok", "github_merged": "ok", "github_issues": "unused", "pohunek": "ok"}
}
```

For a project with `issue_source = "github"` the issue row is keyed
`github-issue:<owner/name>#<number>`; `issue.id` and `issue_key` are
`<owner/name>#<number>` and `issue.state` is the label that decided the row (the
paused label when there is one, else the first started label, spelled as on
GitHub). The issue lookup reports its own status `sources.github_issues`; while
it is not `ok` a row joined to an issue is `unknown` where rule 12 or rule 8
needs the issue (8.3). `implement` is offered on a `github-issue:` row on rule 8 exactly as on a
`linear:` row; the issue body is not part of the contract and is read only when
`do implement` plans the launch (section 10). The other actions are offered on
it exactly as on a `linear:` row, and a session they start carries `work.link.provider = github`, `work.link.kind = issue` and
`work.link.id = <owner/name>#<number>`, so the next listing finds it. A pull
request that resolves to no issue key is flagged `no_issue` while the issue
lookup answered.

`issue_key` is the issue key the row resolved to (RFC 7.3), or null when
nothing resolved. It is set on the issue row (`linear:<KEY>` or
`github-issue:<owner/name>#<n>`) and also on the other pull requests of the
same issue, whose own `key` is `github:` and whose `issue` is null because only
one row may carry the issue key. The table prints it after the key
(`github:acme/widgets#9 (ABC-11)`) and the TUI shows it in the key column and the
detail pane.

### 9.2 Notifications

`pohunek-work watch` subscribes to pohunek events, polls Linear and GitHub on
the configured interval, keeps the previous `on_turn` per key in memory only
and posts one notification (`source.provider = "work"`) when a key moves to
`me`. A restart re-baselines without notifying. Until the plugin manifest can
declare a periodic job or long-running service
([zajca/pohunek#326](https://github.com/zajca/pohunek/issues/326)), it runs as a
user systemd unit.

## 10. Actions

`pohunek-work do <key> <action> [--profile <p>] [--json]`. Each action is
also declared in the plugin manifest (#148) so core and the manager see the
same set.

| Action | Effect | Precondition |
| --- | --- | --- |
| `implement` | worktree on `zajca/<KEY>/<slug>` (GitHub issue: `zajca/<issue_number_prefix><n>/<slug>`), session `role=implement` | no live linked session on the worktree |
| `babysit` | session `role=babysit` in the item's worktree, or in a fresh worktree of the pull request head branch when no linked session owns one (7.5) | rule 4; no live linked session |
| `fix-ci` | session `role=fix-ci`, worktree as for `babysit` | rule 5 (failed check) |
| `rebase` | session `role=rebase`, worktree as for `babysit` | rule 5 (conflict) |
| `review` | session `role=review` on someone else's PR | rule 3; refused with `not_supported` when the project has `reviews = "external"` |
| `ready` | mark PR ready for review | rule 6 |
| `merge` | merge or enqueue | rule 7; never delegable by default |
| `attach` | attach to the linked session | live linked session |

`implement` on a `github-issue:` row reads the issue once at plan time
(`repository(owner, name).issue(number)`: title, url, state, body) and refuses a
closed issue with `precondition_failed` and a failed lookup with
`source_unavailable`. The prompt (`work-implement-github.tmpl`) says "GitHub issue
`<owner/name>#<n>`", carries title, url and body inside the untrusted-data block
and tells the agent to read the issue and its comments with `gh issue view <n>
--repo <owner/name> --comments`. The body keeps its lines, each behind a `| `
prefix, so no body line can start or forge a fence; control characters become
spaces and a body longer than `[actions] issue_body_max_length` characters is cut
with the cut marked inside the block. The session is named `<owner/name>#<n>` and
carries `work.link.provider = github`, `work.link.kind = issue`,
`work.link.id = <owner/name>#<n>`, `work.link.url` = the issue URL,
`work.link.branch` and `work.role = implement`; the Linear prompt is separate and
unchanged. The body never enters `list`, logs or errors.

Each launch action resolves its agent profile and prompt template through a
per-project pohunek action with `provider = "none"` (for example
`babysit` in `~/.config/pohunek/actions.toml`) and renders the prompt with the
plugin's own provider data. Every action is idempotent per key, action and
source revision, refuses with a typed error when its precondition no longer
holds, and is written to the action log (section 11).

## 11. Storage and Configuration

### 11.1 Directories

#148 gives every workflow plugin an owner-private config directory and state
directory injected by core. Until #148 fixes their location, the plugin uses:

- config: `~/.config/pohunek/plugins/work/`
- state: `~/.local/state/pohunek/plugins/work/`

and switches to the injected paths in step 14.

### 11.2 What is stored where

| Data | Location | Writer | Stage |
| --- | --- | --- | --- |
| Issue state, cycle | Linear | team, GitHub integration | existing |
| PR, reviews, checks, threads | GitHub | owner, reviewers, bots, agents | existing |
| Session link and role | pohunek session `metadata` (`work.link.*`, `work.role`) | plugin at launch | A |
| Agent activity, blocking | pohunek events and notifications | pohunek hooks | existing |
| Worktree and branch | git | pohunek at launch | existing |
| `on_turn` | nowhere, computed at read time | — | — |
| Configuration | plugin config dir: `config.toml`, `projects/<project>.toml` | owner via machine-management | B |
| Watch log | plugin state dir `logs/watch.log`, JSON lines | `watch` | C |
| Action log | plugin state dir `actions.jsonl` | `do` | E |
| `run_id` to item key | plugin state dir `runs.jsonl` | `do` | F |
| Task records | daemon per-task directories (task RFC §14) | daemon | F |
| History, briefs | SiYuan | Hermes, brain skills | existing |

The action log records actor, key, action, profile, outcome and
provider-reported usage, never prompt text, results or terminal content.

### 11.3 Configuration layout and per-project settings

The source of truth is `machine-management/clients/zajca/pohunek-work/`,
installed into the plugin config directory. Every key is required; a missing
or invalid key stops every plugin command at startup with an error naming the
file and key. There are no built-in defaults.

```text
<plugin config dir>/
  config.toml              # owner identity, polling, global policy and profiles
  projects/
    connection.toml        # one file per pohunek project, file name = project label
```

```toml
# config.toml
[identity]
github_login = "zajca"
agent_identities = ["zajca"]
review_teams = []

[watch]
poll_interval_secs = 300

[actions]
branch_prefix = "zajca"
review_branch_segment = "review"
slug_max_length = 40
issue_number_prefix = "issue-"   # GitHub issue branch: <branch_prefix>/<issue_number_prefix><n>/<slug>; may be ""
issue_body_max_length = 8000     # characters of a GitHub issue body that reach the prompt
launch_timeout_ms = 120000
launch_kill_margin_ms = 10000

[policy]                  # empty: every action needs the owner
delegable = []
max_active_tasks = 0
daily_cost_ceiling_usd = 0

[profiles]                # action -> pohunek agent profile name
implement = "claude-otel"
babysit = "claude-otel"
review = "codex-pr-review"
```

```toml
# projects/connection.toml
[project]
pohunek_label = "connection"
repo = "keboola/connection"
issue_source = "linear"   # "linear" or "github"; required
reviews = "session"       # "session" or "external"; required
linear_team = "DMD"       # only with issue_source = "linear"
# started_labels = ["in progress"]   # only with issue_source = "github"; at least one
# paused_labels = ["on hold"]        # only with issue_source = "github"; may be empty
branch_pattern = "^zajca/(?P<key>DMD-[0-9]+)/"
ignored_checks = ["CD / Enqueue E2E"]
policy_checks = []        # merge blockers the owner meets; disjoint from ignored_checks
ai_reviewers = ["copilot-pull-request-reviewer", "chatgpt-codex-connector", "coderabbitai"]
# ignore_label = "pohunek:ignore"   # optional; absent = off
paused_states = ["On hold", "Waiting for Support"]   # only with issue_source = "linear"

# Optional per-project overrides; a table here replaces the global table whole.
# [profiles]
# [policy]
```

Rules:

- **Projects are the pohunek project registry.** A project appears in the
  table when `pohunek project list --json` has a project whose label equals
  `pohunek_label`, whose `origin_url` resolves to `repo`, and which has a
  `projects/<label>.toml` file. A file without a matching project, or a label
  mismatch after `project rename`, is reported by `pohunek-work doctor` and
  the project is left out; it is never guessed.
- **`issue_source` selects where a project's issues come from.** It is
  required and has no default. `linear` requires `linear_team` and
  `paused_states` and queries Linear; `github` rejects both keys (an error naming
  the file and key) and requires `started_labels` and `paused_labels` instead,
  which `linear` rejects in turn. `branch_pattern`, `ignored_checks`,
  `policy_checks` and `ai_reviewers` are required for both sources.
- **`ignore_label` parks work.** It is optional and has no default; a blank
  or non-string value is an error naming the file and key. Rows carrying the
  label (case-insensitive) on the pull request or the joined issue are hidden
  from `list` unless `--include-ignored` is passed, refused by `do` unless
  `--include-ignored` is passed (`precondition_failed`) and never notified by
  `watch`; absent = off. A label list that cannot be read completely fails the
  source (`truncated`) and never reads as "not ignored". With the key, each
  Linear issue page also selects `labels(first: page_size)`. Linear caps a
  query at 10,000 complexity points, so `[linear] page_size` is validated at
  load: at most 93 in general and at most 66 while a Linear project sets
  `ignore_label` (`ConfigError` naming `linear.page_size`). A pull request that
  joined to an issue the issue source did not list is checked by a targeted
  label lookup of exactly those issues (8.3); a labelled issue ignores the row.
  While `github` is down an issue row (no pull request data) is `unknown`, and
  while the issue source is down or that lookup fails a row whose issue is
  unknown (joined to a key, or an authored Linear pull request without a key)
  is `unknown`; all before rules 1 and 2, with no actions and no notification,
  because that issue may carry the label (8.3).
- **`reviews` says who reviews the project's pull requests.** It is required
  and has no default. `session`: `do <key> review` launches a pohunek review
  session with the `review` profile and rule 3 is the owner's turn. `external`:
  the project reviews pull requests through its own pipeline (for example a
  service that runs reviewer agents and publishes a combined review). Rule 3
  then gives `agent: external review`, `list` offers no `review` action and
  `do <key> review` refuses with `not_supported`, naming the setting. Sessions
  the pipeline starts with `work.link.*` metadata still join the row (rule 2).
  The key is a fact about the project's review process, so it lives in
  `[project]` and not in the global `[actions]` table.
- **A `github` project lists the owner's open issues of `repo` that are
  assigned to `identity.github_login` and carry a label.** `started_labels` (a
  non-empty list) marks an issue as started: rule 8 applies to it. `paused_labels`
  (a list that may be empty) marks it as paused: rule 12 applies, and a paused
  label outranks a started one. Label names are compared case-insensitively
  and a label may not appear in both lists. An issue that is not assigned to the
  owner, or has neither kind of label, produces no row, exactly like a Linear
  issue outside a started state: an issue has to be assigned **and** labelled
  before it appears. The issue search and its labels are bounded
  by the global `[github]` page sizes: `issue_page_size` (1 to 100, required) for
  the search and `nested_page_size` for the labels of an issue; a label list longer
  than one page is followed to its end, and anything that cannot be followed
  makes `github_issues` `truncated`. The node budget of the pull request search
  is validated at load with the closing issue references of 7.3 and the pull request labels of the ignore label included, whether
  or not a `github` project exists, so the global file is valid or not independently
  of the project files; the issue search is validated against the same limit. The global `[linear]` table of
  `config.toml` and its keyring entry are required only while at least one
  project uses `issue_source = "linear"`; the table is validated whenever it is
  present, and `pohunek-work doctor` checks the keyring only when a Linear
  project exists.
- **Tables are not field-merged.** A `[policy]` or `[profiles]` table in a
  project file replaces the global table as a whole, matching the
  per-project actions resolution rule (most specific wins whole), so what
  applies is readable from one file. `pohunek-work config show <project>`
  prints the effective tables with their source file.
- **Profile names only.** `[profiles]` selects agent profile names that exist
  on the host (`~/.config/pohunek/agents/`); it never defines a program,
  argv or environment.
- **No in-repository layer in v1.** Connection is a team repository, and
  repository-supplied policy would let a repository widen agent autonomy. A
  later version may read project facts (the `[project]` table only) from
  `<repo>/.pohunek/plugins/work.toml`, never `[policy]` or `[profiles]`.

The values above come from the current setup: Hermes
`HERMES_PR_STATUS_AI_REVIEWERS_JSON`, pohunek agent profiles, the pohunek
project label `connection`, the Linear team `DMD`. `ignored_checks` comes
from an earlier status sweep and must be confirmed.

### 11.4 Proposed amendment to the delegated task runs RFC

`task.start` accepts no metadata, and `run_id` must be a ULID, so the item key
cannot be stored with a task. Proposal: `task.start` accepts optional
`metadata` with the same validation as `session.new` and forwards it into the
same atomic write. This is a generic core change; the daemon still does not
interpret the keys. Until it lands, the plugin calls `session.set_metadata`
right after `task.start`, and `pohunek-work gc --adopt` closes the window.

## 12. Toward an Agent Acting for the Owner

### 12.1 Autonomy levels

| Level | Who decides | What reaches the owner | Depends on |
| --- | --- | --- | --- |
| 0 | owner runs actions | whole table | stages A to C |
| 1 | manager proposes, owner confirms | proposed order and actions | stage E |
| 2 | manager runs delegable actions | rows on `me`: attention, verdict, merge, others' reviews | stage F, #182 |
| 3 | dark factory, manager and auditor as service accounts | escalated attention, verdicts | stage G, #185 |

### 12.2 Rules that keep the path open

1. `list --json` is a versioned contract with actions and `delegable` per row.
2. Actions are named operations shared by every caller.
3. Item keys are project-scoped from the first release.
4. The autonomy policy is versioned configuration and starts empty.
5. Every action is logged with actor, profile and outcome.

### 12.3 Manager

The manager is a long-running pohunek session with `role=manager`
(Manage-Execute-Audit, task RFC §16.1). It does not poll: `pohunek-work
watch` wakes it through `session.input` when a row changes. Its run state
lives in its own client state, never in the daemon, the relay or the
objective's worktree (dark factory RFC §12.2). One `run_id` per work item.

### 12.4 Profile and model selection

Profile routing is outside the daemon (task RFC §5). The manager takes the
profile for each action from `[profiles]`, globally or per project. Changes
are commits in machine-management, informed by a report over the action log
(outcome and provider-reported cost per profile and action).

### 12.5 Multiple projects

A project is a pohunek project registration plus one
`projects/<label>.toml` and its `provider = "none"` pohunek actions. Nothing
else changes.

## 13. Roadmap

Steps are sequential within a stage. Each names where the change lands and a
verifiable definition of done. Stages A to C do not wait for #148; they run
the plugin as an ordinary owner process, which is what #148 formalizes.

### A. Link

1. **Plugin skeleton.** Repository `zajca/pohunek-work` (`pohunek-work`
   binary), never linked into daemon or worker; loads configuration
   fail-fast from the provisional directories. Done: missing or invalid keys
   fail with file and key names; tests cover both.
2. **Launch with link.** Plugin `do <key> implement|babysit` through
   `pohunek project action` (`provider = "none"`) and `pohunek session new
   --branch --name --meta`. Done: `pohunek session list --json` shows
   `work.link.*`, `work.role` and the key-based name; the branch follows
   `zajca/<KEY>/<slug>`.
3. **Skills use the plugin.** connection `.claude/skills/babysit-pr`,
   `ship-task`, `linear-issue`; a team repository, so agree the change or
   wrap it in a personal skill in `machine-management/clients/zajca/skills/`.
   Done: babysit from these skills creates a session with `work.role=babysit`.

### B. List

4. **Provider adapters in the plugin.** Linear and GitHub adapters in
   `plugins/work`, ported from `crates/gui-core/src/providers/`, extended with
   review threads, `reviewRequests`, timeline commits, `mergeable`, started
   issues and attachments. Done: adapter tests against recorded responses.
5. **Rules.** The ten rules as pure functions. Done: fixture tests for each
   rule, precedence, every rule 4 sub-condition, the DMD-2115 case (changes
   requested, everything delivered, turn on reviewer) and `unknown` per failed
   source.
6. **`list`.** `pohunek-work list [--mine] [--json]`. Done: a contract test
   pins the section 9.1 schema.
7. **Configuration in machine-management.** New
   `clients/zajca/pohunek-work/` with `config.toml`,
   `projects/connection.toml`, `install.sh` and tests. Done: installer writes
   the plugin config dir; `doctor` reports a label or origin mismatch.
8. **Cleanup after merge.** Move `post-merge` from `~/.claude/skills` into
   `machine-management/clients/zajca/skills/`. Done: after a merge it removes
   the session and worktree found by `work.link.id`; transcripts remain.

### C. Interfaces

9. **Remaining actions.** `fix-ci`, `rebase`, `review`, `ready`, `merge`,
   `attach` with their pohunek actions. Done: each checks its precondition, is
   idempotent and returns typed errors.
10. **Watch.** `pohunek-work watch` and a user systemd unit in
    `machine-management/clients/zajca/pohunek-work/systemd/`. Done: one
    notification per transition to `me`; JSON log in the state dir.
11. **rofi.** `pohunek-rofi-work` shipped with the plugin. Done: rows on my
    turn; Enter runs the row action.
12. **Skill `/work`.** `machine-management/clients/zajca/skills/work/`,
    symlinked for Claude Code and Codex. Done: replaces manual status sweeps.
13. **Adopt the current state.** `pohunek-work gc --adopt --dry-run`. Done:
    existing worktrees are linked by branch or removed after confirmation.

### D. Plugin packaging and generic core (after #148)

14. **Manifest per #148.** Declared actions, event reactions (session and
    notification events trigger a recompute), core-injected config and state
    directories replace the provisional ones. Done: the plugin installs and
    runs as a workflow plugin; #148 tests pass for it.
15. **Generic core issues in project "Runtime plugin packages".** Filed as
    sub-issues of #148:
    1. [#325](https://github.com/zajca/pohunek/issues/325) invoking plugin
       actions from the CLI;
    2. [#326](https://github.com/zajca/pohunek/issues/326) manifest-declared
       periodic jobs and long-running services, replacing the user unit of
       step 10;
    3. [#327](https://github.com/zajca/pohunek/issues/327) `session.list`
       filter by metadata key and value;
    4. [#328](https://github.com/zajca/pohunek/issues/328) displaying plugin
       data in the GUI or web UI (a decision of this repository's own UIs; core
   ships no UI).
    Done: each implemented issue removes the matching workaround in the
    plugin.
16. **Provider extraction from core.** `ProviderKind` becomes an opaque,
    name-guarded string; `gui-core/src/providers/`, the provider launchers
    (`pohunek-launch-issue`, `pohunek-launch-pr`) and `[providers.*]` in
    `gui.toml` move into the plugin. Done: core contains no Linear or GitHub
    code and all core tests pass.

### E. Agent proposes

17. **Action log.** Plugin `do` writes `actions.jsonl`. Done: one record per
    action, no prompt or result content.
18. **Policy.** `[policy]` and `[profiles]` drive `delegable` and `profile` in
    `list --json`. Done: an empty policy yields no delegable action.
19. **Manager session.** Skill `/work` in manager mode, woken by `watch`.
    Done: after a wake-up the manager proposes ordered actions and waits for
    confirmation; it issues no polling calls.

### F. Task layer (after #182)

20. **Task RFC amendment.** `task.start` forwards `metadata` (section 11.4).
    Done: accepted in the task RFC and implemented in `TaskStartParams`.
21. **Actions start tasks.** `task.start` with explicit `branch`, one
    `run_id` per item, profile from policy; babysit uses `worktree_of`;
    `runs.jsonl` maps `run_id` to key. Done: all launch actions go through
    tasks.
22. **Task sources for `on_turn`.** `task_attention` replaces `agent_blocked`
    in rule 1; a published result without a `task.review` verdict yields
    `me: verdict`; cleanup uses `task.stop` and `task.release_worktree`.
23. **Level 2 autonomy.** The machine-management policy enables the first
    delegable actions (for example `fix-ci`, `rebase`). Done: the manager runs
    them with `task run --wait`; an investigate-mode audit precedes `ready`.
24. **Profile report.** Report over the action log in `/work`. Done: outcome
    and reported cost per profile and action type.

### G. Relay (after #185)

25. **Service accounts.** Relay configuration with `FactoryManager` and
    `FactoryAuditor`. Done: budgets, audit and attention escalation to the
    owner per the dark factory RFC.
26. **Multi-host view.** The plugin reads the relay `task.list` catalog. Done:
    tasks from every host appear; stale hosts are marked.
27. **Hermes sees agents.** `servers/vps2/hermes/pr-status*`,
    `restate-pr-status`. Done: the SiYuan brief includes agent state.
28. **More projects.** A new `projects/<label>.toml` and its pohunek actions.
    Done: the project appears and is served by the manager without code
    changes. The table part works any time after step 7.

## 14. Security

- **Owner trust boundary.** The plugin is same-UID owner code (#148). Core
  injects no worker socket, attach credential, policy file, provider token or
  full environment; the plugin obtains provider credentials itself (`gh`
  authentication, the Linear token source) and never writes them to metadata,
  logs or prompts.
- **Provider text is untrusted.** PR titles, review comments, thread bodies and
  issue descriptions are data; prompts rendered by the plugin put them in
  delimited data blocks and instruct agents never to follow instructions
  found there, as the Hermes prompts already do.
- **Owner-only actions.** `merge` and keystroke-delivered answers
  (`verification: unverified`, task RFC §8.5) are never delegable by default.
- **Policy is reviewed.** `[policy]` and `[profiles]` are versioned in
  machine-management and never read from a repository.
- **Bounded side effects.** Plugin failures and timeouts never block daemon or
  session lifecycle (#148); watch output is bounded and structurally logged.

## 15. Failure Modes

| Failure | Behavior |
| --- | --- |
| GitHub or Linear unavailable or rate limited | affected rows `unknown` with the source error code; no notification |
| Pohunek unreachable | session column `unknown`; rules 1, 2, 8 not evaluated; row `unknown` |
| Session without link | listed as unlinked; `gc --adopt` links it by branch |
| Second live session on a worktree | `do` refuses; with tasks the daemon refuses |
| Precondition changed between `list` and `do` | typed refusal, no side effect |
| Project file without matching pohunek project | `doctor` reports; project left out |
| Watch restart | re-baseline without notifications |
| Missing configuration key | startup error naming file and key |

## 16. Testing

- Fixture tests for each rule, precedence, rule 4 sub-conditions and
  `unknown` handling.
- Contract test pinning the `list --json` schema.
- Launch tests asserting metadata, role and name on created sessions.
- Configuration tests for fail-fast, table replacement and project matching.
- Action tests for idempotency and precondition refusals.
- #148 manifest, timeout and failure tests once the plugin is packaged.

## 17. Alternatives Considered

- **Engine inside the pohunek daemon.** Rejected: couples core to Linear and
  GitHub, contradicts #148 and task RFC §16.4.
- **A new per-project configuration layer in core's config resolver.**
  Rejected: the plugin owns its configuration directory (#148) and can hold
  per-project files there without core changes.
- **Stored buckets or custom workflow states.** Rejected: duplicates source
  state and adds manual transitions; one derived column is enough.
- **Hermes as the primary home.** Rejected for now: runs on vps2 without
  access to local sessions; becomes the asynchronous view in stage G.
- **GitHub Projects or Linear custom fields.** Rejected: cannot see agent
  sessions and need manual upkeep.

## 18. Open Questions

1. How should plugin data reach the GUI or web UI after v1? Both UIs now live
   in this repository, so the plugin's `list --json` is the natural source and
   no core-rendered table contract is needed; the surface design is open.
2. Resolved: the plugin lives in its own repository, `zajca/pohunek-work`,
   and talks to pohunek only through public contracts (the CLI with `--json`; the UIs in this repository also use the public protocol through pinned SDKs); see
   [`implementation-plan.md`](implementation-plan.md) decision D1.
3. Should `babysit` become delegable at level 2 immediately or only after the
   action log shows how often rule 4 still matches after a babysit run?
4. Should GitHub issues without a Linear counterpart be included for
   connection, or only for projects without Linear?
5. Should the task RFC amendment of section 11.4 be proposed now or with the
   task layer implementation?
