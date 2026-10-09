import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ListItem } from "../types/item.ts";
import type { ControlHost, ControlNotification, ControlScreen, ControlSession, ControlSnapshot, ControlSubagent } from "../control/types.ts";
import { MenuRow, Message, Section, safeText, shorten } from "./components.tsx";

export type ViewName = "Work" | "Sessions" | "Hosts" | "Activity";
export type ActivityScope = "Recent" | "Unread" | "Archived";

function unresolved(notification: ControlNotification): boolean {
  return notification.status !== "archived" && notification.status !== "deleted" && notification.status !== "acknowledged" &&
    (notification.kind === "action_required" || notification.severity === "error");
}

export function sessionGroup(session: ControlSession, notifications: readonly ControlNotification[]): string {
  if (session.external || session.runtimeState === "lost" || session.runtimeState === "conflicting" || session.runtimeState === "incompatible") return "Unavailable";
  if (notifications.some((record) => record.host === session.host && record.sessionId === session.id && unresolved(record))) return "Needs you";
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
      (left.name ?? left.id).localeCompare(right.name ?? right.id) || left.host.localeCompare(right.host) || left.id.localeCompare(right.id);
  });
}

export function activityRecords(snapshot: ControlSnapshot, scope: ActivityScope): ControlNotification[] {
  return snapshot.notifications.filter((notification) => scope === "Recent" ? notification.status !== "archived" && notification.status !== "deleted" :
    scope === "Unread" ? notification.status === "unread" : notification.status === "archived")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function WorkView({ rows, selected, limit, filter }: { readonly rows: readonly ListItem[] | null; readonly selected: number; readonly limit: number; readonly filter: string }): ReactNode {
  if (rows === null) return <Message text="Loading work items…" />;
  if (rows.length === 0) return <Message text="No work items match these filters" />;
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column">
    <Text dimColor>{safeText(filter)}</Text>
    {rows.slice(start, start + limit).map((item: ListItem, index) => <MenuRow key={`${item.project}/${item.key}`} selected={start + index === selected}
      primary={`${item.project}  ${item.key}  ${shorten(item.issue?.title ?? item.pull_request?.title ?? "", 50)}`}
      badge={item.on_turn.actor === "me" ? "Needs you" : item.on_turn.actor}
      secondary={item.on_turn.reason} />)}
  </Box>;
}

export function SessionsView({ snapshot, sessions, selected, limit, project }: {
  readonly snapshot: ControlSnapshot | null; readonly sessions: readonly ControlSession[]; readonly selected: number;
  readonly limit: number; readonly project: string | null;
}): ReactNode {
  if (snapshot === null) return <Message text="Loading sessions…" />;
  if (sessions.length === 0) return <Message text="No sessions match this project" />;
  const counts = GROUPS.map((group) => `${group} ${sessions.filter((session) => sessionGroup(session, snapshot.notifications) === group).length}`).join("  ");
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column">
    <Text dimColor>{safeText(`${counts}${project === null ? "" : `  project: ${project}`}`)}</Text>
    {sessions.slice(start, start + limit).map((session, index) => <MenuRow key={`${session.host}/${session.id}`}
      selected={start + index === selected}
      primary={`${session.projectLabel ?? session.projectId ?? "unassigned"}  ${session.name ?? session.id}`}
      badge={sessionGroup(session, snapshot.notifications)}
      secondary={`${session.host} · ${session.agent} · ${session.activity ?? session.state}${session.subagentCount > 0 ? ` · ${session.subagentCount} subagents` : ""}`} />)}
  </Box>;
}

export function HostsView({ hosts, selected }: { readonly hosts: readonly ControlHost[]; readonly selected: number }): ReactNode {
  if (hosts.length === 0) return <Message text="No hosts discovered" />;
  return <Box flexDirection="column">{hosts.map((host, index) => <MenuRow key={host.route} selected={index === selected}
    primary={`${host.name} (${host.route})`} badge={host.dialable ? host.classification : "unavailable"} secondary={host.dialable ? host.daemonVersion : "No dialable identity"} />)}</Box>;
}

export function ActivityView({ records, selected, scope, limit }: {
  readonly records: readonly ControlNotification[]; readonly selected: number; readonly scope: ActivityScope; readonly limit: number;
}): ReactNode {
  if (records.length === 0) return <Message text={`No ${scope.toLowerCase()} notifications`} />;
  const start = Math.max(0, selected - Math.floor(limit / 2));
  return <Box flexDirection="column">
    <Text dimColor>{`Scope: ${scope}  (c cycle, Enter read/open, a acknowledge, x archive)`}</Text>
    {records.slice(start, start + limit).map((record, index) => <MenuRow key={`${record.host}/${record.id}`}
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

export function SessionDetail({ session, screen }: { readonly session: ControlSession; readonly screen: ControlScreen | null }): ReactNode {
  const metadata = Object.entries(session.metadata);
  return <Box flexDirection="column">
    <Section title="Session">
      <Text>{safeText(`${session.name ?? session.id} · ${session.host} · ${session.agent}`)}</Text>
      <Text>{safeText(`State: ${session.state} / ${session.activity ?? "unknown"} / ${session.runtimeState ?? "unknown"}`)}</Text>
      <Text>{safeText(`Project: ${session.projectLabel ?? session.projectId ?? "unassigned"}`)}</Text>
      <Text>{safeText(`Branch: ${session.branch ?? "none"}`)}</Text>
      <Text>{safeText(`Path: ${session.worktreePath ?? session.cwd}`)}</Text>
    </Section>
    <Section title="Subagents">
      {session.subagents.length === 0 ? <Text dimColor>None reported</Text> : subagentRows(session.subagents).map(({ agent, depth }) =>
        <Text key={`${agent.provider}/${agent.id}`}>{safeText(`${"  ".repeat(depth)}${agent.provider} ${agent.agentType ?? "agent"} ${agent.lifecycle} ${agent.activity ?? ""}`)}</Text>)}
    </Section>
    <Section title="Links and metadata">
      {metadata.length === 0 ? <Text dimColor>No metadata</Text> : metadata.map(([key, value]) => <Text key={key}>{safeText(`${key}: ${value}`)}</Text>)}
    </Section>
    <Section title="Terminal screen">
      {screen === null ? <Text dimColor>Press p to load screen</Text> : screen.visibleLines.slice(-8).map((line, index) => <Text key={index}>{shorten(line, 120)}</Text>)}
    </Section>
    <Text dimColor>o attach  r resume  f fork  e rename  m metadata  p screen  x stop  D remove  l link  u folder  c/C copy  Esc back</Text>
  </Box>;
}
