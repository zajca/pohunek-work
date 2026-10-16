import type { ControlGovernance, ControlHostCapabilities, ControlNotification, ControlSession } from "../../control/index.ts";
import type { DoOutcome } from "../../tui/decode.ts";
import type { ConfirmAction } from "./session.tsx";

/** The owner's own overlay kinds: a return or a pick names one of these. */
export type OverlayKind = "none" | "links" | "session" | "host" | "notification" | "form" | "assistant" | "confirm" | "recovery" | "rename" | "metadata" | "work-detail" | "work-preview" | "help" | "projects";
/** Where Esc or a finished action returns to. */
export type ReturnKind = "none" | "session";
/** The open overlay; `kind` is what the views switch on. A confirm carries its target, so it cannot open without one. */
/** The session and highlighted link of the link chooser; `url` is null when the session has no link to highlight. */
export interface LinkChoice { readonly host: string; readonly id: string; readonly url: string | null; readonly returnTo: ReturnKind }

export type Overlay =
  | { readonly kind: Exclude<OverlayKind, "confirm" | "recovery" | "links" | "host" | "notification" | "work-detail" | "work-preview" | "projects"> }
  | { readonly kind: "confirm"; readonly action: ConfirmAction; readonly session: ControlSession; readonly returnTo: ReturnKind }
  | { readonly kind: "recovery"; readonly request: RecoveryRequest }
  | { readonly kind: "links"; readonly chooser: LinkChoice }
  | { readonly kind: "host"; readonly capabilities: ControlHostCapabilities | null; readonly governance: ControlGovernance | null }
  | { readonly kind: "notification"; readonly record: ControlNotification }
  | { readonly kind: "work-detail"; readonly key: string; readonly choice: number }
  | { readonly kind: "work-preview"; readonly key: string; readonly choice: number; readonly preview: DoOutcome | string; readonly offset: number }
  | { readonly kind: "projects"; readonly index: number; readonly search: string; readonly filtering: boolean };

/** The project picker's highlight, query and whether the query is being typed. */
export type PickState = { readonly index: number; readonly search: string; readonly filtering: boolean };
/** A resume or fork waiting for the owner to confirm the native conversation it will recover. */
export interface RecoveryRequest { readonly kind: "resume" | "fork"; readonly session: ControlSession; readonly returnTo: ReturnKind }
