import { Box, Text, useStdout } from "ink";
import { useEffect, useRef, type ReactNode } from "react";
import type { ActionChoice, CreatedSession, LaunchOptions } from "../../session-launch/index.ts";
import { ActionButton, Message, safeText, shorten } from "../components.tsx";
import { FORM_FOOTER, useLayout } from "../layout.tsx";
import { MouseZone } from "../mouse.tsx";
import { formFieldLabel, formFields, formPick, LAST_PICK_FIELD, submitIndex } from "./fields.ts";
import { listWindowStart } from "../views.tsx";
import type { LaunchForm } from "./launch-form.ts";

export function FormView({ form, options, actions, assistant, created, busy, loading, onFocus, onPickChoice, onScrollChoices, onFollowHighlight, onSubmit, onCancel }: {
  readonly form: LaunchForm; readonly options: LaunchOptions | null; readonly actions: readonly ActionChoice[]; readonly assistant: boolean;
  readonly created: CreatedSession | null; readonly busy: boolean; readonly loading: boolean;
  readonly onFocus: (index: number) => void;
  readonly onPickChoice: (index: number) => void;
  readonly onScrollChoices: (direction: -1 | 1, max: number) => void;
  /** Moves the choice window to start at this choice; called when the highlight moves, so it stays visible. */
  readonly onFollowHighlight: (start: number) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { stdout } = useStdout();
  const layout = useLayout();
  const compact = stdout.rows < layout.compactRows || stdout.columns < layout.compactColumns;
  const pick = formPick(form, options, actions, assistant);
  const choices = pick?.matches ?? [];
  const highlight = pick?.highlight ?? -1;
  const choiceLimit = compact ? 2 : layout.visibleChoices;
  // The window is where the wheel left it. The highlight pulls it along whenever the highlight, the query or the
  // matches change; a wheel step alone changes none of them and keeps the window where it is.
  const choiceStart = Math.min(form.choice, Math.max(0, choices.length - choiceLimit));
  const matchKey = choices.map((choice) => choice.label).join("\n");
  const followed = useRef({ highlight, search: form.search, matchKey });
  useEffect(() => {
    const last = followed.current;
    if (last.highlight === highlight && last.search === form.search && last.matchKey === matchKey) return;
    followed.current = { highlight, search: form.search, matchKey };
    onFollowHighlight(listWindowStart(form.choice, highlight, choices.length, choiceLimit));
  }, [choiceLimit, choices.length, form.choice, form.search, highlight, matchKey, onFollowHighlight]);
  const fieldName = formFieldLabel(assistant, form.focus).toLowerCase();
  const submitFocused = created === null && form.focus === submitIndex(assistant);
  const hostChoices = options?.hosts.map((host) => host.label) ?? [];
  const agentChoices = options?.agents.filter((agent) => !assistant || agent.assistantCapable).map((agent) => agent.label) ?? [];
  // A pick field shows its query in place of its value while the query is typed.
  const pickValue = (value: string, index: number): string => form.focus === index && form.search !== "" ? `search: ${form.search}` : value;
  const fields = [
    pickValue(options?.hosts.find((host) => host.id === form.host)?.label ?? form.host, 0),
    pickValue(options?.projects.find((project) => project.id === form.project)?.label ?? "none", 1),
    pickValue(options?.agents.find((agent) => agent.id === form.agent)?.label ?? "default", 2),
    pickValue(assistant ? form.intent : actions.find((action) => action.id === form.action)?.label ?? "blank session", 3),
    assistant ? "Free-form request unavailable in core CLI" : form.name,
    assistant ? form.branch : form.prompt,
    assistant ? form.baseBranch : form.branch,
    ...(assistant ? [] : [form.baseBranch]),
  ];
  return <Box flexDirection="column">
    <Text bold color="cyan">{assistant ? "NEW ASSISTANT" : "NEW SESSION"}</Text>
    {created === null && !compact && choices.length === 0 && form.search === "" && <Text dimColor>{loading ? `Loading ${form.host} options…` : "Click a field to edit it. Tab moves to the next field."}</Text>}
    {created !== null && <Message color="green" text={`Created ${created.host}/${created.sessionId}. Creation is locked.`} />}
    {created?.warnings.map((warning, index) => <Message key={index} text={`Launch warning: ${warning}`} />)}
    {created === null && options?.warning !== null && options?.warning !== undefined && <Text color="yellow" wrap="truncate-end">{safeText(options.warning)}</Text>}
    {created === null && fields.map((value, index) => <MouseZone key={index} onClick={formFields(assistant)[index]?.disabled === true ? undefined : () => { onFocus(index); }}>
      <Text color={formFields(assistant)[index]?.disabled === true ? "gray" : form.focus === index ? "cyan" : "white"} bold={form.focus === index} wrap="truncate-end">
        {`${form.focus === index ? "▸" : " "} ${formFieldLabel(assistant, index).padEnd(16)} ${index <= LAST_PICK_FIELD ? "‹ " : ""}${shorten(value || (index <= LAST_PICK_FIELD ? "none" : "(empty)"), 60)}${index <= LAST_PICK_FIELD ? " ›" : form.focus === index ? "_" : ""}`}
      </Text>
    </MouseZone>)}
    {created === null && pick !== null && form.search !== "" && <Text dimColor wrap="truncate-end">{safeText(`Search: ${form.search}  ·  ${String(choices.length)} matches  ·  Enter picks the highlighted one`)}</Text>}
    {created === null && pick !== null && form.search !== "" && choices.length === 0 && <Text color="yellow" wrap="truncate-end">{safeText(`No ${fieldName} matches; Backspace edits the query, Esc clears it`)}</Text>}
    {created === null && choices.length > 0 && <MouseZone flexDirection="column" width="100%" onWheel={(direction) => { onScrollChoices(direction, choices.length - choiceLimit); }}>
      <Text dimColor>{`Choose ${fieldName}${choices.length > choiceLimit && !compact ? ` (${choiceStart + 1}–${Math.min(choiceStart + choiceLimit, choices.length)} / ${choices.length}; wheel for more)` : ""}`}</Text>
      {choices.slice(choiceStart, choiceStart + choiceLimit).map((choice, index) => <MouseZone key={`${choiceStart + index}/${choice.label}`} onClick={() => { onPickChoice(choiceStart + index); }}>
        <Text color={choiceStart + index === highlight ? "cyan" : "white"} bold={choiceStart + index === highlight}>{`${choiceStart + index === highlight ? "▸" : " "} ${choiceStart + index + 1}. ${shorten(choice.label, 65)}`}</Text>
      </MouseZone>)}
    </MouseZone>}
    <Box gap={1}>
      {/* The focused submit row carries the same ▸ marker as the fields, so the focus on it is visible. */}
      <ActionButton label={`${submitFocused ? "▸ " : ""}${created === null ? "Create and attach" : "Attach session"}`} onClick={onSubmit} primary />
      <ActionButton label={created === null ? "Cancel" : "Close"} onClick={onCancel} />
    </Box>
    {created === null && !compact && form.focus === 0 && <Text dimColor wrap="truncate-end">{`Hosts: ${hostChoices.join(", ") || "loading"}`}</Text>}
    {created === null && !compact && form.focus === 2 && <Text dimColor wrap="truncate-end">{`Agents: ${agentChoices.join(", ") || "loading"}`}</Text>}
    {created === null && !compact && form.focus === 3 && !assistant && <Text dimColor wrap="truncate-end">{`Actions: blank session, ${actions.map((action) => action.label).join(", ")}`}</Text>}
    {!compact && <Text dimColor wrap="truncate-end">{busy ? "Working…" : created === null ? FORM_FOOTER : "Enter retry attach  Esc close"}</Text>}
  </Box>;
}
