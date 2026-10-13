import { createContext, useContext } from "react";
import type { TuiLayoutConfig } from "../types/config.ts";

/** Layout values of the `[tui]` table; every screen reads them from here, never from literals. */
export type TuiLayout = TuiLayoutConfig;

const LayoutContext = createContext<TuiLayout | null>(null);

export const LayoutProvider = LayoutContext.Provider;

export function useLayout(): TuiLayout {
  const layout = useContext(LayoutContext);
  if (layout === null) throw new Error("the TUI layout is not configured; render through runInkTui");
  return layout;
}
