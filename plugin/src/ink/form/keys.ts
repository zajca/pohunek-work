import type { Key } from "ink";
import type { Dispatch, SetStateAction } from "react";
import type { ActionChoice, CreatedSession, LaunchOptions } from "../../session-launch/index.ts";
import { typedText } from "../../tui/search.ts";
import type { Overlay } from "../overlays/types.ts";
import { changeTextField, formFieldLabel, formFields, formPick, LAST_PICK_FIELD, moveFocus, nextField, submitIndex, type PickItem } from "./fields.ts";
import type { LaunchForm } from "./launch-form.ts";

/** What the launch form's keys read and change; the app builds it once per key press. */
export interface FormKeyContext {
  readonly overlay: Overlay;
  /** The standalone new-session window: Esc exits the TUI instead of closing the form. */
  readonly newSessionMode: boolean;
  readonly created: CreatedSession | null;
  readonly attachCreated: () => Promise<void>;
  readonly exit: () => void;
  readonly setOverlay: Dispatch<SetStateAction<Overlay>>;
  readonly setForm: Dispatch<SetStateAction<LaunchForm>>;
  readonly submitForm: () => Promise<void>;
  readonly changeFormChoice: (delta: 1 | -1) => void;
  readonly applyPick: (focus: number, item: PickItem, assistant: boolean) => void;
  readonly form: LaunchForm;
  readonly launchOptions: LaunchOptions | null;
  readonly actions: readonly ActionChoice[];
  readonly bumpStatus: (message: string | null) => void;
}

/** The keys of the new-session and Assistant forms. Returns whether the form consumed the key. */
export function handleFormKeys(ctx: FormKeyContext, input: string, key: Key): boolean {
  const { overlay, newSessionMode, created, attachCreated, exit, setOverlay, setForm, submitForm, changeFormChoice, applyPick, form, launchOptions, actions, bumpStatus } = ctx;
  if (overlay.kind !== "form" && overlay.kind !== "assistant") return false;
    const assistant = overlay.kind === "assistant";
    const pickField = form.focus <= LAST_PICK_FIELD;
    if (created !== null) { if (key.return) void attachCreated(); else if (key.escape) { if (newSessionMode) exit(); else setOverlay({ kind: "none" }); } return true; }
    // Esc first clears the query of a pick field; the next Esc leaves the form.
    if (key.escape) {
      if (form.search !== "") { setForm((old) => ({ ...old, search: "", highlight: 0 })); return true; }
      if (newSessionMode) exit(); else setOverlay({ kind: "none" });
      return true;
    }
    if (key.ctrl && key.return) { void submitForm(); return true; }
    if (key.return && form.focus === submitIndex(assistant)) { void submitForm(); return true; }
    if (key.tab) { setForm((old) => moveFocus(old, nextField(old.focus, key.shift ? -1 : 1, assistant, true))); return true; }
    if (key.upArrow || key.downArrow) { setForm((old) => moveFocus(old, nextField(old.focus, key.upArrow ? -1 : 1, assistant, false))); return true; }
    if (key.leftArrow || key.rightArrow) { changeFormChoice(key.leftArrow ? -1 : 1); return true; }
    if (key.return && pickField) {
      if (form.search === "") { setForm((old) => moveFocus(old, nextField(old.focus, 1, assistant, false))); return true; }
      const pick = formPick(form, launchOptions, actions, assistant);
      const item = pick?.matches[pick.highlight];
      if (item === undefined) { bumpStatus(`No ${formFieldLabel(assistant, form.focus).toLowerCase()} matches "${form.search}"; Backspace edits the query`); return true; }
      applyPick(form.focus, item, assistant);
      setForm((old) => moveFocus(old, nextField(old.focus, 1, assistant, false)));
      return true;
    }
    if (key.return && overlay.kind === "form" && formFields(false)[form.focus]?.text === "prompt") { setForm((old) => ({ ...old, prompt: old.prompt + "\n" })); return true; }
    // The focus is read from the state the update applies to: a click that changed it may not have rendered yet.
    if (key.backspace || key.delete) {
      setForm((old) => old.focus <= LAST_PICK_FIELD ? (old.search === "" ? old : { ...old, search: old.search.slice(0, -1), highlight: 0 }) : changeTextField(old, "", assistant, true));
      return true;
    }
    // Control characters are never text: an input without printable characters types nothing.
    if (!key.ctrl && !key.meta && typedText(input) !== "") {
      setForm((old) => old.focus <= LAST_PICK_FIELD ? (typedText(input) === "" ? old : { ...old, search: old.search + input, highlight: 0 }) : changeTextField(old, input, assistant, false));
    }
    return true;
  return true;
}
