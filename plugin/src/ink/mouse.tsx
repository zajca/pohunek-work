import { Box, measureElement, type DOMElement } from "ink";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

export interface MouseEvent {
  readonly x: number;
  readonly y: number;
  readonly kind: "click" | "wheel-up" | "wheel-down";
}

interface MouseTarget {
  readonly element: DOMElement;
  readonly onClick?: (() => void) | undefined;
  readonly onWheel?: ((direction: -1 | 1) => void) | undefined;
}

interface MouseRegistry {
  readonly add: (target: MouseTarget) => () => void;
  readonly dispatch: (event: MouseEvent) => void;
}

const MouseContext = createContext<MouseRegistry | null>(null);

export function parseMouseEvent(input: string): MouseEvent | null {
  const match = /^\[<([0-9]+);([0-9]+);([0-9]+)([Mm])$/.exec(input);
  if (match === null) return null;
  const button = Number(match[1]);
  const x = Number(match[2]) - 1;
  const y = Number(match[3]) - 1;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) return null;
  if (button === 64) return { x, y, kind: "wheel-up" };
  if (button === 65) return { x, y, kind: "wheel-down" };
  if (button === 0 && match[4] === "M") return { x, y, kind: "click" };
  return null;
}

export function MouseProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const targets = useRef(new Set<MouseTarget>());
  const registry = useRef<MouseRegistry>({
    add(target) {
      targets.current.add(target);
      return () => { targets.current.delete(target); };
    },
    dispatch(event) {
      const matching = [...targets.current].reverse().find((target) => {
        const bounds = measureElement(target.element);
        return event.x >= bounds.x && event.x < bounds.x + bounds.width && event.y >= bounds.y && event.y < bounds.y + bounds.height &&
          (event.kind === "click" ? target.onClick !== undefined : target.onWheel !== undefined);
      });
      if (event.kind === "click") matching?.onClick?.();
      else matching?.onWheel?.(event.kind === "wheel-up" ? -1 : 1);
    },
  });
  return <MouseContext.Provider value={registry.current}>{children}</MouseContext.Provider>;
}

export function useMouseDispatch(): (event: MouseEvent) => void {
  const registry = useContext(MouseContext);
  if (registry === null) throw new Error("MouseProvider is required");
  return registry.dispatch;
}

export function MouseZone({ children, onClick, onWheel, width, flexDirection }: {
  readonly children: ReactNode;
  readonly onClick?: (() => void) | undefined;
  readonly onWheel?: ((direction: -1 | 1) => void) | undefined;
  readonly width?: number | `${number}%`;
  readonly flexDirection?: "column" | "row";
}): ReactNode {
  const registry = useContext(MouseContext);
  const element = useRef<DOMElement>(null);
  const current = useRef({ onClick, onWheel });
  current.current = { onClick, onWheel };
  useEffect(() => {
    if (registry === null || element.current === null) return;
    return registry.add({ element: element.current,
      ...(onClick === undefined ? {} : { onClick: () => current.current.onClick?.() }),
      ...(onWheel === undefined ? {} : { onWheel: (direction: -1 | 1) => current.current.onWheel?.(direction) }),
    });
  }, [registry, onClick !== undefined, onWheel !== undefined]);
  return <Box ref={element} {...(width === undefined ? {} : { width })} {...(flexDirection === undefined ? {} : { flexDirection })}>{children}</Box>;
}

export function setMouseTracking(enabled: boolean): void {
  process.stdout.write(enabled ? "\u001b[?1000h\u001b[?1006h" : "\u001b[?1000l\u001b[?1006l");
}
