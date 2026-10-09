import { Box, Text, useStdout } from "ink";
import type { ReactNode } from "react";
import { MouseZone } from "./mouse.tsx";
import { layout } from "./config.ts";

/** Keep terminal control bytes and bidi overrides out of text supplied by external systems. */
export function safeText(value: string): string {
  let output = "";
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    output += point < 32 || (point >= 127 && point <= 159) || (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069) ? " " : character;
  }
  return output;
}

export function shorten(value: string, limit: number): string {
  const clean = safeText(value);
  if (limit <= 1 || clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1)}…`;
}

export interface ScreenFrameProps {
  readonly title: string;
  readonly tabs?: readonly string[];
  readonly activeTab?: number;
  readonly onTab?: (index: number) => void;
  readonly subtitle?: string | null;
  readonly footer: string;
  readonly status?: string | null;
  readonly children: ReactNode;
}

export function ScreenFrame({ title, tabs, activeTab, onTab, subtitle, footer, status, children }: ScreenFrameProps): ReactNode {
  const { stdout } = useStdout();
  return (
    <Box flexDirection="column" width="100%" height={stdout.rows} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">{safeText(title)}</Text>
        {stdout.columns >= layout.compactColumns && <Text dimColor>{"CONTROL CENTER"}</Text>}
      </Box>
      {tabs !== undefined && <Box gap={1} marginTop={1}>{tabs.map((tab, index) =>
        <MouseZone key={tab} onClick={onTab === undefined ? undefined : () => { onTab(index); }}>
          <Text bold={activeTab === index} color={activeTab === index ? "cyan" : "white"} inverse={activeTab === index}>{` ${index + 1} ${safeText(stdout.columns < layout.compactColumns ? tab.slice(0, 3) : tab)} `}</Text>
        </MouseZone>)}</Box>}
      <Text dimColor>{"─".repeat(Math.max(1, stdout.columns - 2))}</Text>
      {subtitle !== undefined && subtitle !== null && <Text color="yellow">{safeText(subtitle)}</Text>}
      <Box flexDirection="column" flexGrow={1}>{children}</Box>
      {status !== undefined && status !== null && <Text color="yellow" wrap="truncate-end">{safeText(status)}</Text>}
      <Text dimColor wrap="truncate-end">{safeText(footer)}</Text>
    </Box>
  );
}

export interface MenuRowProps {
  readonly selected: boolean;
  readonly primary: string;
  readonly secondary?: string | null;
  readonly badge?: string | null;
  readonly onClick?: () => void;
  readonly onWheel?: (direction: -1 | 1) => void;
  readonly width?: number;
}

export function MenuRow({ selected, primary, secondary, badge, onClick, onWheel, width = 80 }: MenuRowProps): ReactNode {
  return (
    <MouseZone width="100%" flexDirection="column" onClick={onClick} onWheel={onWheel}>
      <Box gap={1}>
        <Text color={selected ? "cyan" : "gray"}>{selected ? "▸" : " "}</Text>
        <Text bold={selected} color={selected ? "cyan" : "white"} wrap="truncate-end">{shorten(primary, Math.max(8, width - (badge?.length ?? 0) - 7))}</Text>
        {badge !== undefined && badge !== null && <Text color={badge === "Needs you" ? "yellow" : "green"}>{` ${safeText(badge)} `}</Text>}
      </Box>
      {secondary !== undefined && secondary !== null && <Text dimColor wrap="truncate-end">{`  ${shorten(secondary, Math.max(8, width - 4))}`}</Text>}
    </MouseZone>
  );
}

export function ActionButton({ label, onClick, primary = false }: { readonly label: string; readonly onClick: () => void; readonly primary?: boolean }): ReactNode {
  return <MouseZone onClick={onClick}><Text color={primary ? "black" : "cyan"} {...(primary ? { backgroundColor: "cyan" } : {})}>{` ${safeText(label)} `}</Text></MouseZone>;
}

export function Section({ title, children }: { readonly title: string; readonly children: ReactNode }): ReactNode {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold underline>{safeText(title)}</Text>
      {children}
    </Box>
  );
}

export function Message({ text, color = "yellow" }: { readonly text: string; readonly color?: "yellow" | "red" | "green" }): ReactNode {
  return <Text color={color}>{safeText(text)}</Text>;
}
