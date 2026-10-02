// Screen regions shared by the reducer (page size, scrolling) and the view.
import type { ListPayload } from "../types/item.ts";
import { hiddenUnknownCount, projectLabels, type Filters } from "./rows.ts";
import type { Size } from "./terminal.ts";

export type ColumnId = "mark" | "key" | "project" | "turn" | "pr" | "review" | "checks" | "sessions" | "title";

export interface ColumnSpec {
  readonly id: ColumnId;
  readonly header: string;
  readonly min: number;
  /** Widest the column grows to fit its cells; the title takes whatever is left. */
  readonly max: number;
}

export const COLUMNS: readonly ColumnSpec[] = [
  { id: "mark", header: "", min: 2, max: 2 },
  { id: "key", header: "KEY", min: 12, max: 24 },
  { id: "project", header: "PROJECT", min: 7, max: 14 },
  { id: "turn", header: "TURN", min: 10, max: 26 },
  { id: "pr", header: "PR", min: 5, max: 8 },
  { id: "review", header: "REVIEW", min: 6, max: 8 },
  { id: "checks", header: "CHECKS", min: 6, max: 7 },
  { id: "sessions", header: "SESSIONS", min: 8, max: 20 },
  { id: "title", header: "TITLE", min: 16, max: Number.POSITIVE_INFINITY },
];

/** Columns left out, in this order, until the rest fits; the detail pane repeats all of them. */
export const DROP_ORDER: readonly ColumnId[] = ["sessions", "review", "project", "checks", "pr"];

export const COLUMN_GAP = 1;

/** Share of the width the detail pane takes beside the table. */
const DETAIL_SHARE = 0.35;
/** The `|` between the table and the detail pane. */
const PANE_SEPARATOR = 1;
/** Status line at the bottom, column header above the rows. */
const STATUS_LINES = 1;
const TABLE_HEADER_LINES = 1;
const MIN_BODY_ROWS = 1;

export function showsProjectColumn(payload: ListPayload): boolean {
  return projectLabels(payload).length > 1;
}

/** Candidate columns for this payload, before any is dropped for width. */
export function columnsFor(payload: ListPayload): readonly ColumnSpec[] {
  return showsProjectColumn(payload) ? COLUMNS : COLUMNS.filter((column) => column.id !== "project");
}

export function tableWidthOf(columns: readonly ColumnSpec[], widths: readonly number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP * Math.max(0, columns.length - 1);
}

/** Narrowest table: only the columns that are never dropped, each at its minimum. */
export function minTableWidth(columns: readonly ColumnSpec[]): number {
  const kept = columns.filter((column) => !DROP_ORDER.includes(column.id));
  return tableWidthOf(kept, kept.map((column) => column.min));
}

export interface HeaderFlags {
  readonly partial: boolean;
  readonly versionMismatch: boolean;
  readonly listStderr: boolean;
  readonly hiddenUnknown: boolean;
}

export interface Layout {
  readonly tooSmall: boolean;
  /** Detail pane beside the table (width at least `detail_min_width`). */
  readonly wide: boolean;
  readonly tableWidth: number;
  readonly detailWidth: number;
  /** Lines above the column header. */
  readonly headerLines: number;
  /** Table rows that fit. */
  readonly bodyHeight: number;
}

export function headerFlags(payload: ListPayload, filters: Filters, ownVersion: string, dataVersion: string, stderrLines: number): HeaderFlags {
  return {
    partial: payload.projects.some((p) => Object.values(p.sources).some((status) => status !== "ok")),
    versionMismatch: ownVersion !== dataVersion,
    listStderr: stderrLines > 0,
    hiddenUnknown: hiddenUnknownCount(payload, filters) > 0,
  };
}

export function computeLayout(size: Size, columns: readonly ColumnSpec[], flags: HeaderFlags, detailMinWidth: number): Layout {
  const headerLines = 1 + [flags.partial, flags.versionMismatch, flags.listStderr, flags.hiddenUnknown].filter(Boolean).length;
  const bodyHeight = size.rows - headerLines - TABLE_HEADER_LINES - STATUS_LINES;
  const minWidth = minTableWidth(columns);
  const detailWidth = Math.floor(size.columns * DETAIL_SHARE);
  const wide = size.columns >= detailMinWidth && size.columns - detailWidth - PANE_SEPARATOR >= minWidth;
  const tableWidth = wide ? size.columns - detailWidth - PANE_SEPARATOR : size.columns;
  return {
    tooSmall: bodyHeight < MIN_BODY_ROWS || size.columns < minWidth,
    wide,
    tableWidth,
    detailWidth: wide ? detailWidth : 0,
    headerLines,
    bodyHeight: Math.max(0, bodyHeight),
  };
}

/** Rows lines available to a full-screen overlay (title line and status line excluded). */
export function overlayHeight(size: Size): number {
  return Math.max(0, size.rows - 1 - STATUS_LINES);
}
