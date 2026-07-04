import * as React from "react";
import { Crown } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Role chip per v1Users.md role catalog. Owner is rendered as a special
 * gold-ringed chip with a crown — the platform-level distinction the
 * member directory uses to surface "this is the org owner".
 *
 * Unknown roles fall back to a neutral slate chip so the UI never breaks
 * if the server adds a new role string before the SPA ships an update.
 */

export type RoleKey =
  | "owner"
  | "admin"
  | "co_organizer"
  | "game_coordinator"
  | "match_scorer"
  | "referee"
  | "team_manager";

interface PaletteEntry {
  label: string;
  className: string;
}

const PALETTE: Record<RoleKey, PaletteEntry> = {
  owner: {
    label: "Owner",
    className:
      "bg-amber-50 text-amber-900 ring-1 ring-amber-400 ring-offset-1 ring-offset-background",
  },
  admin: {
    label: "Admin",
    className: "bg-primary/15 text-primary ring-1 ring-primary/25",
  },
  co_organizer: {
    label: "Co-organizer",
    className: "bg-success-muted text-success ring-1 ring-success/25",
  },
  game_coordinator: {
    label: "Game coordinator",
    className: "bg-info-muted text-info ring-1 ring-info/25",
  },
  match_scorer: {
    label: "Match scorer",
    className: "bg-warning-muted text-warning-foreground ring-1 ring-warning/25",
  },
  referee: {
    label: "Referee",
    className: "bg-destructive/15 text-destructive ring-1 ring-destructive/25",
  },
  team_manager: {
    label: "Team manager",
    className: "bg-secondary text-secondary-foreground ring-1 ring-border",
  },
};

const NEUTRAL: PaletteEntry = {
  label: "Role",
  className: "bg-muted text-muted-foreground ring-1 ring-border",
};

function paletteFor(role: string): PaletteEntry {
  return (PALETTE as Record<string, PaletteEntry | undefined>)[role] ?? NEUTRAL;
}

export interface RoleBadgeProps {
  role: string;
  /** Force the gold owner treatment even if `role !== "owner"`. */
  isOwner?: boolean;
  className?: string;
}

export function RoleBadge({
  role,
  isOwner,
  className,
}: RoleBadgeProps): React.ReactElement {
  const ownerLook = isOwner || role === "owner";
  const entry = ownerLook ? PALETTE.owner : paletteFor(role);
  const labelText = entry === NEUTRAL ? prettify(role) : t(entry.label);
  return (
    <span
      data-testid={`role-badge-${role}`}
      data-role={role}
      data-owner={ownerLook ? "true" : "false"}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        entry.className,
        className,
      )}
    >
      {ownerLook ? (
        <Crown
          aria-hidden="true"
          className="h-3 w-3 text-warning-foreground"
          strokeWidth={2.5}
        />
      ) : null}
      <span>{labelText}</span>
    </span>
  );
}

/** "co_organizer" -> "Co organizer" — last-resort label for unknown roles. */
function prettify(s: string): string {
  if (!s) return "Role";
  return s
    .replace(/[_\-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Selectable role keys for the invite form (i.e. catalog roles without
 * `owner`, since ownership is granted via transfer rather than invitation).
 * Typed as a literal tuple so consumers get a precise union when they index
 * with `(typeof ROLE_KEYS)[number]`.
 */
export const ROLE_KEYS = [
  "admin",
  "co_organizer",
  "game_coordinator",
  "match_scorer",
  "referee",
  "team_manager",
] as const;
export type SelectableRoleKey = (typeof ROLE_KEYS)[number];
