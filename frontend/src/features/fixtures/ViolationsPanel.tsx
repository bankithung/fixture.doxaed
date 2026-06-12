import { AlertOctagon, AlertTriangle, Check } from "lucide-react";
import type {
  PreviewRelaxation,
  PreviewViolation,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Localized titles per stable violation code (§9 A5 — the FE renders from
 * the code; the gettext server message is only the unknown-code fallback). */
const VIOLATION_TITLES: Record<string, string> = {
  pinned_round_unplaced: "A pinned round does not fit its window",
  session_window_starved: "A hard session window starves these matches",
  matches_unplaced: "Some matches could not be placed",
};

/** Localized labels per relaxation code — concrete next steps, never a
 * generic error (§3 infeasibility contract). */
const RELAXATION_LABELS: Record<string, string> = {
  demote_to_soft: "Make it a preference (soft)",
  add_day: "Add a day",
  add_venue: "Add a venue",
  raise_max_per_day: "Raise the per-day cap",
};

/**
 * The dry-run preview's violations panel (redesign §6 screen 5): hard
 * failures in destructive framing with plain-language explanations and
 * actionable relaxation buttons; soft notes in warning framing; the
 * soft-score quality strip on top.
 */
export function ViolationsPanel({
  violations,
  softScore,
  onRelax,
}: {
  violations: PreviewViolation[];
  /** 0–1 schedule quality; null when the preview skipped scheduling. */
  softScore: number | null;
  /** Apply/route a relaxation; omit to render the suggestions read-only. */
  onRelax?: (relaxation: PreviewRelaxation, violation: PreviewViolation) => void;
}): React.ReactElement {
  const hard = violations.filter((v) => v.hard);
  const soft = violations.filter((v) => !v.hard);

  return (
    <section className="flex flex-col gap-2" aria-label={t("Constraint check")}>
      <div
        data-testid="soft-score"
        className={cn(
          "flex items-center gap-2 rounded-lg border px-3 py-2",
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
            ? `${hard.length} ${t("hard constraint violation(s)")}`
            : t("No hard violations")}
          {softScore != null ? (
            <span className="font-tabular text-muted-foreground">
              {" "}· {t("Schedule quality")} {Math.round(softScore * 100)}%
            </span>
          ) : null}
        </p>
      </div>

      {[...hard, ...soft].map((v, i) => (
        <div
          key={`${v.code}-${i}`}
          data-testid={`violation-${v.code}`}
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
            {v.constraint ? (
              <span className="rounded-full bg-muted px-2 py-0.5 font-tabular text-[0.6875rem] text-muted-foreground">
                {v.constraint.type} · {v.constraint.scope}
              </span>
            ) : null}
          </div>
          {/* Plain-language explanation: the localized title above carries the
              code; the server message adds the wordy fallback detail. */}
          <p className="text-xs text-muted-foreground">{v.message}</p>
          {v.relaxations.length ? (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-xs text-muted-foreground">{t("Try:")}</span>
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
