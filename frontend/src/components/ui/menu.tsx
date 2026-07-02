import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/tailwind";

/**
 * Small accessible dropdown menu for consolidating secondary page actions
 * (the "three buttons in a header" fix). Trigger is a quiet outline button;
 * items are plain buttons. Closes on outside click, Escape, or selection.
 */
export function ActionMenu({
  label,
  icon: Icon,
  align = "end",
  children,
  "data-testid": testid,
}: {
  label: string;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  align?: "start" | "end";
  children: React.ReactNode;
  "data-testid"?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid={testid}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {Icon ? <Icon aria-hidden="true" className="h-4 w-4" /> : null}
        {label}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            "absolute z-30 mt-1 min-w-52 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-md",
            align === "end" ? "right-0" : "left-0",
          )}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function ActionMenuItem({
  onSelect,
  icon: Icon,
  children,
  disabled,
  title,
  "data-testid": testid,
}: {
  onSelect: () => void;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
  "data-testid"?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testid}
      disabled={disabled}
      title={title}
      onClick={onSelect}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
    >
      {Icon ? (
        <Icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
      ) : null}
      {children}
    </button>
  );
}
