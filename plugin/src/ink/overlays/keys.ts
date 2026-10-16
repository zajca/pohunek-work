import type { Key } from "ink";
import type { Dispatch, SetStateAction } from "react";
import type { ControlNotification, ControlSession, ControlSnapshot } from "../../control/index.ts";
import type { ListItem } from "../../types/item.ts";
import type { ProjectChoice } from "../views.tsx";
import type { SessionLink } from "../links.ts";
import type { ViewName } from "../views.tsx";
import type { Overlay, PickState } from "./types.ts";

/** What the non-modal overlays' keys read and change; the app builds it once per key press. */
export interface OverlayKeyContext {
  readonly overlay: Overlay;
  readonly setOverlay: Dispatch<SetStateAction<Overlay>>;
  readonly pickChoices: readonly ProjectChoice[];
  readonly setProjectFilter: Dispatch<SetStateAction<string | null>>;
  readonly setCursor: Dispatch<SetStateAction<Record<ViewName, number>>>;
  readonly selectedWorkAction: { readonly name: string } | undefined;
  readonly workDetail: ListItem | null;
  readonly workHandover: (action: string) => Promise<void>;
  readonly previewWorkAction: (action: string) => Promise<void>;
  readonly previewMaxOffset: number;
  readonly previewHeight: number;
  readonly previewMatchesSelection: boolean;
  readonly openLink: (url: string) => void;
  readonly bumpStatus: (message: string | null) => void;
  readonly snapshot: ControlSnapshot | null;
  readonly linksOf: (session: ControlSession) => SessionLink[];
  readonly sessionDetail: ControlSession | null;
  readonly scrollDetail: (next: number, max: number) => void;
  readonly overlayOffset: number;
  readonly detailMaxOffset: number;
  readonly detailHeight: number;
  readonly sessionAttachable: boolean;
  readonly sessionRecoverable: boolean;
  readonly sessionMutable: boolean;
  readonly openSelected: (picked?: ControlSession) => Promise<void>;
  readonly requestRecovery: (kind: "resume" | "fork", target: ControlSession, returnTo: "none" | "session") => Promise<void>;
  readonly requestConfirm: (target: ControlSession, kind: "stop" | "remove", returnTo: "none" | "session") => void;
  readonly setEdit: Dispatch<SetStateAction<string>>;
  readonly restartOutput: () => void;
  readonly chooseLink: (session: ControlSession, returnTo: "none" | "session") => void;
  readonly openFolder: (session: ControlSession) => Promise<void>;
  readonly openBranch: (session: ControlSession) => void;
  readonly copyValue: (value: string) => Promise<void>;
  readonly inspectSessionAt: (host: string, id: string) => Promise<void>;
  readonly updateNotification: (record: ControlNotification, kind: "ack" | "archive") => Promise<void>;
}

/**
 * The keys of the non-modal overlays: help, the project picker, the work item and its preview, the link chooser, the
 * session detail, the notification and the host. Returns whether an overlay consumed the key.
 */
export function handleOverlayKeys(ctx: OverlayKeyContext, input: string, key: Key): boolean {
  const { overlay, setOverlay, pickChoices, setProjectFilter, setCursor, selectedWorkAction, workDetail, workHandover,
    previewWorkAction, previewMaxOffset, previewHeight, previewMatchesSelection, openLink, bumpStatus, snapshot, linksOf,
    sessionDetail, scrollDetail, overlayOffset, detailMaxOffset, detailHeight, sessionAttachable, sessionRecoverable,
    sessionMutable, openSelected, requestRecovery, requestConfirm, setEdit, restartOutput, chooseLink, openFolder,
    openBranch, copyValue, inspectSessionAt, updateNotification } = ctx;
  if (overlay.kind === "help") { if (key.escape || input === "?" || input === "q") setOverlay({ kind: "none" }); return true; }
  if (overlay.kind === "projects") {
    // Changes the picker only while it is still the open overlay.
    const editPick = (change: (old: PickState) => PickState): void => {
      setOverlay((current) => current.kind === "projects" ? { ...current, ...change(current) } : current);
    };
    const chooseProject = (): void => {
      const choice = pickChoices[overlay.index];
      if (choice !== undefined) { setProjectFilter(choice.label); setCursor((old) => ({ ...old, Sessions: 0 })); }
      setOverlay({ kind: "none" });
    };
    if (overlay.filtering) {
      if (key.escape) editPick((old) => ({ ...old, search: "", index: 0, filtering: false }));
      else if (key.return) chooseProject();
      else if (key.backspace || key.delete) editPick((old) => ({ ...old, search: old.search.slice(0, -1), index: 0 }));
      else if (input !== "" && !key.ctrl && !key.meta && !key.tab) editPick((old) => ({ ...old, search: old.search + input, index: 0 }));
      return true;
    }
    if (key.escape) setOverlay({ kind: "none" });
    else if (key.upArrow) editPick((old) => ({ ...old, index: Math.max(0, old.index - 1) }));
    else if (key.downArrow) editPick((old) => ({ ...old, index: Math.min(pickChoices.length - 1, old.index + 1) }));
    else if (input === "/") editPick((old) => ({ ...old, filtering: true }));
    else if (key.return) chooseProject();
    return true;
  }
  if (overlay.kind === "work-preview") {
    if (key.escape) setOverlay({ kind: "work-detail", key: overlay.key, choice: overlay.choice });
    else if (key.pageDown || key.downArrow) setOverlay((current) => current.kind === "work-preview" ? { ...current, offset: Math.min(previewMaxOffset, current.offset + Math.max(1, previewHeight - 1)) } : current);
    else if (key.pageUp || key.upArrow) setOverlay((current) => current.kind === "work-preview" ? { ...current, offset: Math.max(0, current.offset - Math.max(1, previewHeight - 1)) } : current);
    else if ((key.return || input === "r") && previewMatchesSelection && selectedWorkAction !== undefined) void workHandover(selectedWorkAction.name);
    return true;
  }
  if (overlay.kind === "work-detail") {
    if (key.escape) { setOverlay({ kind: "none" }); return true; }
    if (key.upArrow || input === "k") setOverlay((current) => current.kind === "work-detail" ? { ...current, choice: Math.max(0, current.choice - 1) } : current);
    else if (key.downArrow || input === "j") setOverlay((current) => current.kind === "work-detail" ? { ...current, choice: Math.min((workDetail?.actions.length ?? 1) - 1, current.choice + 1) } : current);
    else if (key.return || input === "p") { if (selectedWorkAction !== undefined) void previewWorkAction(selectedWorkAction.name); }
    else if (input === "r") { if (selectedWorkAction !== undefined) void workHandover(selectedWorkAction.name); }
    else if (input === "o" && workDetail !== null) { const url = workDetail.pull_request?.url ?? workDetail.issue?.url; if (url !== undefined) openLink(url); }
    return true;
  }
  if (overlay.kind === "links") {
    const choice = overlay.chooser;
    const chosen = snapshot?.sessions.find((session) => session.host === choice.host && session.id === choice.id) ?? null;
    const links = chosen === null ? [] : linksOf(chosen);
    const close = (): void => { setOverlay({ kind: choice.returnTo }); };
    if (chosen === null) {
      close();
      bumpStatus("The session of this chooser is no longer listed; no link opened");
      return true;
    }
    const highlighted = Math.max(0, links.findIndex((link) => link.url === choice.url));
    const highlight = (index: number): void => { setOverlay({ kind: "links", chooser: { ...choice, url: links[index]?.url ?? null } }); };
    // A refresh can change the links while the chooser is open; a pick that no longer has its link says so instead of failing silently.
    const missing = (number: number): void => {
      if (links.length === 0) { close(); bumpStatus(`No link ${String(number)} on this session anymore; none are left`); return; }
      bumpStatus(`No link ${String(number)} on this session anymore; choose 1–${String(links.length)}`);
    };
    const openNumbered = (index: number): void => {
      const link = links[index];
      if (link === undefined) { close(); missing(index + 1); return; }
      close();
      openLink(link.url);
    };
    if (key.escape) close();
    else if (key.upArrow || key.downArrow) highlight(Math.max(0, Math.min(links.length - 1, highlighted + (key.downArrow ? 1 : -1))));
    else if (key.return) {
      const link = links.find((item) => item.url === choice.url);
      if (link === undefined) {
        highlight(0);
        bumpStatus(links.length === 0 ? "The chooser has no links left on this session" : "The highlighted link is no longer on this session; choose again");
        return true;
      }
      close();
      openLink(link.url);
    } else if (/^[1-9]$/.test(input)) {
      if (Number(input) <= links.length) openNumbered(Number(input) - 1);
      else missing(Number(input));
    }
    return true;
  }
  if (overlay.kind === "session") {
    if (key.escape) { setOverlay({ kind: "none" }); return true; }
    if (sessionDetail === null) return true;
    if (key.pageDown || key.downArrow) { scrollDetail(overlayOffset + Math.max(1, detailHeight - 1), detailMaxOffset); return true; }
    if (key.pageUp || key.upArrow) { scrollDetail(overlayOffset - Math.max(1, detailHeight - 1), detailMaxOffset); return true; }
    if (input === "o" && sessionAttachable) void openSelected();
    else if (input === "r" && sessionRecoverable) void requestRecovery("resume", sessionDetail, "session");
    else if (input === "f" && sessionMutable && sessionDetail.canFork) void requestRecovery("fork", sessionDetail, "session");
    else if (input === "x" || input === "D") requestConfirm(sessionDetail, input === "x" ? "stop" : "remove", "session");
    else if ((input === "e" || input === "m") && sessionMutable) { setEdit(input === "e" ? sessionDetail.name ?? "" : ""); setOverlay({ kind: input === "e" ? "rename" : "metadata" }); }
    else if (input === "p") restartOutput();
    else if (input === "l") chooseLink(sessionDetail, "session");
    else if (input === "u") void openFolder(sessionDetail);
    else if (input === "g") openBranch(sessionDetail);
    else if (input === "b") void copyValue(sessionDetail.branch ?? "");
    else if (input === "c") void copyValue(sessionDetail.worktreePath ?? sessionDetail.cwd);
    return true;
  }
  if (overlay.kind === "notification") {
    const { record } = overlay;
    if (key.escape) setOverlay({ kind: "none" });
    else if (input === "o" && record.sessionId !== null) void inspectSessionAt(record.host, record.sessionId);
    else if (input === "a" || input === "x") void updateNotification(record, input === "a" ? "ack" : "archive");
    return true;
  }
  if (overlay.kind === "host") { if (key.escape) setOverlay({ kind: "none" }); return true; }
  return false;
}
