import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ControlNotification } from "../../control/index.ts";
import { safeText, Section } from "../components.tsx";

/** The notification overlay: the full text of one notification. */
export function NotificationOverlay({ record }: { readonly record: ControlNotification }): ReactNode {
  return <Box flexDirection="column">
    <Section title="NOTIFICATION">
      <Text bold wrap="truncate-end">{safeText(record.title)}</Text>
      <Text dimColor>{safeText(`${record.host} · ${record.status} · ${record.createdAt}`)}</Text>
      <Text wrap="wrap">{safeText(record.body)}</Text>
    </Section>
    <Text dimColor>{record.sessionId === null ? "No linked session" : `Linked session: ${safeText(record.sessionId)}`}</Text>
  </Box>;
}
