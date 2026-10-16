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

