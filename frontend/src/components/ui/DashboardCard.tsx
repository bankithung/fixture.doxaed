import * as React from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
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
        "h-full transition-shadow",
        !disabled && "hover:shadow-md focus-within:ring-2 focus-within:ring-ring",
        disabled && "opacity-60",
      )}
    >
      <CardHeader className="flex-row items-start gap-3 space-y-0">
        <div
          aria-hidden="true"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{title}</CardTitle>
            {badge ? (
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
                {badge}
              </span>
            ) : null}
          </div>
        </div>
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
