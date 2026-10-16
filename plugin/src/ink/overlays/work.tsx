import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { ListItem } from "../../types/item.ts";
import { ChoiceRow, safeText } from "../components.tsx";

/** The work item overlay: its state and the choice of action, which a click or Enter previews. */
export function WorkDetailOverlay({ detail, choice, onPick }: { readonly detail: ListItem; readonly choice: number; readonly onPick: (index: number, action: string) => void }): ReactNode {
  return <Box flexDirection="column">
    <Text bold color="cyan">WORK ITEM</Text>
    <Text bold wrap="truncate-end">{safeText(detail.issue?.title ?? detail.pull_request?.title ?? detail.key)}</Text>
    <Text dimColor wrap="truncate-end">{safeText(`${detail.project} · ${detail.key}`)}</Text>
    <Text>{safeText(`Next: ${detail.on_turn.actor} · ${detail.on_turn.reason}`)}</Text>
    <Text dimColor>{safeText(`${detail.issue === null ? "No issue" : `Issue: ${detail.issue.state}`} · ${detail.pull_request === null ? "No pull request" : `Pull request: ${detail.pull_request.checks} checks`} · ${detail.sessions.length} session(s)`)}</Text>
    <Text bold>{detail.actions.length === 0 ? "No actions available" : "Choose an action"}</Text>
    {detail.actions.map((action, index) => <ChoiceRow key={action.name} highlighted={index === choice} text={`${index + 1}. ${safeText(action.name)}`} onClick={() => { onPick(index, action.name); }} />)}
    {detail.actions.length > 0 && <Text dimColor>Click or Enter previews the selected action; Run executes it</Text>}
  </Box>;
}
