import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ListItem } from "../types/item.ts";
import type { ControlHost, ControlNotification, ControlScreen, ControlSession, ControlSnapshot, ControlSubagent } from "../control/types.ts";
import { MenuRow, Message, safeText, shorten } from "./components.tsx";
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
  readonly onSelect: (index: number) => void;
  readonly onWheel: (direction: -1 | 1) => void;
  readonly width: number;
}

function EmptyState({ title, hint }: { readonly title: string; readonly hint: string }): ReactNode {
  return <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
    <Text bold>{title}</Text>
    <Text dimColor wrap="truncate-end">{safeText(hint)}</Text>
  </Box>;
}

export function WorkView({ rows, selected, limit, filter, warning, searchActive, searchText, onSelect, onWheel, width }: { readonly rows: readonly ListItem[] | null; readonly selected: number; readonly limit: number; readonly filter: string; readonly warning: string | null; readonly searchActive: boolean; readonly searchText: string } & ListInteraction): ReactNode {
  const filterLine = <Text color={searchActive ? "cyan" : "gray"} wrap="truncate-end">{searchActive ? `Search  ${safeText(searchText)}_  ·  Enter apply  ·  Esc clear` : safeText(filter)}</Text>;
  if (rows === null) return <Box flexDirection="column">{filterLine}{warning === null ? <Message text="Loading work items…" /> : <EmptyState title="Work is unavailable" hint={warning} />}</Box>;
  if (rows.length === 0) return <Box flexDirection="column"><Text bold>WORK  0 items</Text>{filterLine}<EmptyState title="No work items match" hint="Change Mine or Search to see other work." /></Box>;
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column">
    <Text bold>{`WORK  ${rows.length} items`}</Text>
    {filterLine}
    {rows.slice(start, start + limit).map((item: ListItem, index) => <MenuRow key={`${item.project}/${item.key}`} selected={start + index === selected}
      onClick={() => { onSelect(start + index); }} onWheel={onWheel} width={width}
      primary={`${item.project} / ${item.key}  ${item.issue?.title ?? item.pull_request?.title ?? ""}`}
      badge={item.on_turn.actor === "me" ? "Needs you" : item.on_turn.actor}
      secondary={item.on_turn.reason} />)}
  </Box>;
}

export function SessionsView({ snapshot, sessions, selected, limit, project, onSelect, onWheel, width }: {
  readonly snapshot: ControlSnapshot | null; readonly sessions: readonly ControlSession[]; readonly selected: number;
  readonly limit: number; readonly project: string | null;
} & ListInteraction): ReactNode {
  if (snapshot === null) return <Message text="Loading sessions…" />;
  if (sessions.length === 0) return <EmptyState title="No sessions" hint={project === null ? "Create a session to get started." : "Change the project filter or create a session."} />;
  const counts = GROUPS.map((group) => `${group} ${sessions.filter((session) => sessionGroup(session, snapshot.notifications) === group).length}`).join("  ");
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column">
    <Text bold>{`SESSIONS  ${sessions.length}`}</Text>
    <Text dimColor>{safeText(`${counts}${project === null ? "" : `  project: ${project}`}`)}</Text>
    {sessions.slice(start, start + limit).map((session, index) => <MenuRow key={`${session.host}/${session.id}`}
      onClick={() => { onSelect(start + index); }} onWheel={onWheel} width={width}
      selected={start + index === selected}
      primary={`${session.projectLabel ?? session.projectId ?? "unassigned"}  ${session.name ?? session.id}`}
      badge={sessionGroup(session, snapshot.notifications)}
      secondary={`${session.host} · ${session.agent} · ${session.activity ?? session.state}${session.subagentCount > 0 ? ` · ${session.subagentCount} subagents` : ""}`} />)}
  </Box>;
}

export function HostsView({ hosts, selected, limit, onSelect, onWheel, width }: { readonly hosts: readonly ControlHost[]; readonly selected: number; readonly limit: number } & ListInteraction): ReactNode {
  if (hosts.length === 0) return <EmptyState title="No hosts discovered" hint="Refresh after the local daemon starts." />;
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column"><Text bold>{`HOSTS  ${hosts.length}`}</Text>{hosts.slice(start, start + limit).map((host, index) => <MenuRow key={host.route} selected={start + index === selected}
    onClick={() => { onSelect(start + index); }} onWheel={onWheel} width={width}
    primary={`${host.name} (${host.route})`} badge={host.dialable ? host.classification : "unavailable"} secondary={host.dialable ? host.daemonVersion : "No dialable identity"} />)}</Box>;
}

export function ActivityView({ records, selected, scope, limit, onSelect, onWheel, width }: {
  readonly records: readonly ControlNotification[]; readonly selected: number; readonly scope: ActivityScope; readonly limit: number;
} & ListInteraction): ReactNode {
  if (records.length === 0) return <EmptyState title={`No ${scope.toLowerCase()} notifications`} hint="Choose another scope to see older activity." />;
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column">
    <Text bold>{`ACTIVITY  ${records.length}`}</Text>
    <Text dimColor>{`Scope: ${scope}`}</Text>
    {records.slice(start, start + limit).map((record, index) => <MenuRow key={`${record.host}/${record.id}`}
      onClick={() => { onSelect(start + index); }} onWheel={onWheel} width={width}
      selected={start + index === selected} primary={shorten(record.title, 65)}
      badge={record.status} secondary={`${record.host} · ${record.kind} · ${record.createdAt}`} />)}
  </Box>;
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

export function SessionDetail({ session, screen, offset, height, onWheel }: {
  readonly session: ControlSession; readonly screen: ControlScreen | null; readonly offset: number; readonly height: number;
  readonly onWheel: (direction: -1 | 1) => void;
}): ReactNode {
  const metadata = Object.entries(session.metadata);
  const lines: { text: string; heading?: boolean }[] = [
    { text: "SESSION", heading: true },
    { text: `${session.name ?? session.id} · ${session.host} · ${session.agent}` },
    { text: `State  ${session.state} / ${session.activity ?? "unknown"} / ${session.runtimeState ?? "unknown"}` },
    { text: `Project  ${session.projectLabel ?? session.projectId ?? "unassigned"}   Branch  ${session.branch ?? "none"}` },
    { text: `Path  ${session.worktreePath ?? session.cwd}` },
    { text: `SUBAGENTS  ${session.subagents.length}`, heading: true },
    ...subagentRows(session.subagents).map(({ agent, depth }) => ({ text: `${"  ".repeat(depth)}${agent.provider} ${agent.agentType ?? "agent"} ${agent.lifecycle} ${agent.activity ?? ""}` })),
    { text: `LINKS AND METADATA  ${metadata.length}`, heading: true },
    ...metadata.map(([key, value]) => ({ text: `${key}: ${value}` })),
    { text: "TERMINAL SCREEN", heading: true },
    ...(screen === null ? [{ text: "Press p or click Screen to load" }] : screen.visibleLines.map((line) => ({ text: line }))),
  ];
  const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - height)));
  return <MouseZone flexDirection="column" width="100%" onWheel={onWheel}>
    {lines.slice(start, start + height).map((line, index) => <Text key={start + index} bold={line.heading === true} color={line.heading ? "cyan" : "white"} wrap="truncate-end">{safeText(line.text)}</Text>)}
    {lines.length > height && <Text dimColor>{`${start + 1}–${Math.min(start + height, lines.length)} / ${lines.length}  ·  scroll with wheel or PageUp/PageDown`}</Text>}
  </MouseZone>;
}
