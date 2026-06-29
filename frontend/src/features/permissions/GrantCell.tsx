import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { GrantState } from "@/types/user";

const NEXT: Record<GrantState, GrantState> = {
  default: "grant",
  grant: "deny",
  deny: "default",
};

export interface GrantCellProps {
  state: GrantState;
  /** True if the user's role would grant this module by default. */
  roleDefault: boolean;
  onChange: (next: GrantState) => void;
  /** Module label for aria + tooltip composition. */
  moduleLabel: string;
  /** User identifier (typically email or full name) for aria/tooltip. */
  userLabel: string;
  disabled?: boolean;
}

/**
 * v1Users.md Appendix B.16 — 3-state segmented control: default/grant/deny.
 *
 * Visual contract:
 *   - default + roleDefault=true  → faint green tint, no glyph; tooltip
 *     "Default (role grants)".
 *   - default + roleDefault=false → neutral, faint dash; tooltip
 *     "Default (role doesn't grant)".
 *   - grant  → solid green CheckCircle2, green border; tooltip
 *     "Granted (override)".
 *   - deny   → solid red XCircle, red border; tooltip "Denied (override)".
 *
 * Click / Space / Enter cycles default → grant → deny → default.
 * `role="switch"` + `aria-checked` + composed `aria-label` for WCAG 2.1 AA.
 */
export function GrantCell({
  state,
  roleDefault,
  onChange,
  moduleLabel,
  userLabel,
  disabled,
}: GrantCellProps): React.ReactElement {
  const cycle = (): void => {
    if (!disabled) onChange(NEXT[state]);
  };

  // Visual styles per state (also drives tooltip text).
  const styles =
    state === "grant"
      ? "bg-grant text-white border-grant"
      : state === "deny"
        ? "bg-deny text-white border-deny"
        : roleDefault
          ? "bg-grant-muted text-grant border-grant/30"
          : "bg-muted text-muted-foreground border-border";

  const tooltip =
    state === "grant"
      ? t("Granted (override)")
      : state === "deny"
        ? t("Denied (override)")
        : roleDefault
          ? t("Default (role grants)")
          : t("Default (role doesn't grant)");

  // Composed aria-label includes user, module, and human-readable state.
  const stateForAria =
    state === "grant"
      ? t("granted")
      : state === "deny"
        ? t("denied")
        : roleDefault
          ? t("default (granted by role)")
          : t("default (not granted by role)");
  const ariaLabel = `${userLabel} — ${moduleLabel}: ${stateForAria}`;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={state === "grant"}
      aria-label={ariaLabel}
      title={tooltip}
      onClick={cycle}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          cycle();
        }
      }}
      disabled={disabled}
      data-state={state}
      data-role-default={roleDefault ? "true" : "false"}
      className={cn(
        "inline-flex h-7 w-7 items-center justify-center rounded border text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50",
        styles,
      )}
    >
      {state === "grant" ? (
        <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
      ) : state === "deny" ? (
        <XCircle aria-hidden="true" className="h-4 w-4" />
      ) : roleDefault ? (
        <span aria-hidden="true" className="opacity-0">
          ·
        </span>
      ) : (
        <span aria-hidden="true" className="opacity-60">
          –
        </span>
      )}
    </button>
  );
}
