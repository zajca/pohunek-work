import { createContext, useContext } from "react";
import { useStdout } from "ink";

/** Footer of the views at full width; a terminal narrower than it gets the short footer. */
export const MAIN_FOOTER = "Tab views  ·  ↑↓ select  ·  ←→ sections in Sessions  ·  Enter open  ·  x stop  ·  D remove  ·  PgUp/PgDn detail  ·  ? help  ·  q quit";
/** Footer of the new-session and assistant forms at full width. */
/** Footer of the Sessions view while its side panel shows the links of the selected session; no longer than MAIN_FOOTER. */
export const SESSIONS_FOOTER = "Tab views  ·  ↑↓ select  ·  ←→ sections  ·  l links  ·  Enter open  ·  x stop  ·  D remove  ·  PgUp/PgDn detail  ·  ? help  ·  q quit";
export const FORM_FOOTER = "Tab next field  ·  Ctrl+Enter create  ·  Esc back";

/** Lines ScreenFrame renders around its children: header, tab row with its top margin, divider, reserved subtitle, reserved status and footer. */
export const FRAME_LINES = 7;
/** Lines the Sessions list renders above its rows: title, state counts and project chips. */
export const LIST_HEADER_LINES = 3;
/** Heading lines of the Sessions list: one per section, the four sections of the list. */
export const SECTION_HEADING_LINES = 4;
/** Lines of a session or activity row (MenuRow: primary and secondary text). */
export const LIST_ROW_LINES = 2;
/** Lines of the action toolbar under a detail or a preview. */
export const TOOLBAR_LINES = 1;
/** Lines of the new-session form that are not choices: title, hint, field rows and the submit row. */
export const FORM_FIXED_LINES = 10;
/** Padding columns ScreenFrame adds on each side. */
const FRAME_PADDING_COLUMNS = 2;
/** Columns between the header title and the control label, and the label's right margin. */
export const HEADER_GAP_COLUMNS = 2;
/** Label shown at the right of the header when the title and the label fit side by side. */
export const CONTROL_LABEL = "CONTROL CENTER";
/** Gap between two tabs in the tab row. */
const TAB_GAP_COLUMNS = 1;

/** Values that do not depend on the terminal size. */
export interface LayoutStatic {
  readonly actionCaptureBytes: number;
  readonly tabLabels: readonly string[];
}

/** Layout of the current terminal, derived from its size and the rendered chrome. */
export interface TuiLayout {
  readonly actionCaptureBytes: number;
  /** Columns below which the footer and the tab labels are shortened. */
  readonly compactColumns: number;
  /** Columns the full tab row needs; narrower terminals show three-letter tab labels. */
  readonly fullTabsColumns: number;
  /** Rows below which the forms show their choices in compact mode. */
  readonly compactRows: number;
  readonly listReservedRows: number;
  readonly detailReservedRows: number;
  readonly previewReservedRows: number;
  /** Choices a form shows at once. */
  readonly visibleChoices: number;
}

/** Tab row width at full labels, as ScreenFrame renders it. */
function tabRowColumns(labels: readonly string[]): number {
  const tabs = labels.reduce((sum, label, index) => sum + ` ${String(index + 1)} ${label} `.length, 0);
  return tabs + Math.max(0, labels.length - 1) * TAB_GAP_COLUMNS + FRAME_PADDING_COLUMNS;
}

/** Derives the layout of a terminal `rows` high from the chrome it renders. */
export function deriveLayout(rows: number, staticLayout: LayoutStatic): TuiLayout {
  const formRows = FRAME_LINES + FORM_FIXED_LINES;
  return {
    actionCaptureBytes: staticLayout.actionCaptureBytes,
    compactColumns: MAIN_FOOTER.length + FRAME_PADDING_COLUMNS,
    fullTabsColumns: tabRowColumns(staticLayout.tabLabels),
    compactRows: formRows,
    listReservedRows: FRAME_LINES + LIST_HEADER_LINES + SECTION_HEADING_LINES,
    detailReservedRows: FRAME_LINES + TOOLBAR_LINES,
    previewReservedRows: FRAME_LINES + TOOLBAR_LINES,
    visibleChoices: Math.max(1, rows - formRows),
  };
}

const LayoutContext = createContext<LayoutStatic | null>(null);

export const LayoutProvider = LayoutContext.Provider;

/** The layout of the terminal as it is now; follows resizes because it reads the current size. */
export function useLayout(): TuiLayout {
  const { stdout } = useStdout();
  const staticLayout = useContext(LayoutContext);
  if (staticLayout === null) throw new Error("the TUI layout is not configured; render through runInkTui");
  return deriveLayout(stdout.rows, staticLayout);
}
