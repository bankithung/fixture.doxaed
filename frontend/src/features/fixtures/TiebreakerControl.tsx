import { useState } from "react";
import { ChevronDown, ChevronUp, Lock, Plus, RotateCcw, X } from "lucide-react";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { Scoring } from "./scoring";
import {
  availableCriteria,
  defaultTiebreakers,
  isSetSport,
  moveItem,
  snapCoinTossLast,
  tbLabel,
} from "./tiebreakers";

/**
 * Per-game tie-breaker editor (owner ref 2026-06-27: head-to-head, set diff,
 * point diff, total points, coin toss, reorderable). Match points is the pinned
 * primary; the rest break level-on-points ties in order. Controlled: `value` is
 * the override (null = inherit the recommended order in `defaultFor`);
 * `onChange(null)` resets. Saved via the settings PATCH (frozen rules).
 *
 * coin_toss is auto-snapped last on every edit (a coin toss settles everything),
 * so the UI never asks the user to fix the order after the fact.
 */
export function TiebreakerControl({
  value,
  scoring,
  onChange,
  disabled,
  testId,
}: {
  value: string[] | null | undefined;
  scoring: Scoring | null | undefined;
  onChange: (tbs: string[] | null) => void;
  disabled?: boolean;
  testId: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const overridden = value != null;
  const list = value ?? defaultTiebreakers(scoring);
  // "points" is the primary sort, pinned, never reordered or removed.
  const pinned = list[0] === "points";
  const head = pinned ? ["points"] : [];
  const rest = pinned ? list.slice(1) : list;

  // Every edit keeps the coin toss last (no-op when it already is).
  const emit = (nextRest: string[]) => onChange([...head, ...snapCoinTossLast(nextRest)]);
  const unused = availableCriteria(scoring).filter((c) => !rest.includes(c));
  const setChip = isSetSport(scoring) ? t("Sets scoring") : t("Goals scoring");

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.8125rem] font-medium text-foreground">{t("Tie-breakers")}</span>
        {overridden ? (
          <button
            type="button"
            disabled={disabled}
            data-testid={`${testId}-reset`}
            onClick={() => onChange(null)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RotateCcw aria-hidden="true" className="h-3 w-3" />
            {t("Reset")}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-start gap-2 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          open
            ? "border-primary ring-1 ring-primary/30"
            : overridden
              ? "border-primary/50 hover:border-primary"
              : "border-border hover:border-primary/40",
        )}
      >
        <span
          className="flex flex-1 flex-wrap items-center gap-1"
          data-testid={`${testId}-summary`}
        >
          <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
            <Lock aria-hidden="true" className="h-3 w-3" />
            <span className="font-tabular">1</span>
            {t("Match points")}
          </span>
          {rest.map((key, i) => (
            <span key={key} className="rounded bg-muted px-1.5 py-0.5 text-xs">
              <span className="font-tabular">{i + 2}</span> {tbLabel(key)}
            </span>
          ))}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 self-center text-xs font-medium text-muted-foreground">
          <span className="hidden sm:inline">{open ? t("Close") : t("Edit")}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
          />
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("Teams level on match points are separated in this order:")}
            </p>
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
              {setChip}
            </span>
          </div>
          <ol className="divide-y divide-border rounded-md border border-border bg-card">
            {rest.map((key, i) => (
              <li
                key={key}
                data-testid={`${testId}-row-${key}`}
                className="flex h-8 items-center gap-2 px-2 text-xs"
              >
                <span className="w-4 text-right font-tabular text-muted-foreground">
                  {i + 2}
                </span>
                <span className="flex-1 truncate">{tbLabel(key)}</span>
                <button
                  type="button"
                  disabled={disabled || i === 0}
                  aria-label={t("Move up")}
                  data-testid={`${testId}-up-${key}`}
                  onClick={() => emit(moveItem(rest, i, -1))}
                  className="rounded p-1 hover:bg-muted disabled:opacity-30"
                >
                  <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={disabled || i === rest.length - 1}
                  aria-label={t("Move down")}
                  data-testid={`${testId}-down-${key}`}
                  onClick={() => emit(moveItem(rest, i, 1))}
                  className="rounded p-1 hover:bg-muted disabled:opacity-30"
                >
                  <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={disabled || rest.length <= 1}
                  aria-label={t("Remove")}
                  data-testid={`${testId}-remove-${key}`}
                  onClick={() => emit(rest.filter((_, k) => k !== i))}
                  className="ml-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-30"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ol>
          {unused.length > 0 ? (
            <div className="flex items-center gap-2">
              <Plus aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="w-56" data-testid={`${testId}-add`}>
                <Select
                  value=""
                  onChange={(v) => v && emit([...rest, v])}
                  options={[
                    { value: "", label: t("Add a tie-breaker…") },
                    ...unused.map((c) => ({ value: c, label: tbLabel(c) })),
                  ]}
                  aria-label={t("Add a tie-breaker")}
                />
              </div>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t("A coin toss settles everything, so it always goes last.")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
