import { useMemo } from "react";
import type { MatchRow } from "@/api/tournaments";
import { t } from "@/lib/t";

function MatchBox({ m }: { m: MatchRow }): React.ReactElement {
  const done = m.status === "completed";
  const winner =
    done && m.home_score != null && m.away_score != null
      ? m.home_score > m.away_score
        ? "home"
        : m.away_score > m.home_score
          ? "away"
          : null
      : null;

  const row = (
    name: string | undefined,
    score: number | null,
    side: "home" | "away",
  ) => (
    <div
      className={`flex items-center justify-between gap-2 px-2 py-1 ${
        winner === side ? "font-semibold text-foreground" : "text-muted-foreground"
      }`}
    >
      <span className="truncate text-xs">{name ?? t("TBD")}</span>
      <span className="font-tabular text-xs">{score ?? "–"}</span>
    </div>
  );

  return (
    <div className="w-44 rounded-md border bg-card text-card-foreground shadow-xs">
      {row(m.home_team?.name, m.home_score, "home")}
      <div className="border-t" />
      {row(m.away_team?.name, m.away_score, "away")}
    </div>
  );
}

/**
 * Visual fixture view: a left-to-right flow of rounds. Each group/stage is a
 * band; within it, matches are laid out in columns by round (a knockout reads
 * as a bracket tree; a round-robin reads as a round-by-round schedule).
 */
export function BracketView({ matches }: { matches: MatchRow[] }): React.ReactElement {
  const bands = useMemo(() => {
    const byGroup = new Map<string, MatchRow[]>();
    for (const m of matches) {
      const key = m.group_label || t("Bracket");
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(m);
    }
    return [...byGroup.entries()].map(([label, ms]) => {
      const byRound = new Map<number, MatchRow[]>();
      for (const m of ms) {
        if (!byRound.has(m.round_no)) byRound.set(m.round_no, []);
        byRound.get(m.round_no)!.push(m);
      }
      const columns = [...byRound.entries()].sort((a, b) => a[0] - b[0]);
      return { label, columns };
    });
  }, [matches]);

  if (matches.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No fixtures yet.")}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {bands.map((band) => (
        <div key={band.label}>
          <h3 className="mb-2 text-sm font-semibold">{band.label}</h3>
          <div className="flex gap-6 overflow-x-auto pb-2">
            {band.columns.map(([round, rms]) => (
              <div
                key={round}
                className="flex min-w-44 flex-col justify-around gap-3"
              >
                <div className="text-overline uppercase tracking-wide text-muted-foreground">
                  {t("Round")} {round}
                </div>
                {rms.map((m) => (
                  <MatchBox key={m.id} m={m} />
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
