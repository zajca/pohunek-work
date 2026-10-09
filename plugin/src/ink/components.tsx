import { Box, Text } from "ink";
import type { ReactNode } from "react";

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
  readonly subtitle?: string | null;
  readonly footer: string;
  readonly status?: string | null;
  readonly children: ReactNode;
}

export function ScreenFrame({ title, tabs, activeTab, subtitle, footer, status, children }: ScreenFrameProps): ReactNode {
  return (
    <Box flexDirection="column" width="100%">
      <Box gap={1}>
        <Text bold color="cyan">{safeText(title)}</Text>
        {tabs?.map((tab, index) => <Text key={tab} inverse={activeTab === index}>{` ${safeText(tab)} `}</Text>)}
      </Box>
      {subtitle !== undefined && subtitle !== null && <Text dimColor>{safeText(subtitle)}</Text>}
      <Box flexDirection="column" marginTop={1}>{children}</Box>
      {status !== undefined && status !== null && <Text color="yellow">{safeText(status)}</Text>}
      <Text dimColor>{safeText(footer)}</Text>
    </Box>
  );
}

export interface MenuRowProps {
  readonly selected: boolean;
  readonly primary: string;
  readonly secondary?: string | null;
  readonly badge?: string | null;
}

export function MenuRow({ selected, primary, secondary, badge }: MenuRowProps): ReactNode {
  return (
    <Box gap={1}>
      <Text {...(selected ? { color: "cyan" } : {})}>{selected ? ">" : " "}</Text>
      <Text bold={selected}>{safeText(primary)}</Text>
      {badge !== undefined && badge !== null && <Text color="yellow">{safeText(badge)}</Text>}
      {secondary !== undefined && secondary !== null && <Text dimColor>{safeText(secondary)}</Text>}
    </Box>
  );
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
