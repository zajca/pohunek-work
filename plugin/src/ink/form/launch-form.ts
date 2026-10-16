/** The launch form's state; the pick fields' query and highlight belong to the field they were typed in. */
export interface LaunchForm {
  readonly host: string;
  readonly project: string | null;
  readonly agent: string | null;
  readonly action: string | null;
  readonly name: string;
  readonly prompt: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly intent: "setup" | "project" | "update" | "debug" | "help";
  readonly focus: number;
  /** The query of the focused pick field; it narrows that field's choices. */
  readonly search: string;
  /** Index in the matching choices of the highlighted one, moved by ←/→ and reset by typing. */
  readonly highlight: number;
  /** First choice shown in the choice list. */
  readonly choice: number;
}

export const FORM_FIELDS = 9;
export const ASSISTANT_FIELDS = 8;
/** The Assistant form's Request row is disabled, so focus never stops on it. */
export const ASSISTANT_DISABLED_FIELD = 4;

export function formFieldLabel(assistant: boolean, index: number): string {
  return assistant ? ["Host", "Project", "Agent", "Intent", "Request", "Branch", "Base branch"][index] ?? "" :
    ["Host", "Project", "Agent", "Action/template", "Name", "Prompt", "Branch", "Base branch"][index] ?? "";
}
