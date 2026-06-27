import { useState } from "react";
import { ChevronDown, ChevronUp, Plus, RotateCcw, X } from "lucide-react";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import type { Scoring } from "./scoring";
import {
  availableCriteria,
  defaultTiebreakers,
  moveItem,
  tbLabel,
} from "./tiebreakers";

/**
 * Per-game tie-breaker editor (owner ref 2026-06-27: head-to-head → set diff →
 * point diff → total points → coin toss, reorderable). Match points is the
 * pinned primary; the rest break level-on-points ties in order. Controlled:
 * `value` is the override (null = inherit the recommended order in `defaultFor`);
 * `onChange(null)` resets. Saved via the settings PATCH (frozen rules).
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
  // "points" is the primary sort — pinned, never reordered or removed.
  const pinned = list[0] === "points";
  const head = pinned ? ["points"] : [];
  const rest = pinned ? list.slice(1) : list;

  const emit = (nextRest: string[]) => onChange([...head, ...nextRest]);
  const unused = availableCriteria(scoring).filter((c) => !rest.includes(c));

  // Order shown in the collapsed summary (skip the pinned primary).
  const summary = rest.map(tbLabel).join(" → ");

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t("Tie-breakers")}</span>
        <button
          type="button"
          disabled={disabled}
          aria-expanded={open}
          data-testid={`${testId}-toggle`}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
            overridden
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-muted",
          )}
        >
          <span className="truncate" data-testid={`${testId}-summary`}>{summary}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")}
          />
        </button>
        {overridden ? (
          <button
            type="button"
            disabled={disabled}
            data-testid={`${testId}-reset`}
            onClick={() => onChange(null)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw aria-hidden="true" className="h-3 w-3" />
            {t("Reset")}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/10 p-3">
          <p className="text-xs text-muted-foreground">
            {t("Teams level on match points are separated in this order:")}
          </p>
          <ol className="flex flex-col gap-1">
            {rest.map((key, i) => (
              <li
                key={key}
                data-testid={`${testId}-row-${key}`}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1 text-xs"
              >
                <span className="w-4 text-right font-tabular text-muted-foreground">
                  {i + 1}
                </span>
                <span className="flex-1">{tbLabel(key)}</span>
                <button
                  type="button"
                  disabled={disabled || i === 0}
                  aria-label={t("Move up")}
                  data-testid={`${testId}-up-${key}`}
                  onClick={() => emit(moveItem(rest, i, -1))}
                  className="rounded p-0.5 hover:bg-muted disabled:opacity-30"
                >
                  <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={disabled || i === rest.length - 1}
                  aria-label={t("Move down")}
                  data-testid={`${testId}-down-${key}`}
                  onClick={() => emit(moveItem(rest, i, 1))}
                  className="rounded p-0.5 hover:bg-muted disabled:opacity-30"
                >
                  <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  disabled={disabled || rest.length <= 1}
                  aria-label={t("Remove")}
                  data-testid={`${testId}-remove-${key}`}
                  onClick={() => emit(rest.filter((_, k) => k !== i))}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive disabled:opacity-30"
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
          {rest.includes("coin_toss") && rest.indexOf("coin_toss") !== rest.length - 1 ? (
            <p className="text-xs text-destructive">
              {t("A coin toss settles everything — put it last.")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
