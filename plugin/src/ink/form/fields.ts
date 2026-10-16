// The launch form's fields: their labels and kinds, the choices of the pick fields, and the focus moves and text
// edits that work on them. The new-session and the Assistant forms each have a layout; the submit row follows the last field.
import type { ActionChoice, LaunchOptions } from "../../session-launch/index.ts";
import { fuzzyFilter } from "../../tui/search.ts";
import type { LaunchForm } from "./launch-form.ts";

/** A field of the form. A pick field edits its choice through the query; a text field edits the form key `text`. */
export interface FormField {
  readonly label: string;
  readonly pick: boolean;
  readonly text: "name" | "prompt" | "branch" | "baseBranch" | null;
  /** The field is shown but cannot be focused. */
  readonly disabled?: boolean;
}

const NEW_SESSION_FIELDS: readonly FormField[] = [
  { label: "Host", pick: true, text: null },
  { label: "Project", pick: true, text: null },
  { label: "Agent", pick: true, text: null },
  { label: "Action/template", pick: true, text: null },
  { label: "Name", pick: false, text: "name" },
  { label: "Prompt", pick: false, text: "prompt" },
  { label: "Branch", pick: false, text: "branch" },
  { label: "Base branch", pick: false, text: "baseBranch" },
];

const ASSISTANT_FIELDS_LIST: readonly FormField[] = [
  { label: "Host", pick: true, text: null },
  { label: "Project", pick: true, text: null },
  { label: "Agent", pick: true, text: null },
  { label: "Intent", pick: true, text: null },
  { label: "Request", pick: false, text: null, disabled: true },
  { label: "Branch", pick: false, text: "branch" },
  { label: "Base branch", pick: false, text: "baseBranch" },
];

/** The fields of the form: the new-session form or the Assistant form. */
export function formFields(assistant: boolean): readonly FormField[] {
  return assistant ? ASSISTANT_FIELDS_LIST : NEW_SESSION_FIELDS;
}

/** The focus index of the submit row, the one after the last field. */
export function submitIndex(assistant: boolean): number {
  return formFields(assistant).length;
}

/** Focus indexes of the pick fields are 0 to this one (Host to Agent, then Action or Intent). */
export const LAST_PICK_FIELD = NEW_SESSION_FIELDS.findLastIndex((field) => field.pick);

export function formFieldLabel(assistant: boolean, index: number): string {
  return formFields(assistant)[index]?.label ?? "";
}

/** The field Tab (wrapping) or ↑/↓ (stopping at the first and last field) moves to; a disabled field is skipped. */
export function nextField(focus: number, step: 1 | -1, assistant: boolean, wrap: boolean): number {
  const count = submitIndex(assistant) + 1;
  let next = focus + step;
  if (wrap) next = (next + count) % count;
  else if (next < 0 || next >= count) return focus;
  return formFields(assistant)[next]?.disabled ? next + step : next;
}

/** Focus moves to another field; the query and highlight belong to the field they were typed in. */
export function moveFocus(form: LaunchForm, focus: number): LaunchForm {
  return focus === form.focus ? form : { ...form, focus, search: "", highlight: 0, choice: 0 };
}

export function changeTextField(form: LaunchForm, input: string, assistant: boolean, erase: boolean): LaunchForm {
  const field = formFields(assistant)[form.focus]?.text ?? null;
  if (field === null) return form;
  const value = form[field];
  const clean = field === "prompt" ? input : input.replaceAll("\r", " ").replaceAll("\n", " ");
  return { ...form, [field]: erase ? value.slice(0, -1) : value + clean };
}

export const INTENTS = ["help", "setup", "project", "update", "debug"] as const;
export type Intent = (typeof INTENTS)[number];

/** One choice of a pick field; `value` is what picking it stores, null is the default choice. */
export interface PickItem {
  readonly label: string;
  readonly value: string | null;
  /** The texts the field's query is matched against. */
  readonly terms: readonly string[];
}

/** The form fields the pick needs; the form state keeps them under these names. */
export interface PickForm {
  readonly host: string;
  readonly project: string | null;
  readonly agent: string | null;
  readonly action: string | null;
  readonly intent: Intent;
  readonly focus: number;
  readonly search: string;
  readonly highlight: number;
}

export interface PickView {
  /** The choices that match the query, best match first; every choice when the query is blank. */
  readonly matches: readonly PickItem[];
  /** Index in `matches` of the highlighted choice; -1 when none is highlighted. */
  readonly highlight: number;
}

function choiceItems(options: LaunchOptions | null, actions: readonly ActionChoice[], assistant: boolean): Record<number, PickItem[]> {
  const hosts = (options?.hosts ?? []).map((host): PickItem => ({ label: host.label, value: host.id, terms: [host.id, host.label] }));
  const projects = (options?.projects ?? []).map((project): PickItem => ({ label: project.label, value: project.id, terms: [project.id, project.label] }));
  const agents = (options?.agents ?? []).filter((agent) => !assistant || agent.assistantCapable)
    .map((agent): PickItem => ({ label: agent.label, value: agent.id, terms: [agent.id, agent.label] }));
  const agentChoices: PickItem[] = [{ label: "default", value: null, terms: ["default"] }, ...agents];
  const fourth: PickItem[] = assistant
    ? INTENTS.map((intent): PickItem => ({ label: intent, value: intent, terms: [intent] }))
    : [{ label: "blank session", value: null, terms: ["blank session"] }, ...actions.map((action): PickItem => ({ label: action.label, value: action.id, terms: [action.id, action.label] }))];
  return { 0: hosts, 1: projects, 2: agentChoices, 3: fourth };
}

/** The value the form currently stores in pick field `focus`. */
function currentValue(form: PickForm, assistant: boolean): string | null {
  if (form.focus === 0) return form.host;
  if (form.focus === 1) return form.project;
  if (form.focus === 2) return form.agent;
  return assistant ? form.intent : form.action;
}

/** The choices of the focused pick field narrowed by its query, or null when the focused field is a text field. */
export function formPick(form: PickForm, options: LaunchOptions | null, actions: readonly ActionChoice[], assistant: boolean): PickView | null {
  if (form.focus < 0 || form.focus > LAST_PICK_FIELD) return null;
  const items = choiceItems(options, actions, assistant)[form.focus] ?? [];
  const matches = fuzzyFilter(items, form.search, (item) => item.terms);
  if (form.search === "") return { matches, highlight: matches.findIndex((item) => item.value === currentValue(form, assistant)) };
  return { matches, highlight: matches.length === 0 ? -1 : Math.max(0, Math.min(form.highlight, matches.length - 1)) };
}
