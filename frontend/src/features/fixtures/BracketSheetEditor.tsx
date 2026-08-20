import { useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  bracketSizes,
  defaultMeets,
  defaultSheet,
  groupCountFor,
  meetsProblem,
  sheetProblems,
  slotLabel,
  slotOptions,
} from "./bracketSheet";

/**
 * Write the knockout bracket out by hand (owner 2026-08-20).
 *
 * Two questions, in the order an organiser answers them: who plays whom in
 * round one, and which of those matches meet next. Both are stored on the
 * qualification block as plain data (`pairings` / `meets`) and interpreted by
 * the draw at generation time, so this editor authors a RULE rather than one
 * competition's fixture: the same sheet describes a two-match bracket or an
 * eight-match one, in any sport.
 *
 * The group count is never asked for. Every qualifying slot must be seated
 * exactly once, so the bracket's size and the qualification numbers already
 * decide it; asking would only let the two disagree.
 */
export function BracketSheetEditor({
  advancePerGroup,
  bestLosers,
  pairings,
  meets,
  onChange,
  disabled,
  testId,
}: {
  advancePerGroup: number;
  bestLosers: number;
  pairings: string[][];
  meets: number[][] | undefined;
  onChange: (patch: { pairings?: string[][]; meets?: number[][] | null }) => void;
  disabled?: boolean;
  testId: string;
}): React.ReactElement {
  const matches = pairings.length;
  const groups = groupCountFor(matches, advancePerGroup, bestLosers);
  const options = useMemo(
    () => (groups === null ? [] : slotOptions(groups, advancePerGroup, bestLosers)),
    [groups, advancePerGroup, bestLosers],
  );
  const problems = groups === null ? [] : sheetProblems(pairings, options);
  const meetsIssue = meets ? meetsProblem(meets, matches) : null;

  const setSize = (n: number): void =>
    onChange({
      pairings: defaultSheet(n, advancePerGroup, bestLosers),
      meets: null,
    });

  const setSlot = (row: number, side: 0 | 1, value: string): void => {
    const next = pairings.map((p) => p.slice());
    next[row]![side] = value;
    onChange({ pairings: next });
  };

  const setMeet = (row: number, side: 0 | 1, value: number): void => {
    const next = (meets ?? defaultMeets(matches)).map((p) => p.slice());
    next[row]![side] = value;
    onChange({ meets: next });
  };

  const slotSelect = (row: number, side: 0 | 1): React.ReactElement => (
    <div className="min-w-0 flex-1" data-testid={`${testId}-slot-${row}-${side}`}>
      <Select
        value={pairings[row]?.[side] ?? ""}
        onChange={(v) => setSlot(row, side, v)}
        options={options.map((s) => ({ value: s, label: slotLabel(s) }))}
        aria-label={`${t("Match")} ${row + 1} ${side === 0 ? t("home") : t("away")}`}
      />
    </div>
  );

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {t("Round 1 has")}
        <div className="w-20" data-testid={`${testId}-size`}>
          <Select
            value={String(matches)}
            onChange={(v) => setSize(Number(v))}
            options={bracketSizes().map((n) => ({ value: String(n), label: String(n) }))}
            aria-label={t("Matches in round 1")}
          />
        </div>
        {t("matches")}
        {groups === null ? (
          <span className="text-destructive">
            {t("That many matches cannot be filled by the teams advancing.")}
          </span>
        ) : (
          <span>
            {groups} {groups === 1 ? t("group") : t("groups")}
          </span>
        )}
      </div>

      <ol className="flex flex-col gap-1.5">
        {pairings.map((_pair, row) => (
          <li key={row} className="flex items-center gap-2">
            <span className="w-8 shrink-0 font-tabular text-xs font-medium text-muted-foreground">
              M{row + 1}
            </span>
            {slotSelect(row, 0)}
            <span className="shrink-0 text-xs text-muted-foreground">{t("v")}</span>
            {slotSelect(row, 1)}
          </li>
        ))}
      </ol>

      {matches > 1 ? (
        <div className="flex flex-col gap-1.5 border-t border-border pt-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("Which winners meet next")}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={`${testId}-meets-toggle`}
              onClick={() => onChange({ meets: meets ? null : defaultMeets(matches) })}
            >
              {meets ? (
                <>
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Use the standard tree")}
                </>
              ) : (
                <>
                  <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Choose the pairings")}
                </>
              )}
            </Button>
          </div>
          {meets ? (
            <ol className="flex flex-col gap-1.5">
              {meets.map((pair, row) => (
                <li key={row} className="flex items-center gap-2">
                  {([0, 1] as const).map((side) => (
                    <div
                      key={side}
                      className="min-w-0 flex-1"
                      data-testid={`${testId}-meet-${row}-${side}`}
                    >
                      <Select
                        value={String(pair[side] ?? "")}
                        onChange={(v) => setMeet(row, side, Number(v))}
                        options={pairings.map((_p, i) => ({
                          value: String(i + 1),
                          label: `${t("Winner of")} M${i + 1}`,
                        }))}
                        aria-label={`${t("Next round")} ${row + 1}`}
                      />
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("M1 plays M2, M3 plays M4, and so on.")}
            </p>
          )}
        </div>
      ) : null}

      {problems.length || meetsIssue ? (
        <ul
          data-testid={`${testId}-problems`}
          className={cn("flex flex-col gap-0.5 text-xs text-destructive")}
        >
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
          {meetsIssue ? <li>{meetsIssue}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
