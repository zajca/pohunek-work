// view(state) -> Frame: the whole screen as lines of SafeText, at most
// `size.rows` lines of at most `size.columns` characters. Pure; every piece of
// contract text goes through toSafe before it is placed.
import { isSourceFailure, type ListAction, type ListItem, type ListPayload } from "../types/item.ts";
import { isTuiAction } from "./actions.ts";
import { columnsFor, overlayHeight, tableWidthOf, COLUMN_GAP, DROP_ORDER, type ColumnId, type ColumnSpec, type Layout } from "./layout.ts";
import { isStale, layoutOf, selectedRow, staleBefore, visibleRows, MS_PER_MINUTE, type State } from "./model.ts";
import { actorCounts, hiddenStaleCount, hiddenUnknownCount, rowId, rowTitle } from "./rows.ts";
import { concat, fit, join, toSafe, toSafeLines, truncate, wrap, type SafeText } from "./safe.ts";

export type Frame = readonly SafeText[];

const MINUTES_PER_HOUR = 60;
const PANE_SEPARATOR = toSafe("|");

/** One line per rule (RFC 8.1); rule 5 has a line per fixed reason and `5` for a policy check. */
const RULE_LINES: Readonly<Record<string, string>> = {
  "1": "a linked agent is blocked or asks for approval: answer it (attach)",
  "2": "a linked agent is working",
  "3": "your review is requested",
  "4": "changes requested: deliver a fix, answer every thread, re-request review",
  "5:fix CI": "a check failed on the pull request",
  "5:rebase": "the pull request conflicts with its base branch",
  "5": "a policy check failed: meet it on GitHub (manual)",
  "6": "the pull request is a draft: mark it ready when done",
  "7": "approved, checks green, mergeable: merge on GitHub (manual)",
  "8": "issue started and assigned to you, no pull request, nothing runs",
  "9": "no review requested and no decision: request a review on GitHub (manual)",
  "10": "waiting for reviewers",
  "11": "issue started and assigned to you, no pull request, the linked agent is idle: check it",
  "12": "the issue is in a paused state: nobody's turn until it leaves that state",
  "13": "issue started and assigned to you, its pull request is merged, nothing runs: close it or plan follow-up work",
};

export function ruleLine(item: ListItem): string {
  const { actor, reason, rule } = item.on_turn;
  if (rule === null) return actor === "unknown" ? `a source did not answer (${reason}); the row may be your turn` : reason;
  return RULE_LINES[`${rule.toString()}:${reason}`] ?? RULE_LINES[rule.toString()] ?? reason;
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MS_PER_MINUTE);
  if (minutes < 1) return "<1m";
  if (minutes < MINUTES_PER_HOUR) return `${minutes.toString()}m`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return `${hours.toString()}h${(minutes % MINUTES_PER_HOUR).toString().padStart(2, "0")}m`;
}

function turnCell(item: ListItem): string {
  const { actor, reason, rule } = item.on_turn;
  const ruleText = rule === null ? "" : ` (r${rule.toString()})`;
  return actor === "me" || actor === "unknown" ? `${actor}: ${reason}${ruleText}` : `${actor}${ruleText}`;
}

const REVIEW_SHORT: Readonly<Record<string, string>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  REVIEW_REQUIRED: "required",
};

function prCell(item: ListItem): string {
  const pr = item.pull_request;
  if (pr === null) return "-";
  const hash = pr.id.lastIndexOf("#");
  return (hash < 0 ? pr.id : pr.id.slice(hash)) + (pr.draft ? " d" : "");
}

function sessionsCell(item: ListItem): string {
  if (item.sessions.length === 0) return "-";
  return item.sessions.map((s) => `${s.role ?? "?"}:${s.activity ?? s.state}`).join(",");
}

function cell(item: ListItem, id: ColumnId, state: State): SafeText {
  switch (id) {
    case "mark":
      return toSafe((rowId(item) === state.selected ? ">" : " ") + (state.marked.has(rowId(item)) ? "*" : " "));
    case "key":
      return toSafe(item.key + secondaryIssueTag(item));
    case "project":
      return toSafe(item.project);
    case "turn":
      return toSafe(turnCell(item));
    case "pr":
      return toSafe(prCell(item));
    case "review":
      return toSafe(item.pull_request === null ? "-" : (REVIEW_SHORT[item.pull_request.review_decision ?? ""] ?? "-"));
    case "checks":
      return toSafe(item.pull_request?.checks ?? "-");
    case "sessions":
      return toSafe(sessionsCell(item));
    case "title":
      return toSafe(rowTitle(item));
  }
}

/** `fit` that cuts inside the head and keeps the last `tail` characters, so a suffix such as the issue key stays visible. */
function fitKeepingTail(text: SafeText, width: number, tail: number): SafeText {
  if (tail <= 0 || text.length <= width || width <= tail) return fit(text, width);
  return concat(truncate(toSafe(text.slice(0, text.length - tail)), width - tail), toSafe(text.slice(text.length - tail)));
}

interface Table {
  readonly columns: readonly ColumnSpec[];
  readonly widths: readonly number[];
}

/**
 * Each column grows to its content within its bounds. Columns are dropped in
 * DROP_ORDER while the title would get less than its minimum, then the rest
 * shrink widest-slack first; the title takes what is left.
 */
export function planTable(candidates: readonly ColumnSpec[], cells: readonly (readonly SafeText[])[], width: number): Table {
  const natural = new Map(
    candidates.map((column, index) => [
      column.id,
      column.id === "title"
        ? column.min
        : Math.min(column.max, Math.max(column.min, column.header.length, ...cells.map((row) => row[index]?.length ?? 0))),
    ]),
  );
  let columns = [...candidates];
  const widthsOf = (list: readonly ColumnSpec[]): number[] => list.map((column) => natural.get(column.id) ?? column.min);
  for (const drop of DROP_ORDER) {
    if (tableWidthOf(columns, widthsOf(columns)) <= width) break;
    columns = columns.filter((column) => column.id !== drop);
  }
  const widths = widthsOf(columns);
  const titleIndex = columns.findIndex((column) => column.id === "title");
  while (tableWidthOf(columns, widths) > width) {
    let widest = -1;
    let widestSlack = 0;
    columns.forEach((column, index) => {
      const slack = (widths[index] ?? 0) - column.min;
      if (index !== titleIndex && slack > widestSlack) {
        widest = index;
        widestSlack = slack;
      }
    });
    if (widest < 0) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
  }
  widths[titleIndex] = (widths[titleIndex] ?? 0) + Math.max(0, width - tableWidthOf(columns, widths));
  return { columns, widths };
}

function tableLines(state: State, layout: Layout, payload: ListPayload): SafeText[] {
  const candidates = columnsFor(payload);
  const rows = visibleRows(state);
  const allCells = rows.map((item) => candidates.map((column) => cell(item, column.id, state)));
  const { columns, widths } = planTable(candidates, allCells, layout.tableWidth);
  const indexes = columns.map((column) => candidates.indexOf(column));
  const gap = toSafe(" ".repeat(COLUMN_GAP));
  const line = (parts: readonly SafeText[], tails: readonly number[] = []): SafeText =>
    truncate(join(parts.map((part, index) => fitKeepingTail(part, widths[index] ?? 0, tails[index] ?? 0)), gap), layout.tableWidth);
  const lines = [line(columns.map((column) => toSafe(column.header)))];
  const body = allCells.slice(state.top, state.top + layout.bodyHeight).map((cells, offset) => {
    const row = rows[state.top + offset];
    const tails = columns.map((column) => (column.id === "key" && row !== undefined ? secondaryIssueTag(row).length : 0));
    return line(indexes.map((index) => cells[index] ?? toSafe("")), tails);
  });
  if (rows.length === 0) body.push(truncate(toSafe(emptyMessage(state, payload)), layout.tableWidth));
  return [...lines, ...body];
}

function describeFilters(state: State): string {
  const parts = [`actor=${state.filters.actor}`];
  if (state.filters.project !== null) parts.push(`project=${state.filters.project}`);
  if (state.filters.text !== "") parts.push(`text=${state.filters.text}`);
  if (state.filters.hideStale) parts.push("stale=hidden");
  return parts.join(" ");
}

function emptyMessage(state: State, payload: ListPayload): string {
  if (payload.items.length === 0) return `no open work items (${payload.projects.length.toString()} projects polled)`;
  return `no rows match ${describeFilters(state)} (${payload.items.length.toString()} hidden)`;
}

function headerLine(state: State, payload: ListPayload, receivedAt: number): SafeText {
  const counts = actorCounts(payload);
  // Paused rows are nobody's turn; their count is shown only when there are some, to keep the line short.
  const paused = counts.paused > 0 ? `  paused ${counts.paused.toString()}` : "";
  const parts = [
    `me ${counts.me.toString()}  agent ${counts.agent.toString()}  reviewer ${counts.reviewer.toString()}${paused}  unknown ${counts.unknown.toString()}`,
    `data ${formatAge(state.now - receivedAt)} old${isStale(state) ? " STALE" : ""}${state.refreshing ? " refreshing" : ""}`,
    `view: ${state.filters.actor === "me" ? "mine" : state.filters.actor}`,
    ...(state.filters.project === null ? [] : [`project: ${state.filters.project}`]),
    ...(state.filters.text === "" ? [] : [`/${state.filters.text}`]),
    ...(state.filters.hideStale ? [`stale -${hiddenStaleCount(payload, state.filters, staleBefore(state)).toString()}`] : []),
  ];
  return toSafe(parts.join("  "));
}

function bannerLines(state: State, payload: ListPayload, dataVersion: string): SafeText[] {
  const lines: SafeText[] = [];
  const failures = payload.projects.flatMap((project) => {
    const failed = Object.entries(project.sources).filter(([, code]) => isSourceFailure(code));
    return failed.length === 0 ? [] : [`${project.project}: ${failed.map(([source, code]) => `${source}=${code}`).join(" ")}`];
  });
  if (failures.length > 0) lines.push(toSafe(`PARTIAL DATA ${failures.join("; ")}`));
  if (dataVersion !== state.settings.cliVersion) {
    lines.push(toSafe(`WARNING: self_bin reports pohunek-work ${dataVersion}, this TUI is ${state.settings.cliVersion}`));
  }
  if (state.listStderr.length > 0) {
    const last = state.listStderr[state.listStderr.length - 1] ?? "";
    lines.push(toSafe(`list stderr (${state.listStderr.length.toString()} lines, s shows all): ${last}`));
  }
  const hidden = hiddenUnknownCount(payload, state.filters);
  if (hidden > 0) lines.push(toSafe(`${hidden.toString()} unknown rows hidden (f)`));
  return lines;
}

function onOff(value: boolean | null): string {
  return value === null ? "-" : value ? "yes" : "no";
}

/** `*` marks the primary action (Enter). */
function actionLabel(action: ListAction, primary: boolean): string {
  const profile = action.profile === undefined ? "" : ` (${action.profile})`;
  return `${action.name}${primary ? "*" : ""}${profile}${isTuiAction(action.name) ? "" : " [not run by the TUI]"}`;
}

/** Issue key in parentheses after the key of a row that resolved to an issue but is not its `linear:` row. */
function secondaryIssueTag(item: ListItem): string {
  return item.issue_key !== null && item.key !== `linear:${item.issue_key}` ? ` (${item.issue_key})` : "";
}

/** Names the issue of a `github:` row that resolved to one. */
function secondaryIssueNote(item: ListItem): string {
  return item.issue_key !== null && item.key !== `linear:${item.issue_key}` ? `  issue ${item.issue_key}` : "";
}

/** Detail of one row, unwrapped; the caller wraps to the pane width. */
export function detailLines(state: State, item: ListItem): SafeText[] {
  const lines: string[] = [
    `${item.key}  (project ${item.project})${item.no_issue ? "  no Linear issue" : ""}${secondaryIssueNote(item)}`,
    `turn: ${turnCell(item)}`,
    `  ${ruleLine(item)}`,
  ];
  const issue = item.issue;
  if (issue !== null) lines.push(`issue: ${issue.id} [${issue.state}] ${issue.title}`, `  ${issue.url}`);
  const pr = item.pull_request;
  if (pr !== null) {
    lines.push(
      `pr: ${pr.id}${pr.draft ? " (draft)" : ""} ${pr.title}`,
      `  review=${pr.review_decision ?? "-"} checks=${pr.checks} mergeable=${pr.mergeable}`,
      `  fix_delivered=${onOff(pr.fix_delivered)} threads_answered=${onOff(pr.threads_answered)} rerequested=${onOff(pr.rerequested)}`,
      `  ${pr.url}`,
    );
  }
  lines.push(item.sessions.length === 0 ? "sessions: none" : "sessions:");
  for (const s of item.sessions) {
    lines.push(`  ${s.id} ${s.name ?? "(unnamed)"} role=${s.role ?? "-"} state=${s.state} activity=${s.activity ?? "-"}`);
  }
  const actions = item.actions.map((action, index) => actionLabel(action, index === 0));
  lines.push(`actions: ${actions.length === 0 ? "none (manual)" : actions.join(", ")}`);
  lines.push(`sources: ${Object.entries(item.sources).map(([source, code]) => `${source}=${code}`).join(" ")}`);
  const note = state.notes.get(rowId(item));
  if (note !== undefined) lines.push("", `--- ${note.title}`, ...note.lines);
  if (state.previewing === rowId(item)) lines.push("", "--- preview running");
  return lines.flatMap((line) => toSafeLines(line));
}

function paneLines(state: State, width: number, height: number): SafeText[] {
  const item = selectedRow(state);
  if (item === null) return [];
  const wrapped = detailLines(state, item).flatMap((line) => wrap(line, width));
  return wrapped.slice(state.detailTop, state.detailTop + height);
}

const HINTS = "?:help q:quit Enter:run a:actions p:preview t:attach o:open m:mine /:filter r:refresh";

function statusLine(state: State): SafeText {
  if (state.editingFilter) return toSafe(`/${state.filters.text}_  (Enter keeps, Esc clears)`);
  if (state.overlay === "help") return toSafe("any key closes the help");
  if (state.status !== null) return toSafe(`${state.status.error ? "error: " : ""}${state.status.text}`);
  if (state.fatal?.kind === "incompatible") return toSafe("q:quit");
  if (state.fatal?.kind === "error") return toSafe("r:retry q:quit ?:help");
  if (state.data === null) return toSafe("q:quit ?:help");
  if (state.detailFocus) return toSafe("detail pane: j/k scroll, Tab or Esc back to the rows");
  return toSafe(HINTS);
}

const HELP = [
  "keys",
  "  j/k, Down/Up    move            g/G, PgUp/PgDn  jump / page",
  "  Enter           primary action  a               choose an action",
  "  p               preview (dry run into the detail pane)",
  "  t               attach to the linked session (when listed)",
  "  o               open the pull request or issue URL",
  "  r               refresh now     m               mine / all",
  "  f               actor filter    P               project filter",
  "  h               hide stale pull requests nothing runs for (toggle)",
  "  /               text filter on key and title; Esc clears",
  "  s               sessions and list stderr",
  "  Tab             detail pane (full screen when narrow)",
  "  ?               this help       q, Ctrl-C       quit",
  "",
  "the TUI never confirms a write: do shows the plan and asks y/N itself",
  "merge is never offered: merge on GitHub yourself",
  "",
  "any key closes this help",
];

function screen(title: string, body: readonly string[], state: State, top = 0): SafeText[] {
  const height = overlayHeight(state.size);
  const lines = body.flatMap((line) => toSafeLines(line));
  return [toSafe(title), ...lines.slice(top, top + height), ...Array<SafeText>(Math.max(0, height - (lines.length - top))).fill(toSafe("")), statusLine(state)];
}

function sessionsScreen(state: State): SafeText[] {
  const payload = state.data?.payload;
  const orphaned = payload?.orphaned_sessions ?? [];
  const unlinked = payload?.unlinked_sessions ?? [];
  const body = [
    `orphaned sessions (${orphaned.length.toString()}): linked to an item no source returns`,
    ...orphaned.map((s) => `  ${s.id} ${s.name ?? "(unnamed)"} links ${s.linkId}`),
    "",
    `unlinked sessions (${unlinked.length.toString()}): live, without a work link`,
    ...unlinked.map((s) => `  ${s.id} ${s.name ?? "(unnamed)"} in ${s.project}: ${s.activity ?? s.state}`),
    "",
    `list stderr (${state.listStderr.length.toString()} lines)`,
    ...state.listStderr.map((line) => `  ${line}`),
  ];
  return screen("sessions  (s or Esc closes)", body, state, state.sessionsTop);
}

function chooserScreen(state: State, item: ListItem): SafeText[] {
  const body = item.actions.map(
    (action, index) => `${index === state.chooserIndex ? ">" : " "} ${(index + 1).toString()}. ${actionLabel(action, index === 0)}`,
  );
  return screen(`actions for ${item.key}  (j/k and Enter or 1-9 run, Esc closes)`, body, state);
}

function fatalScreen(state: State): SafeText[] {
  const fatal = state.fatal;
  if (fatal === null) return [];
  if (fatal.kind === "incompatible") {
    return screen(`incompatible pohunek-work at ${state.settings.selfBin}`, [
      fatal.message,
      "no rows are shown: the TUI never guesses another contract version",
      "update self_bin or this TUI; q quits",
    ], state);
  }
  const { err } = fatal;
  const kept = state.data === null ? [] : [`last good data kept (${formatAge(state.now - state.data.receivedAt)} old, STALE)`];
  return screen("pohunek-work list failed", [
    `class: ${err.class}`,
    `code: ${err.code}`,
    "message:",
    ...err.msg.split("\n").map((line) => `  ${line}`),
    ...(err.recover === undefined ? [] : [`recover: ${err.recover}`]),
    "",
    ...kept,
    "r retries, q quits",
  ], state);
}

function clip(frame: readonly SafeText[], state: State): Frame {
  const { columns, rows } = state.size;
  return frame.slice(0, Math.max(0, rows)).map((line) => truncate(line, columns));
}

export function view(state: State): Frame {
  const layout = layoutOf(state);
  if (state.overlay === "help") return clip(screen("help", HELP, state), state);
  if (state.fatal !== null) return clip(fatalScreen(state), state);
  if (state.data === null) return clip(screen("pohunek-work tui", ["loading..."], state), state);
  if (layout.tooSmall) {
    return clip([toSafe(`terminal too small (${state.size.columns.toString()}x${state.size.rows.toString()})`)], state);
  }
  if (state.overlay === "sessions") return clip(sessionsScreen(state), state);
  const item = selectedRow(state);
  if (state.overlay === "chooser" && item !== null) return clip(chooserScreen(state, item), state);
  if (state.overlay === "detail" && item !== null) {
    const body = detailLines(state, item).flatMap((line) => wrap(line, state.size.columns));
    return clip(screen("detail  (Tab or Esc closes)", body, state, state.detailTop), state);
  }

  const { payload, cliVersion, receivedAt } = state.data;
  const top = [headerLine(state, payload, receivedAt), ...bannerLines(state, payload, cliVersion)];
  const table = tableLines(state, layout, payload);
  const tableHeight = 1 + layout.bodyHeight;
  const paddedTable = [...table, ...Array<SafeText>(Math.max(0, tableHeight - table.length)).fill(toSafe(""))];
  let middle = paddedTable;
  if (layout.wide) {
    const pane = paneLines(state, layout.detailWidth, tableHeight);
    middle = paddedTable.map((line, index) =>
      concat(fit(line, layout.tableWidth), PANE_SEPARATOR, pane[index] ?? toSafe("")),
    );
  }
  return clip([...top, ...middle, statusLine(state)], state);
}
