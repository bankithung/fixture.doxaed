import { AlertTriangle, Check, Circle } from "lucide-react";
import type {
  ReadinessCheck,
  ReadinessCompetition,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Plain labels per server check id (clarity rebuild §7.3) — the server hint
 * keeps rendering after the label as the detail. */
const CHECK_LABELS: Record<string, string> = {
  enough_teams: "Teams registered",
  format_chosen: "Format picked",
  seeds_set: "Seed numbers",
  calendar_set: "Tournament dates",
  venues_defined: "Venues",
  constraints_reviewed: "Scheduling rules checked",
  already_generated: "Current draw",
};

function StatusIcon({ status }: { status: string }): React.ReactElement {
  if (status === "ok") {
    return (
      <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
    );
  }
  if (status === "warn") {
    return (
      <AlertTriangle
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-warning-foreground"
      />
    );
  }
  return (
    <Circle aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />
  );
}

/**
 * One competition's server-computed readiness, rendered as the "what's
 * missing" detail (clarity rebuild §4.1): a caption + progress bar, then
 * every §5.1 check with its status icon, hint and — when the hub can act on
 * it — a deep-link "Fix this" button. The FE never recomputes these checks;
 * it renders what the endpoint said.
 */
export function ReadinessChecklist({
  competition,
  onFix,
  fixable,
}: {
  competition: ReadinessCompetition;
  /** Called with the check's `fix` key + leaf key; omit for read-only. */
  onFix?: (fix: string, leafKey: string) => void;
  /** Fix keys the hub has a surface for (others render hint-only). */
  fixable?: ReadonlySet<string>;
}): React.ReactElement {
  const [ok = 0, total = 0] = competition.summary
    .split("/")
    .map((n) => Number(n) || 0);
  const pct = total > 0 ? Math.round((ok / total) * 100) : 0;

  const showFix = (c: ReadinessCheck): boolean =>
    Boolean(
      onFix &&
        c.fix &&
        c.status !== "ok" &&
        (fixable === undefined || fixable.has(c.fix)),
    );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="font-tabular text-xs text-muted-foreground">
          {t(`${ok} of ${total} checks passed`)}
        </span>
        <div
          role="progressbar"
          aria-label={t(`Setup progress for ${competition.label}`)}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={ok}
          className="h-1.5 w-full max-w-[12rem] overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full",
              competition.ready ? "bg-primary" : "bg-primary/60",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <ul className="flex flex-col gap-1">
        {competition.checks.map((c) => (
          <li
            key={c.id}
            data-testid={`check-${competition.leaf_key}-${c.id}`}
            data-status={c.status}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <StatusIcon status={c.status} />
            <span
              className={cn(
                "font-medium",
                c.status === "ok" && "text-muted-foreground",
              )}
            >
              {t(CHECK_LABELS[c.id] ?? c.id)}
            </span>
            {c.hint ? (
              <span className="text-xs text-muted-foreground">{c.hint}</span>
            ) : null}
            {showFix(c) ? (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-7 px-2 text-xs text-primary"
                onClick={() => onFix!(c.fix!, competition.leaf_key)}
              >
                {t("Fix this")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
