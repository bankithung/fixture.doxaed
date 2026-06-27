import { useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { blankSets, cleanScoring, scoringSummary, type Scoring } from "./scoring";

/** Two-state segmented toggle (Points/sets vs Timed/goals) — token-styled, not
 * a native control (design system: no `<select>`). */
function TypeToggle({
  type,
  onPick,
  disabled,
  testId,
}: {
  type: "sets" | "goals";
  onPick: (t: "sets" | "goals") => void;
  disabled?: boolean;
  testId: string;
}): React.ReactElement {
  return (
    <div role="radiogroup" aria-label={t("How a winner is decided")} className="inline-flex rounded-lg border border-border p-0.5">
      {(["sets", "goals"] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          role="radio"
          aria-checked={type === opt}
          disabled={disabled}
          data-testid={`${testId}-type-${opt}`}
          onClick={() => onPick(opt)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
            type === opt
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt === "sets" ? t("Sets / points") : t("Timed (goals)")}
        </button>
      ))}
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  min = 1,
  placeholder,
  testId,
  disabled,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (v: string) => void;
  min?: number;
  placeholder?: string;
  testId: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        type="number"
        min={min}
        disabled={disabled}
        data-testid={testId}
        className="h-8 w-24 font-tabular"
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * Per-game scoring editor (owner ask 2026-06-27): how many sets, points to win a
 * set, win-by margin, hard cap (the 15→17 deuce), an optional different deciding
 * set — or a timed/goal game. Controlled: `value` is the override (null =
 * inherits the sport default shown in `inherited`); `onChange(null)` clears it.
 * The board stages the change and saves it via the settings PATCH (frozen rules).
 */
export function ScoringControl({
  value,
  inherited,
  onChange,
  disabled,
  testId,
  label = t("Scoring"),
}: {
  value: Scoring | null | undefined;
  inherited: Scoring | null | undefined;
  onChange: (s: Scoring | null) => void;
  disabled?: boolean;
  testId: string;
  label?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const overridden = value != null;
  // What the editor works on: the override, or a fresh draft seeded from the
  // inherited baseline (so the first edit becomes an explicit override).
  const draft: Scoring = value ?? blankSets(inherited);
  const set = (patch: Partial<Scoring>) => onChange(cleanScoring({ ...draft, ...patch }));
  const setDeciding = (patch: Partial<NonNullable<Scoring["deciding"]>>) =>
    onChange(cleanScoring({ ...draft, deciding: { ...draft.deciding, ...patch } }));

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <button
          type="button"
          disabled={disabled}
          aria-expanded={open}
          data-testid={`${testId}-toggle`}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
            overridden
              ? "border-primary bg-primary/10 text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-muted",
          )}
        >
          <span data-testid={`${testId}-summary`}>
            {scoringSummary(value ?? inherited)}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
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
            {t("Use sport default")}
          </button>
        ) : null}
      </div>

      {open ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/10 p-3">
          <TypeToggle
            type={draft.type}
            disabled={disabled}
            testId={testId}
            onPick={(ty) => onChange(ty === "goals" ? { type: "goals" } : blankSets(inherited))}
          />
          {draft.type === "goals" ? (
            <p className="text-xs text-muted-foreground">
              {t("Scored by goals; match length is set above.")}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-3">
                <NumField
                  label={t("Number of sets")}
                  value={draft.best_of}
                  testId={`${testId}-best-of`}
                  disabled={disabled}
                  onChange={(v) => set({ best_of: Number(v) })}
                />
                <NumField
                  label={t("Points to win a set")}
                  value={draft.points}
                  testId={`${testId}-points`}
                  disabled={disabled}
                  onChange={(v) => set({ points: Number(v) })}
                />
                <NumField
                  label={t("Win by")}
                  value={draft.win_by}
                  testId={`${testId}-win-by`}
                  disabled={disabled}
                  onChange={(v) => set({ win_by: Number(v) })}
                />
                <NumField
                  label={t("Hard cap (optional)")}
                  value={draft.cap}
                  min={1}
                  placeholder={t("none")}
                  testId={`${testId}-cap`}
                  disabled={disabled}
                  onChange={(v) => set({ cap: v === "" ? null : Number(v) })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t(
                  "“Win by” is the deuce: at 14–14 a team must lead by this many. The cap ends it — first to the cap wins (e.g. to 15, cap 17).",
                )}
              </p>
              <details className="text-xs">
                <summary
                  data-testid={`${testId}-deciding-toggle`}
                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                >
                  {t("Different rules for the deciding set")}
                </summary>
                <div className="mt-2 flex flex-wrap gap-3">
                  <NumField
                    label={t("Deciding points")}
                    value={draft.deciding?.points}
                    placeholder={String(draft.points ?? 11)}
                    testId={`${testId}-dec-points`}
                    disabled={disabled}
                    onChange={(v) => setDeciding({ points: Number(v) })}
                  />
                  <NumField
                    label={t("Deciding win by")}
                    value={draft.deciding?.win_by}
                    placeholder={String(draft.win_by ?? 2)}
                    testId={`${testId}-dec-win-by`}
                    disabled={disabled}
                    onChange={(v) => setDeciding({ win_by: Number(v) })}
                  />
                  <NumField
                    label={t("Deciding cap")}
                    value={draft.deciding?.cap}
                    placeholder={t("none")}
                    testId={`${testId}-dec-cap`}
                    disabled={disabled}
                    onChange={(v) => setDeciding({ cap: v === "" ? null : Number(v) })}
                  />
                </div>
              </details>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
