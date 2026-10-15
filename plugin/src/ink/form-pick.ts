// The choices of the pick fields of the new-session and assistant forms, narrowed by the field's own query.
import type { ActionChoice, LaunchOptions } from "../session-launch/index.ts";
import { fuzzyFilter } from "../tui/search.ts";

/** Focus indexes of the pick fields are 0 (Host) to this one (Agent, then Action or Intent). */
export const LAST_PICK_FIELD = 3;
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
