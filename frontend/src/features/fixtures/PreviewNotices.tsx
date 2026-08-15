import { AlertOctagon, AlertTriangle, Check, Info } from "lucide-react";
import type { PreviewRelaxation, PreviewViolation } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { LeafLabel } from "./LeafLabel";

/** Plain titles per stable violation code (§7.7 — the FE renders from the
 * code; the gettext server message is only the unknown-code fallback). */
const VIOLATION_TITLES: Record<string, string> = {
  pinned_round_unplaced: "A round that is pinned to a date does not fit its day.",
  session_window_starved: 'A "must" time rule leaves these matches no room.',
  matches_unplaced: "Some matches could not be given a time and venue.",
  concurrent_competitions:
    "Two competitions you kept apart would have to run at the same time.",
  ceremony_block: "A match would run during a ceremony.",
};

/** Plain labels per relaxation code — concrete next steps, never a generic
 * error (§3 infeasibility contract). */
const RELAXATION_LABELS: Record<string, string> = {
  demote_to_soft: "Make this rule a preference instead",
  add_day: "Add another day",
  add_venue: "Add another venue",
  raise_max_per_day: "Allow more matches per team per day",
};

/** The violation code that IS "these matches have no time". Any violation
 * whose own match list already covers every unplaced match counts too — it is
 * the same trouble seen from the other side, so it folds into that violation
 * instead of being reported again underneath it. */
const UNPLACED_CODES = new Set(["matches_unplaced"]);

/** The violation that already speaks for the matches with no time, if any. */
function ownerOfUnplaced(
  violations: PreviewViolation[],
  unplacedRefs: readonly string[],
): PreviewViolation | undefined {
  const byCode = violations.find((v) => UNPLACED_CODES.has(v.code));
  if (byCode || !unplacedRefs.length) return byCode;
  return violations.find(
    (v) => v.matches.length && unplacedRefs.every((r) => v.matches.includes(r)),
  );
}

export interface UnplacedLeaf {
  leafKey: string;
  label: string;
  count: number;
}

/**
 * ONE notice block for the whole preview (owner 2026-08-15: "a proper unified
 * error or warning message in one section rather than all separate").
 *
 * The preview used to say the same thing three times — the verdict counted a
 * problem, the violation card described it, and an unplaced-matches panel
 * repeated it with its own heading — so "1 problem" read as something apart
 * from the 4 matches with no time. Now there is one list: one line per real
 * problem, each carrying its own count, its competitions and the buttons that
 * fix it. The unplaced matches are shown INSIDE the violation that caused
 * them, and only stand alone when no violation claimed them.
 */
export function PreviewNotices({
  violations,
  unplacedCount,
  unplacedRefs = [],
  unplacedByLeaf,
  skippedLeaves,
  onRelax,
  onFixRules,
  onShowUnplaced,
  onShowLeaf,
}: {
  violations: PreviewViolation[];
  /** Matches the scheduler could not place at all. */
  unplacedCount: number;
  /** Their refs, so a violation that already lists them absorbs them. */
  unplacedRefs?: readonly string[];
  unplacedByLeaf: UnplacedLeaf[];
  /** Competitions left undrawn (too few teams) — labels only. */
  skippedLeaves?: string[];
  /** Apply/route a relaxation; omit to render the suggestions read-only. */
  onRelax?: (relaxation: PreviewRelaxation, violation: PreviewViolation) => void;
  /** Send the organiser to the rules in fixture setup. */
  onFixRules?: () => void;
  /** Filter the sheet down to the matches with no time. */
  onShowUnplaced?: () => void;
  /** Filter the sheet to one competition's unplaced matches. */
  onShowLeaf?: (leafKey: string) => void;
}): React.ReactElement {
  const hard = violations.filter((v) => v.hard);
  const soft = violations.filter((v) => !v.hard);
  const ordered = [...hard, ...soft];
  // The unplaced matches belong to a violation whenever one is about them.
  const unplacedOwner = ownerOfUnplaced(ordered, unplacedRefs);
  const standaloneUnplaced = unplacedCount > 0 && !unplacedOwner;
  // What the header counts: every hard violation, plus unplaced matches when
  // no violation already speaks for them. Never the same trouble twice.
  const problems = hard.length + (standaloneUnplaced ? 1 : 0);

  const unplacedDetail = (
    <>
      {unplacedByLeaf.length ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {unplacedByLeaf.map((e) => (
            <button
              key={e.leafKey}
              type="button"
              data-testid={`unplaced-leaf-${e.leafKey}`}
              onClick={() => onShowLeaf?.(e.leafKey)}
              disabled={!onShowLeaf}
              className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-1.5 py-0.5 text-[0.6875rem] transition-colors hover:bg-muted disabled:cursor-default"
            >
              <span className="max-w-64 truncate">{e.label}</span>
              <span className="font-tabular text-muted-foreground">
                {e.count}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );

  return (
    <section
      data-testid="preview-notices"
      aria-label={t("Schedule check")}
      className={cn(
        "flex flex-col gap-2 rounded-lg border px-3 py-2",
        problems
          ? "border-destructive/40 bg-destructive-muted"
          : soft.length || unplacedCount || skippedLeaves?.length
            ? "border-warning/40 bg-warning-muted"
            : "border-success/40 bg-success-muted",
      )}
    >
      {/* The verdict, in one sentence. */}
      <div data-testid="soft-score" className="flex flex-wrap items-center gap-2">
        {problems ? (
          <AlertOctagon aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />
        ) : soft.length || unplacedCount ? (
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
        ) : (
          <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-success" />
        )}
        <p className="text-sm font-medium">
          {problems
            ? t(
                `${problems} ${problems === 1 ? "problem" : "problems"} to fix before you publish.`,
              )
            : soft.length
              ? /* Soft notes render below · "no rules broken" would contradict them. */
                t("This schedule works. Some preferences could not be met (details below).")
              : t("This schedule works. No rules are broken.")}
        </p>
        {problems && onFixRules ? (
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

      {/* One line per problem — its own count, competitions and fixes. */}
      {ordered.map((v, i) => {
        const owns = v === unplacedOwner;
        const count = owns ? unplacedCount : v.matches.length;
        return (
          <div
            key={`${v.code}-${i}`}
            data-testid={`violation-${v.code}`}
            // The raw constraint tokens stay reachable for support/debugging.
            title={v.constraint ? `${v.constraint.type} · ${v.constraint.scope}` : undefined}
            className={cn(
              "flex flex-col gap-1.5 rounded-md border bg-card/60 px-2.5 py-2",
              v.hard ? "border-destructive/40" : "border-warning/40",
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
              {count ? (
                <span className="rounded bg-muted px-1.5 py-0.5 font-tabular text-[0.6875rem] font-medium text-muted-foreground">
                  {count} {t("matches")}
                </span>
              ) : null}
              {owns && onShowUnplaced ? (
                <button
                  type="button"
                  data-testid="show-unplaced"
                  onClick={onShowUnplaced}
                  className="ml-auto text-xs font-medium text-primary hover:underline"
                >
                  {t("Show them in the sheet")}
                </button>
              ) : null}
            </div>
            {/* Plain-language title above carries the code; the server message
                adds the wordy fallback detail. */}
            <p className="text-xs text-muted-foreground">{v.message}</p>
            {owns ? unplacedDetail : null}
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
        );
      })}

      {/* Unplaced matches nobody claimed — the same line, standing alone. */}
      {standaloneUnplaced ? (
        <div
          data-testid="unscheduled-summary"
          className="flex flex-col gap-1.5 rounded-md border border-warning/40 bg-card/60 px-2.5 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
            <span className="text-sm font-semibold">
              {unplacedCount} {t("match(es) have no time yet")}
            </span>
            {onShowUnplaced ? (
              <button
                type="button"
                data-testid="show-unplaced"
                onClick={onShowUnplaced}
                className="ml-auto text-xs font-medium text-primary hover:underline"
              >
                {t("Show them in the sheet")}
              </button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("Add another day or venue in Step 1, then preview again.")}
          </p>
          {unplacedDetail}
        </div>
      ) : null}

      {/* Competitions that were not drawn at all. */}
      {skippedLeaves?.length ? (
        <div
          data-testid="skipped-leaves-notice"
          className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-card/60 px-2.5 py-2"
        >
          <Info aria-hidden="true" className="h-4 w-4 shrink-0 text-warning" />
          <span className="text-sm font-medium">
            {t(
              `${skippedLeaves.length} ${skippedLeaves.length === 1 ? "competition is" : "competitions are"} not drawn yet (fewer than 2 teams). Publishing skips them.`,
            )}
          </span>
          {skippedLeaves.map((l) => (
            <LeafLabel key={l} label={l} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
