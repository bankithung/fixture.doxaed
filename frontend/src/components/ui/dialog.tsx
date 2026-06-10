import * as React from "react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Tiny accessible modal-dialog primitive. We avoid pulling Radix into this
 * scaffold to keep the package surface minimal. Replace with @radix-ui/dialog
 * when shadcn primitives are formally adopted.
 */

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ariaLabel: string;
  /** "sheet" docks the panel to the bottom edge on small screens (a mobile
   *  drawer); on sm+ it centers exactly like the default. */
  variant?: "center" | "sheet";
  children: React.ReactNode;
}

export function Dialog({
  open,
  onOpenChange,
  ariaLabel,
  variant = "center",
  children,
}: DialogProps): React.ReactElement | null {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className={cn(
        "fixed inset-0 z-50 flex bg-black/50",
        variant === "sheet"
          ? "items-end justify-center sm:items-center sm:p-4"
          : "items-center justify-center p-4",
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        className={cn(
          "w-full max-w-md border bg-card shadow-lg",
          variant === "sheet"
            ? "max-h-[85vh] overflow-y-auto rounded-t-2xl p-4 pb-6 sm:rounded-lg sm:p-6"
            : "rounded-lg p-6",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn("flex flex-col space-y-1.5 pb-4", className)}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement {
  return (
    <h2
      className={cn("text-lg font-semibold leading-none", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.ReactElement {
  return (
    <p
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn("mt-6 flex justify-end gap-2", className)}
      {...props}
    />
  );
}

export function DialogCloseButton({
  onClick,
}: {
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("Close dialog")}
      className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100"
    >
      x
    </button>
  );
}
