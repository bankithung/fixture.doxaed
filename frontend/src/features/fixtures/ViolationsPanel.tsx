import { AlertOctagon, AlertTriangle, Check } from "lucide-react";
import type {
  PreviewRelaxation,
  PreviewViolation,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Plain titles per stable violation code (§7.7 — the FE renders from the
 * code; the gettext server message is only the unknown-code fallback). */
const VIOLATION_TITLES: Record<string, string> = {
  pinned_round_unplaced: "A round that is pinned to a date does not fit its day.",
  session_window_starved: 'A "must" time rule leaves these matches no room.',
  matches_unplaced: "Some matches could not be given a time and venue.",
};

/** Plain labels per relaxation code — concrete next steps, never a generic
 * error (§3 infeasibility contract). */
const RELAXATION_LABELS: Record<string, string> = {
  demote_to_soft: "Make this rule a preference instead",
  add_day: "Add another day",
  add_venue: "Add another venue",
  raise_max_per_day: "Allow more matches per team per day",
};

/**
 * The preview's verdict (clarity rebuild §4.4): one lead sentence — the
 * schedule works, or {n} problems need fixing — then each problem as a card
 * with plain-language explanation and actionable relaxation buttons. Soft
 * notes render in warning framing. The quality figure lives in the page's
 * Advanced details, not here.
 */
export function ViolationsPanel({
  violations,
  onRelax,
  onFixRules,
}: {
  violations: PreviewViolation[];
  /** Apply/route a relaxation; omit to render the suggestions read-only. */
  onRelax?: (relaxation: PreviewRelaxation, violation: PreviewViolation) => void;
  /** Failure-verdict link back to fixture setup (the rules live there). */
  onFixRules?: () => void;
}): React.ReactElement {
  const hard = violations.filter((v) => v.hard);
  const soft = violations.filter((v) => !v.hard);

  return (
    <section className="flex flex-col gap-2" aria-label={t("Schedule check")}>
      <div
        data-testid="soft-score"
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2",
          hard.length
            ? "border-destructive/40 bg-destructive-muted"
            : "border-success/40 bg-success-muted",
        )}
      >
        {hard.length ? (
          <AlertOctagon aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />
        ) : (
          <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-success" />
        )}
        <p className="text-sm font-medium">
          {hard.length
            ? t(`${hard.length} problem(s) need fixing before you publish.`)
            : soft.length
              ? /* Soft notes render below — "no rules broken" would contradict them. */
                t("This schedule works. Some preferences could not be met (details below).")
              : t("This schedule works. No rules are broken.")}
        </p>
        {hard.length && onFixRules ? (
          <button
            type="button"
            data-testid="fix-rules-link"
            className="ml-auto text-sm font-medium text-primary hover:underline"
            onClick={onFixRules}
          >
            {t("Fix the rules in fixture setup")}
          </button>
        ) : null}
      </div>

      {[...hard, ...soft].map((v, i) => (
        <div
          key={`${v.code}-${i}`}
          data-testid={`violation-${v.code}`}
          // The raw constraint tokens stay reachable for support/debugging.
          title={v.constraint ? `${v.constraint.type} · ${v.constraint.scope}` : undefined}
          className={cn(
            "flex flex-col gap-1.5 rounded-lg border p-3",
            v.hard
              ? "border-destructive/50 bg-destructive-muted"
              : "border-warning/50 bg-warning-muted",
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle
              aria-hidden="true"
              className={cn(
                "h-4 w-4 shrink-0",
                v.hard ? "text-destructive" : "text-warning",
              )}
            />
            <span className="text-sm font-semibold">
              {t(VIOLATION_TITLES[v.code] ?? v.message)}
            </span>
            {v.matches.length ? (
              <span className="font-tabular text-xs text-muted-foreground">
                {v.matches.length} {t("match(es)")}
              </span>
            ) : null}
          </div>
          {/* Plain-language title above carries the code; the server message
              adds the wordy fallback detail. */}
          <p className="text-xs text-muted-foreground">{v.message}</p>
          {v.relaxations.length ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-xs text-muted-foreground">
                {t("What you can do:")}
              </span>
              {v.relaxations.map((r, j) => (
                <Button
                  key={`${r.code}-${j}`}
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  data-testid={`relax-${r.code}`}
                  disabled={!onRelax}
                  onClick={() => onRelax?.(r, v)}
                >
                  {t(RELAXATION_LABELS[r.code] ?? r.action)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}
