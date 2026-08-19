import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Spreadsheet column widths — drag the edge of a heading to widen a column,
 * double-click it to fit the widest cell (owner 2026-08-19: "the columns the
 * user should be able to drag and increase width so that I can view full
 * text").
 *
 * A dense sheet has to truncate; the answer to a truncated cell is to make
 * the column wider, which is the one thing a fixed layout never allowed. The
 * widths are the reader's own working state, so they persist per surface
 * rather than resetting on every visit.
 */

/** Narrow enough to park a column out of the way, wide enough to still grab. */
export const MIN_COLUMN_WIDTH = 56;
const MAX_COLUMN_WIDTH = 900;
/** One arrow-key press, for resizing without a pointer. */
const KEY_STEP = 16;

export function clampColumnWidth(px: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(px)));
}

export interface ColumnWidths {
  widths: Record<string, number>;
  setWidth: (key: string, px: number) => void;
  resetWidths: () => void;
  /** True once the reader has moved anything — the offer to reset is only
   * worth making when there is something to reset. */
  resized: boolean;
}

/**
 * Widths for one table, remembered under `storageKey`.
 *
 * `defaults` is read once (on first mount); pass a module-level constant so a
 * re-render cannot silently redefine what "default" means.
 */
export function useColumnWidths(
  storageKey: string,
  defaults: Record<string, number>,
): ColumnWidths {
  const initial = useRef(defaults);
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    let saved: Record<string, number> = {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isFinite(v)) {
            saved[k] = clampColumnWidth(v);
          }
        }
      }
    } catch {
      // A storage that will not read is not a reason to lose the table.
      saved = {};
    }
    return { ...defaults, ...saved };
  });

  const setWidth = useCallback(
    (key: string, px: number) => {
      setWidths((w) => {
        const next = { ...w, [key]: clampColumnWidth(px) };
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // Widths are a convenience; failing to save one is not an error.
        }
        return next;
      });
    },
    [storageKey],
  );

  const resetWidths = useCallback(() => {
    setWidths({ ...initial.current });
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // as above
    }
  }, [storageKey]);

  const resized = Object.keys(initial.current).some(
    (k) => widths[k] !== initial.current[k],
  );
  return { widths, setWidth, resetWidths, resized };
}

/**
 * The grab handle on a heading's right edge.
 *
 * Absolutely positioned, so the heading it sits in must be `relative`. It is a
 * real separator with arrow keys, not a mouse-only affordance: resizing a
 * column is how this table is read, and a keyboard reader needs it as much as
 * anyone.
 */
export function ColumnResizer({
  width,
  label,
  onResize,
  onAutoFit,
  testId,
}: {
  width: number;
  /** The column's name, for the handle's accessible label. */
  label: string;
  onResize: (px: number) => void;
  /** Double-click / Enter: size to the widest cell. */
  onAutoFit?: () => void;
  testId?: string;
}): React.ReactElement {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [active, setActive] = useState(false);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`${t("Resize column")}: ${label}`}
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      tabIndex={0}
      data-testid={testId}
      data-dragging={active ? "" : undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        drag.current = { x: e.clientX, w: width };
        setActive(true);
        const el = e.currentTarget;
        if (typeof el.setPointerCapture === "function") {
          el.setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onResize(drag.current.w + (e.clientX - drag.current.x));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        setActive(false);
        const el = e.currentTarget;
        if (typeof el.releasePointerCapture === "function") {
          el.releasePointerCapture(e.pointerId);
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        setActive(false);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onAutoFit?.();
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          onResize(width + KEY_STEP);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          onResize(width - KEY_STEP);
        } else if (e.key === "Enter" && onAutoFit) {
          e.preventDefault();
          onAutoFit();
        }
      }}
      className={cn(
        "absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2",
        "after:bg-transparent hover:after:bg-primary focus-visible:outline-none",
        "focus-visible:after:bg-primary focus-visible:after:w-0.5",
        active && "after:bg-primary after:w-0.5",
      )}
    />
  );
}

/**
 * Width of the widest cell in a column, for auto-fit.
 *
 * Reads the rendered cells rather than guessing from the text, so a chip row
 * and a plain string are measured by the same ruler. Returns 0 when the
 * column is not on screen, which the caller should treat as "leave it alone".
 */
export function measureColumn(
  root: HTMLElement | null,
  columnKey: string,
  padding = 26,
): number {
  if (!root) return 0;
  const cells = root.querySelectorAll<HTMLElement>(
    `[data-col="${CSS.escape(columnKey)}"]`,
  );
  let widest = 0;
  for (const cell of cells) {
    const inner = cell.firstElementChild as HTMLElement | null;
    widest = Math.max(widest, inner?.scrollWidth ?? cell.scrollWidth);
  }
  return widest ? clampColumnWidth(widest + padding) : 0;
}
