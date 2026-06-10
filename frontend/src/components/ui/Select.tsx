import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { flipPlacement } from "@/lib/popover";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  /** `sm` = compact h-9 trigger (filter bars); `md` (default) matches Input. */
  size?: "sm" | "md";
  /** Accessible name (paired with an external <Label htmlFor={id}>). */
  "aria-label"?: string;
}

/**
 * Custom, fully-styled, accessible single-select. Replaces the native
 * <select> everywhere so the app has one consistent dropdown language
 * (keyboard nav, click-outside, Escape, ARIA listbox).
 *
 * The listbox is rendered in a portal with fixed positioning so it escapes any
 * clipping ancestor (table `overflow-x-auto`, card `overflow-hidden`, dialogs).
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  id,
  className,
  disabled,
  size = "md",
  "aria-label": ariaLabel,
}: SelectProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  // Anchor the portaled listbox to the trigger (flipping above it when the
  // viewport has more room there), and keep it placed as the page/containers
  // scroll or the window resizes.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // ~32px per option + list padding, capped at the old max-h-60 (240px).
      const natural = Math.min(240, options.length * 32 + 10);
      setPos({ ...flipPlacement(r, natural), left: r.left, width: r.width });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e: MouseEvent): void => {
      const tgt = e.target as Node;
      if (ref.current?.contains(tgt) || listRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, options, value]);

  const choose = (v: string): void => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const o = options[active];
      if (o) choose(o.value);
    }
  };

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-controls={open ? listId : undefined}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-input bg-background text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" ? "h-9 px-2.5" : "h-10 px-3",
        )}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && pos
        ? createPortal(
            <ul
              ref={listRef}
              role="listbox"
              id={listId}
              aria-label={ariaLabel}
              style={{
                position: "fixed",
                top: pos.top,
                bottom: pos.bottom,
                left: pos.left,
                minWidth: pos.width,
                maxWidth: "min(20rem, calc(100vw - 1rem))",
                maxHeight: pos.maxHeight,
              }}
              className="z-[60] overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg animate-fade-in"
            >
              {options.map((o, i) => (
                <li
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o.value)}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm",
                    i === active ? "bg-accent text-accent-foreground" : "",
                  )}
                >
                  <span className="truncate">{o.label}</span>
                  {o.value === value ? (
                    <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                  ) : null}
                </li>
              ))}
            </ul>,
            document.body,
          )
        : null}
    </div>
  );
}
