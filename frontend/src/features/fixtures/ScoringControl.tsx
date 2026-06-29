import { useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { blankSets, cleanScoring, scoringSummary, type Scoring } from "./scoring";

/** Two-state segmented toggle (Points/sets vs Timed/goals), token-styled, not a
 * native control (design system: no `<select>`). */
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
        className="h-9 w-full font-tabular"
        placeholder={placeholder}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** One readable line describing the effective set rule, recomputed from the
 * draft (e.g. "Best of 3, first to 15, win by 2, cap 17"). */
function effectiveLine(d: Scoring): string {
  if (d.type === "goals") return t("Timed game; the score is goals.");
  const parts = [`${t("Best of")} ${d.best_of ?? 3}`, `${t("first to")} ${d.points ?? 11}`];
  if (d.win_by && d.win_by !== 1) parts.push(`${t("win by")} ${d.win_by}`);
  if (d.cap) parts.push(`${t("cap")} ${d.cap}`);
  return parts.join(", ");
}

/**
 * Per-game scoring editor (owner ask 2026-06-27): how many sets, points to win a
 * set, win-by margin, hard cap (the 15 to 17 deuce), an optional different
 * deciding set, or a timed/goal game. Controlled: `value` is the override (null =
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
  const [decOpen, setDecOpen] = useState(false);
  const overridden = value != null;
  // What the editor works on: the override, or a fresh draft seeded from the
  // inherited baseline (so the first edit becomes an explicit override).
  const draft: Scoring = value ?? blankSets(inherited);
  const set = (patch: Partial<Scoring>) => onChange(cleanScoring({ ...draft, ...patch }));
  const setDeciding = (patch: Partial<NonNullable<Scoring["deciding"]>>) =>
    onChange(cleanScoring({ ...draft, deciding: { ...draft.deciding, ...patch } }));

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.8125rem] font-medium text-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium",
              overridden
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground",
            )}
          >
            {overridden ? t("Custom") : t("Inherited")}
          </span>
          {overridden ? (
            <button
              type="button"
              disabled={disabled}
              data-testid={`${testId}-reset`}
              onClick={() => onChange(null)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RotateCcw aria-hidden="true" className="h-3 w-3" />
              {t("Use sport default")}
            </button>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        data-testid={`${testId}-toggle`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          open
            ? "border-primary ring-1 ring-primary/30"
            : overridden
              ? "border-primary/50 hover:border-primary"
              : "border-border hover:border-primary/40",
        )}
      >
        <span className="text-sm text-foreground" data-testid={`${testId}-summary`}>
          {scoringSummary(value ?? inherited)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
          <span className="hidden sm:inline">{open ? t("Close") : t("Edit")}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          />
        </span>
      </button>

      {open ? (
        <div className="rounded-lg border border-border bg-muted/10">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-foreground">
              {t("How a winner is decided")}
            </span>
            <TypeToggle
              type={draft.type}
              disabled={disabled}
              testId={testId}
              onPick={(ty) => onChange(ty === "goals" ? { type: "goals" } : blankSets(inherited))}
            />
          </div>
          <div className="flex flex-col gap-3 p-3">
            {draft.type === "goals" ? (
              <p className="text-xs text-muted-foreground">
                {t("Scored by goals; match length is set above.")}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                    "Win by is the deuce margin: at 14 all, a team must lead by this many. The cap ends it; first to the cap wins (for example to 15, cap 17).",
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {effectiveLine(draft)}
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    aria-expanded={decOpen}
                    data-testid={`${testId}-deciding-toggle`}
                    onClick={() => setDecOpen((o) => !o)}
                    className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className={cn("h-3.5 w-3.5 transition-transform", decOpen && "rotate-180")}
                    />
                    {t("Different rules for the deciding set")}
                  </button>
                  {decOpen ? (
                    <>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
                      <p className="text-xs text-muted-foreground">
                        {t("Leave blank to use the regular set rules.")}
                      </p>
                    </>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
