import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { flipPlacement } from "@/lib/popover";
import { t } from "@/lib/t";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional thumbnail shown beside the label (e.g. a school logo). */
  image?: string;
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
  /** Show a search box inside the list. Default: automatic when the list has
   *  more than 5 options. */
  searchable?: boolean;
}

/** Lists longer than this get the in-list search box automatically. */
const SEARCH_THRESHOLD = 5;

/**
 * Custom, fully-styled, accessible single-select. Replaces the native
 * <select> everywhere so the app has one consistent dropdown language
 * (keyboard nav, click-outside, Escape, ARIA listbox). Long lists (>5
 * options) get an inline search box that filters as you type.
 *
 * The listbox is rendered in a portal with fixed positioning so it escapes any
 * clipping ancestor (table `overflow-x-auto`, card `overflow-hidden`, dialogs),
 * and flips above the trigger when the viewport has more room there.
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
  searchable,
}: SelectProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  const hasSearch = searchable ?? options.length > SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!hasSearch || !q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, hasSearch, query]);

  // Anchor the portaled panel to the trigger (flipping above it when the
  // viewport has more room there), and keep it placed as the page/containers
  // scroll or the window resizes.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // ~32px per option + list padding (+ the search row), capped at 240px
      // of options — the historical max-h-60.
      const natural =
        Math.min(240, options.length * 32 + 10) + (hasSearch ? 44 : 0);
      setPos({ ...flipPlacement(r, natural), left: r.left, width: r.width });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, options.length, hasSearch]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e: MouseEvent): void => {
      const tgt = e.target as Node;
      if (ref.current?.contains(tgt) || panelRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, options, value]);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const choose = (v: string): void => {
    onChange(v);
    close(true);
  };

  /** Shared list navigation — bound to the trigger AND the search input. */
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
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(visible.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" || (e.key === " " && !hasSearch)) {
      e.preventDefault();
      const o = visible[active];
      if (o) choose(o.value);
    }
  };

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        ref={buttonRef}
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
        <span
          className={cn(
            "flex min-w-0 items-center gap-2",
            !selected && "text-muted-foreground",
          )}
        >
          {selected?.image ? (
            <img
              src={selected.image}
              alt=""
              className="h-5 w-5 shrink-0 rounded object-cover"
            />
          ) : null}
          <span className="truncate">{selected?.label ?? placeholder}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-4 w-4 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={panelRef}
              data-select-panel=""
              style={{
                position: "fixed",
                top: pos.top,
                bottom: pos.bottom,
                left: pos.left,
                minWidth: pos.width,
                maxWidth: "min(20rem, calc(100vw - 1rem))",
                maxHeight: pos.maxHeight,
              }}
              className="z-[60] flex flex-col rounded-lg border bg-popover text-popover-foreground shadow-lg animate-fade-in"
            >
              {hasSearch ? (
                <div className="relative shrink-0 border-b border-border p-1.5">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <input
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setActive(0);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t("Search…")}
                    aria-label={t("Search options")}
                    className="h-8 w-full rounded-md bg-muted/60 pl-8 pr-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              ) : null}
              <ul
                role="listbox"
                id={listId}
                aria-label={ariaLabel}
                className="overflow-auto p-1"
              >
                {visible.map((o, i) => (
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
                    <span className="flex min-w-0 items-center gap-2">
                      {o.image ? (
                        <img
                          src={o.image}
                          alt=""
                          className="h-5 w-5 shrink-0 rounded object-cover"
                        />
                      ) : null}
                      <span className="truncate">{o.label}</span>
                    </span>
                    {o.value === value ? (
                      <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
                    ) : null}
                  </li>
                ))}
                {visible.length === 0 ? (
                  <li className="px-2.5 py-2 text-sm text-muted-foreground">
                    {t("No matches.")}
                  </li>
                ) : null}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
