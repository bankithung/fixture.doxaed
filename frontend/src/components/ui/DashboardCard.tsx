import * as React from "react";
import { Link } from "react-router-dom";
import { ChevronRight, type LucideIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/tailwind";

/**
 * A single role-aware tile on the Org Dashboard.
 *
 * Renders as either a `<Link>` (when `href` is provided) or a `<button>`
 * (when `onClick` is provided). Disabled cards render as a `<div>` and
 * are non-interactive but remain visible (e.g., Phase 1B teasers).
 */
export interface DashboardCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  href?: string;
  onClick?: () => void;
  badge?: string;
  disabled?: boolean;
  /** Optional ariaLabel override; defaults to `title`. */
  ariaLabel?: string;
}

export function DashboardCard({
  icon: Icon,
  title,
  description,
  href,
  onClick,
  badge,
  disabled = false,
  ariaLabel,
}: DashboardCardProps): React.ReactElement {
  const body = (
    <Card
      className={cn(
        "group h-full transition-all duration-200",
        !disabled &&
          "hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md focus-within:ring-2 focus-within:ring-ring",
        disabled && "opacity-60",
      )}
    >
      <CardHeader className="flex-row items-start gap-3 space-y-0">
        <div
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/15 transition-colors group-hover:bg-primary group-hover:text-primary-foreground"
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CardTitle className="truncate text-base">{title}</CardTitle>
            {badge ? (
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
                {badge}
              </span>
            ) : null}
          </div>
        </div>
        {!disabled ? (
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
          />
        ) : null}
      </CardHeader>
      <CardContent>
        <CardDescription>{description}</CardDescription>
      </CardContent>
    </Card>
  );

  const label = ariaLabel ?? title;

  if (disabled) {
    return (
      <div role="group" aria-label={label} aria-disabled="true">
        {body}
      </div>
    );
  }

  if (href) {
    return (
      <Link
        to={href}
        aria-label={label}
        className="block h-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {body}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="block h-full w-full rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {body}
    </button>
  );
}
