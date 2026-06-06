import { useMemo } from "react";
import { Check } from "lucide-react";
import type { MatchRow } from "@/api/tournaments";
import { t } from "@/lib/t";

// Fixed geometry so the knockout connectors line up deterministically.
const CARD_H = 56; // px — must match the rendered card height
const BASE_GAP = 28; // px — vertical gap between round-1 matches
const SLOT = CARD_H + BASE_GAP;
const STUB = 16; // px — horizontal connector length

type Side = "home" | "away";

function winnerSide(m: MatchRow): Side | null {
  if (m.status !== "completed" || m.home_score == null || m.away_score == null) {
    return null;
  }
  if (m.home_score > m.away_score) return "home";
  if (m.away_score > m.home_score) return "away";
  return null;
}

function MatchCard({ m }: { m: MatchRow }): React.ReactElement {
  const win = winnerSide(m);
  const row = (name: string | undefined, score: number | null, side: Side) => (
    <div
      className={`flex items-center gap-2 px-2.5 py-1 ${
        win === side ? "bg-accent/60 font-semibold text-foreground" : ""
      }`}
    >
      {win === side ? (
        <Check aria-hidden="true" className="h-3 w-3 shrink-0 text-primary" />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span className="flex-1 truncate text-xs">{name ?? t("TBD")}</span>
      <span className="font-tabular text-xs tabular-nums">{score ?? "–"}</span>
    </div>
  );
  return (
    <div className="w-52 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm">
      {row(m.home_team?.name, m.home_score, "home")}
      <div className="h-px bg-border" />
      {row(m.away_team?.name, m.away_score, "away")}
    </div>
  );
}

/** A connected single-elimination tree (winners flow left → right). */
function KnockoutTree({
  columns,
}: {
  columns: [number, MatchRow[]][];
}): React.ReactElement {
  return (
    <div className="flex overflow-x-auto pb-4 pt-1">
      {columns.map(([round, ms], ci) => {
        const gap = 2 ** ci * SLOT - CARD_H; // gap between matches this round
        const firstTop = ((2 ** ci - 1) * SLOT) / 2; // center the round vs round 1
        const last = ci === columns.length - 1;
        return (
          <div key={round} className="flex flex-col" style={{ minWidth: 208 + STUB * 2 }}>
            <div className="h-6 text-overline uppercase tracking-wide text-muted-foreground">
              {t("Round")} {round}
            </div>
            {ms.map((m, mi) => (
              <div
                key={m.id}
                className="relative"
                style={{ height: CARD_H, marginTop: mi === 0 ? firstTop : gap }}
              >
                <MatchCard m={m} />
                {!last ? (
                  <>
                    {/* stub out of this match */}
                    <span
                      className="absolute bg-border"
                      style={{ left: "100%", top: CARD_H / 2, width: STUB, height: 1 }}
                    />
                    {mi % 2 === 0 ? (
                      <>
                        {/* vertical joiner down to the pair partner */}
                        <span
                          className="absolute bg-border"
                          style={{
                            left: `calc(100% + ${STUB}px)`,
                            top: CARD_H / 2,
                            width: 1,
                            height: gap + CARD_H,
                          }}
                        />
                        {/* stub into the next round */}
                        <span
                          className="absolute bg-border"
                          style={{
                            left: `calc(100% + ${STUB}px)`,
                            top: CARD_H / 2 + (gap + CARD_H) / 2,
                            width: STUB,
                            height: 1,
                          }}
                        />
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Round-robin: simple round-by-round columns (no tree — there's no progression). */
function GroupColumns({
  columns,
}: {
  columns: [number, MatchRow[]][];
}): React.ReactElement {
  return (
    <div className="flex gap-6 overflow-x-auto pb-2">
      {columns.map(([round, ms]) => (
        <div key={round} className="flex min-w-52 flex-col gap-3">
          <div className="text-overline uppercase tracking-wide text-muted-foreground">
            {t("Round")} {round}
          </div>
          {ms.map((m) => (
            <MatchCard key={m.id} m={m} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Visual fixture view. A knockout band renders as a connected bracket tree;
 * a round-robin group renders as round-by-round matchup columns.
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
      const isKnockout = ms.some((m) => m.stage === "knockout");
      return { label, columns, isKnockout };
    });
  }, [matches]);

  if (matches.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No fixtures yet.")}</p>;
  }

  return (
    <div className="flex flex-col gap-8">
      {bands.map((band) => (
        <div key={band.label}>
          <h3 className="mb-2 text-sm font-semibold">{band.label}</h3>
          {band.isKnockout ? (
            <KnockoutTree columns={band.columns} />
          ) : (
            <GroupColumns columns={band.columns} />
          )}
        </div>
      ))}
    </div>
  );
}
