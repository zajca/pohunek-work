import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ListItem } from "../types/item.ts";
import type { DoOutcome } from "../tui/decode.ts";
import type { ControlHost, ControlNotification, ControlScreen, ControlSession, ControlSnapshot, ControlSubagent } from "../control/types.ts";
import { MenuRow, Message, safeText, Section, shorten } from "./components.tsx";
import { MouseZone } from "./mouse.tsx";
import { isUnresolvedAction } from "./attention.ts";

export type ViewName = "Work" | "Sessions" | "Hosts" | "Activity";
export type ActivityScope = "Recent" | "Unread" | "Archived";

export function sessionGroup(session: ControlSession, notifications: readonly ControlNotification[]): string {
  if (session.external || session.runtimeState === "lost" || session.runtimeState === "conflicting" || session.runtimeState === "incompatible") return "Unavailable";
  if (notifications.some((record) => record.host === session.host && record.sessionId === session.id && isUnresolvedAction(record))) return "Needs you";
  if (session.state === "blocked" || session.activity === "blocked") return "Needs you";
  if (session.state === "running" || session.state === "working" || session.state === "starting" || session.state === "reconnecting") {
    return session.activity === "idle" ? "Ready" : "Running";
  }
  return "Unavailable";
}

const GROUPS = ["Needs you", "Running", "Ready", "Unavailable"] as const;

export function orderedSessions(snapshot: ControlSnapshot, project: string | null): ControlSession[] {
  return snapshot.sessions.filter((session) => project === null || session.projectLabel === project || session.projectId === project).sort((left, right) => {
    const byGroup = GROUPS.indexOf(sessionGroup(left, snapshot.notifications) as (typeof GROUPS)[number]) -
      GROUPS.indexOf(sessionGroup(right, snapshot.notifications) as (typeof GROUPS)[number]);
    return byGroup || (left.projectLabel ?? left.projectId ?? "").localeCompare(right.projectLabel ?? right.projectId ?? "") ||
      (left.name ?? left.id).localeCompare(right.name ?? right.id, undefined, { numeric: true }) || left.host.localeCompare(right.host) || left.id.localeCompare(right.id);
  });
}

export function activityRecords(snapshot: ControlSnapshot, scope: ActivityScope): ControlNotification[] {
  return snapshot.notifications.filter((notification) => scope === "Recent" ? notification.status !== "archived" && notification.status !== "deleted" :
    scope === "Unread" ? notification.status === "unread" : notification.status === "archived")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

interface ListInteraction {
  /** A press on a row; the caller decides whether it only selects or also opens. */
  readonly onRowClick: (index: number) => void;
  readonly onWheel: (direction: -1 | 1) => void;
  readonly width: number;
}

function EmptyState({ title, hint }: { readonly title: string; readonly hint: string }): ReactNode {
  return <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
    <Text bold>{title}</Text>
    <Text dimColor wrap="truncate-end">{safeText(hint)}</Text>
  </Box>;
}

export function WorkView({ rows, selected, limit, filter, warning, searchActive, searchText, onRowClick, onWheel, width }: { readonly rows: readonly ListItem[] | null; readonly selected: number; readonly limit: number; readonly filter: string; readonly warning: string | null; readonly searchActive: boolean; readonly searchText: string } & ListInteraction): ReactNode {
  const filterLine = <Text color={searchActive ? "cyan" : "gray"} wrap="truncate-end">{searchActive ? `Search  ${safeText(searchText)}_  ·  Enter apply  ·  Esc clear` : safeText(filter)}</Text>;
  if (rows === null) return <Box flexDirection="column">{filterLine}{warning === null ? <Message text="Loading work items…" /> : <EmptyState title="Work is unavailable" hint={warning} />}</Box>;
  if (rows.length === 0) return <Box flexDirection="column"><Text bold>WORK  0 items</Text>{filterLine}<EmptyState title="No work items match" hint="Change Mine or Search to see other work." /></Box>;
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column">
    <Text bold>{`WORK  ${rows.length} items`}</Text>
    {filterLine}
    {rows.slice(start, start + limit).map((item: ListItem, index) => <MenuRow key={`${item.project}/${item.key}`} selected={start + index === selected}
      onClick={() => { onRowClick(start + index); }} onWheel={onWheel} width={width}
      primary={`${item.project} / ${item.key}  ${item.issue?.title ?? item.pull_request?.title ?? ""}`}
      badge={item.on_turn.actor === "me" ? "Needs you" : item.on_turn.actor}
      secondary={item.on_turn.reason} />)}
  </Box>;
}

/** Project chips of the Sessions header: every project with its session count; the active filter is bracketed. */
export function projectChips(snapshot: ControlSnapshot, project: string | null): string {
  const counts = new Map<string, number>();
  for (const session of snapshot.sessions) {
    const label = session.projectLabel ?? session.projectId ?? "unassigned";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const chips = [...counts.keys()].sort().map((label) => `${label === project ? "[" : ""}${label} ${String(counts.get(label) ?? 0)}${label === project ? "]" : ""}`);
  return [`${project === null ? "[all]" : "all"} ${String(snapshot.sessions.length)}`, ...chips].join("  ");
}

export function SessionsView({ snapshot, sessions, selected, limit, project, onRowClick, onWheel, width }: {
  readonly snapshot: ControlSnapshot | null; readonly sessions: readonly ControlSession[]; readonly selected: number;
  readonly limit: number; readonly project: string | null;
} & ListInteraction): ReactNode {
  if (snapshot === null) return <Message text="Loading sessions…" />;
  if (sessions.length === 0) return <EmptyState title="No sessions" hint={project === null ? "Create a session to get started." : "Change the project filter or create a session."} />;
  const groupOf = (session: ControlSession): string => sessionGroup(session, snapshot.notifications);
  const counts = GROUPS.map((group) => `${group} ${sessions.filter((session) => groupOf(session) === group).length}`).join("  ");
  const start = Math.max(0, selected - Math.floor(limit / 2));
  const visible = sessions.slice(start, start + limit);
  return <Box flexDirection="column">
    <Text bold>{`SESSIONS  ${sessions.length}`}</Text>
    <Text dimColor wrap="truncate-end">{safeText(counts)}</Text>
    <Text dimColor wrap="truncate-end">{safeText(`Projects  ${projectChips(snapshot, project)}   P cycles`)}</Text>
    {visible.map((session, index) => {
      const absolute = start + index;
      // The first visible row of each section carries the section's heading.
      const heading = absolute === 0 || groupOf(sessions[absolute - 1] ?? session) !== groupOf(session) || index === 0;
      const count = sessions.filter((item) => groupOf(item) === groupOf(session)).length;
      return <Box key={`${session.host}/${session.id}`} flexDirection="column">
        {heading && <Text bold color={groupOf(session) === "Needs you" ? "yellow" : "cyan"}>{safeText(`${groupOf(session).toUpperCase()}  ${String(count)}`)}</Text>}
        <MenuRow onClick={() => { onRowClick(absolute); }} onWheel={onWheel} width={width}
          selected={absolute === selected}
          primary={`${session.projectLabel ?? session.projectId ?? "unassigned"}  ${session.name ?? session.id}${workLinkOf(session) === null ? "" : "  ⎘"}`}
          badge={session.branch}
          secondary={`${session.host} · ${session.agent} · ${session.activity ?? session.state}${session.subagentCount > 0 ? ` · ${String(session.subagentCount)} subagents` : ""}`} />
      </Box>;
    })}
  </Box>;
}

export function HostsView({ hosts, selected, limit, onRowClick, onWheel, width }: { readonly hosts: readonly ControlHost[]; readonly selected: number; readonly limit: number } & ListInteraction): ReactNode {
  if (hosts.length === 0) return <EmptyState title="No hosts discovered" hint="Refresh after the local daemon starts." />;
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column"><Text bold>{`HOSTS  ${hosts.length}`}</Text>{hosts.slice(start, start + limit).map((host, index) => <MenuRow key={host.route} selected={start + index === selected}
    onClick={() => { onRowClick(start + index); }} onWheel={onWheel} width={width}
    primary={`${host.name} (${host.route})`} badge={host.dialable ? host.classification : "unavailable"} secondary={host.dialable ? host.daemonVersion : "No dialable identity"} />)}</Box>;
}

export function ActivityView({ records, selected, scope, limit, onRowClick, onWheel, width }: {
  readonly records: readonly ControlNotification[]; readonly selected: number; readonly scope: ActivityScope; readonly limit: number;
} & ListInteraction): ReactNode {
  if (records.length === 0) return <EmptyState title={`No ${scope.toLowerCase()} notifications`} hint="Choose another scope to see older activity." />;
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column">
    <Text bold>{`ACTIVITY  ${records.length}`}</Text>
    <Text dimColor>{`Scope: ${scope}`}</Text>
    {records.slice(start, start + limit).map((record, index) => <MenuRow key={`${record.host}/${record.id}`}
      onClick={() => { onRowClick(start + index); }} onWheel={onWheel} width={width}
      selected={start + index === selected} primary={shorten(record.title, 65)}
      badge={record.status} secondary={`${record.host} · ${record.kind} · ${record.createdAt}`} />)}
  </Box>;
}

function previewLines(preview: DoOutcome | string, width: number): string[] {
  if (typeof preview === "string") return ["PLAN UNAVAILABLE", safeText(preview)];
  if (preview.kind === "error") return ["PLAN UNAVAILABLE", safeText(`${preview.err.code}: ${preview.err.msg}`)];
  if (preview.kind !== "ok") return ["PLAN UNAVAILABLE", safeText(preview.message)];
  const lines = [`PLAN PREVIEW  ${safeText(preview.action)}`, safeText(preview.key)];
  for (const field of preview.plan) {
    const value = Array.from(safeText(field.value));
    const prefix = `${field.label}: `;
    const firstWidth = Math.max(1, width - prefix.length);
    lines.push(`${prefix}${value.splice(0, firstWidth).join("")}`);
    while (value.length > 0) lines.push(`  ${value.splice(0, Math.max(1, width - 2)).join("")}`);
  }
  return lines;
}

export function workPreviewMaxOffset(preview: DoOutcome | string, width: number, height: number): number {
  return Math.max(0, previewLines(preview, width).length - height);
}

export function WorkPreview({ preview, width, height, offset, onWheel }: {
  readonly preview: DoOutcome | string; readonly width: number; readonly height: number; readonly offset: number;
  readonly onWheel: (direction: -1 | 1) => void;
}): ReactNode {
  const lines = previewLines(preview, width);
  const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - height)));
  return <MouseZone width="100%" flexDirection="column" onWheel={onWheel}>
    {lines.slice(start, start + height).map((line, index) => <Text key={start + index} bold={start + index === 0} wrap="truncate-end">{line}</Text>)}
    {lines.length > height && <Text dimColor>{`${start + 1}–${Math.min(start + height, lines.length)} / ${lines.length}  ·  wheel or PageUp/PageDown`}</Text>}
  </MouseZone>;
}

function subagentRows(agents: readonly ControlSubagent[]): { agent: ControlSubagent; depth: number }[] {
  const ordered = [...agents].sort((a, b) => a.startedAtMs - b.startedAtMs || a.id.localeCompare(b.id));
  const known = new Set(ordered.map((agent) => `${agent.provider}/${agent.id}`));
  const seen = new Set<string>();
  const rows: { agent: ControlSubagent; depth: number }[] = [];
  const walk = (agent: ControlSubagent, depth: number): void => {
    const id = `${agent.provider}/${agent.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    rows.push({ agent, depth });
    for (const child of ordered) if (child.parentId === agent.id && child.provider === agent.provider) walk(child, depth + 1);
  };
  for (const agent of ordered) if (agent.parentId === null || !known.has(`${agent.provider}/${agent.parentId}`)) walk(agent, 0);
  for (const agent of ordered) walk(agent, 0);
  return rows;
}

/** The work item a session is linked to, from the metadata the plugin and the launch flows write. */
export function workLinkOf(session: ControlSession): string | null {
  return session.metadata["work.link.id"] !== undefined ? session.metadata["work.link.url"] ?? null : session.metadata["link.url"] ?? null;
}

/** One flat panel: status and attention, location, work link, recent activity, output and subagents. */
export function sessionDetailLines(session: ControlSession, screen: ControlScreen | null, notifications: readonly ControlNotification[]): { text: string; heading?: boolean }[] {
  const records = notifications.filter((record) => record.host === session.host && record.sessionId === session.id);
  const attention = records.filter(isUnresolvedAction);
  const recent = records.filter((record) => record.status !== "archived").sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, RECENT_ACTIVITY_ROWS);
  const link = workLinkOf(session);
  const running = session.subagents.filter((agent) => agent.lifecycle === "running").length;
  return [
    { text: `${session.name ?? session.id} · ${session.host} · ${session.agent}`, heading: true },
    { text: `Status  ${session.state} · ${session.activity ?? "unknown"} · ${session.runtimeState ?? "unknown"}` },
    { text: attention.length === 0 ? "Attention  none" : `Attention  ${attention[0]?.title ?? ""}${attention.length > 1 ? ` (+${String(attention.length - 1)})` : ""}` },
    { text: `Project  ${session.projectLabel ?? session.projectId ?? "unassigned"}   Branch  ${session.branch ?? "none"}` },
    { text: `Path  ${session.worktreePath ?? session.cwd}` },
    { text: `Work  ${link ?? "none"}${link === null ? "" : "   l opens"}` },
    { text: "RECENT ACTIVITY", heading: true },
    ...(recent.length === 0 ? [{ text: "  none" }] : recent.map((record) => ({ text: `  ${record.createdAt}  ${record.title}` }))),
    { text: `SUBAGENTS  ${session.subagents.length} (${String(running)} running)`, heading: true },
    ...subagentRows(session.subagents).map(({ agent, depth }) => ({ text: `${"  ".repeat(depth)}${agent.provider} ${agent.agentType ?? "agent"} ${agent.lifecycle} ${agent.activity ?? ""}` })),
    { text: "OUTPUT", heading: true },
    ...(screen === null ? [{ text: "  no output yet; p restarts the read" }] : screen.visibleLines.map((line) => ({ text: line }))),
  ];
}

const RECENT_ACTIVITY_ROWS = 3;

export function sessionDetailMaxOffset(session: ControlSession, screen: ControlScreen | null, height: number, notifications: readonly ControlNotification[]): number {
  return Math.max(0, sessionDetailLines(session, screen, notifications).length - height);
}

/** What a resume or fork will recover, as the owner confirms it. An unknown target is shown as such, never guessed. */
export function RecoveryConfirmation({ action, session }: { readonly action: "resume" | "fork"; readonly session: ControlSession }): ReactNode {
  const target = session.nativeTarget;
  const reference = target.status === "verified" ? `${target.kind === "id" ? "ID" : "path"}: ${target.value}` : "Unknown";
  return <Box flexDirection="column">
    <Section title="RECOVERY TARGET">
      <Text wrap="wrap">{safeText(`Native conversation ${reference}`)}</Text>
      <Text dimColor wrap="wrap">{safeText(`Last native activity: ${session.nativeLastActivityAt ?? "Unknown"}`)}</Text>
    </Section>
    <Message color="red" text={safeText(`Confirm ${action} of ${session.name ?? session.id}? y/N`)} />
  </Box>;
}

export function SessionDetail({ session, screen, notifications, offset, height, onWheel }: {
  readonly session: ControlSession; readonly screen: ControlScreen | null; readonly notifications: readonly ControlNotification[];
  readonly offset: number; readonly height: number; readonly onWheel: (direction: -1 | 1) => void;
}): ReactNode {
  const lines = sessionDetailLines(session, screen, notifications);
  const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - height)));
  return <MouseZone flexDirection="column" width="100%" onWheel={onWheel}>
    {lines.slice(start, start + height).map((line, index) => <Text key={start + index} bold={line.heading === true} color={line.heading ? "cyan" : "white"} wrap="truncate-end">{safeText(line.text)}</Text>)}
    {lines.length > height && <Text dimColor>{`${start + 1}–${Math.min(start + height, lines.length)} / ${lines.length}  ·  scroll with wheel or PageUp/PageDown`}</Text>}
  </MouseZone>;
}

export interface ProjectChoice { readonly label: string | null; readonly count: number }

/** The projects the sessions belong to with their session counts, `all` first; `search` keeps the labels that contain it. */
export function projectChoices(sessions: readonly ControlSession[], search: string): ProjectChoice[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const label = session.projectLabel ?? session.projectId ?? "unassigned";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const needle = search.toLowerCase();
  const projects = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([label, count]) => ({ label, count }));
  // The "all" choice is kept only while its own name matches, so the first highlighted choice is the first match.
  return [{ label: null, count: sessions.length }, ...projects].filter((choice) => choice.label === null ? "all".includes(needle) : choice.label.toLowerCase().includes(needle));
}

export function ProjectPicker({ choices, selected, search, filtering, limit }: {
  readonly choices: readonly ProjectChoice[]; readonly selected: number; readonly search: string; readonly filtering: boolean; readonly limit: number;
}): ReactNode {
  if (choices.length === 0) return <EmptyState title="No project matches" hint="Backspace edits the filter, Esc leaves it." />;
  const start = Math.max(0, Math.min(selected - Math.floor(limit / 2), choices.length - limit));
  return <Box flexDirection="column">
    <Text bold>{`PROJECTS  ${filtering ? "filter" : "search"}: ${search === "" ? "none" : search}${filtering ? "_" : ""}`}</Text>
    {choices.slice(start, start + limit).map((choice, offset) => {
      const index = start + offset;
      return <Text key={choice.label ?? "all"} inverse={index === selected}>{`${index === selected ? "› " : "  "}${choice.label ?? "all projects"}  ${String(choice.count)} sessions`}</Text>;
    })}
  </Box>;
}
