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
        const gap = 2 ** ci * SLOT - CARD_H;
        const firstTop = ((2 ** ci - 1) * SLOT) / 2;
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
                    <span
                      className="absolute bg-border"
                      style={{ left: "100%", top: CARD_H / 2, width: STUB, height: 1 }}
                    />
                    {mi % 2 === 0 ? (
                      <>
                        <span
                          className="absolute bg-border"
                          style={{
                            left: `calc(100% + ${STUB}px)`,
                            top: CARD_H / 2,
                            width: 1,
                            height: gap + CARD_H,
                          }}
                        />
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

interface StandRow {
  team_id: string;
  name: string;
  P: number;
  W: number;
  D: number;
  L: number;
  GF: number;
  GA: number;
  GD: number;
  Pts: number;
}

function computeStandings(matches: MatchRow[]): StandRow[] {
  const table = new Map<string, StandRow>();
  const get = (team: MatchRow["home_team"]): StandRow | null => {
    if (!team) return null;
    let r = table.get(team.id);
    if (!r) {
      r = { team_id: team.id, name: team.name, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 };
      table.set(team.id, r);
    }
    return r;
  };
  for (const m of matches) {
    if (m.status !== "completed" || m.home_score == null || m.away_score == null) continue;
    const h = get(m.home_team);
    const a = get(m.away_team);
    if (!h || !a) continue;
    const hs = m.home_score;
    const as = m.away_score;
    h.P++; a.P++; h.GF += hs; h.GA += as; a.GF += as; a.GA += hs;
    if (hs > as) { h.W++; a.L++; h.Pts += 3; }
    else if (as > hs) { a.W++; h.L++; a.Pts += 3; }
    else { h.D++; a.D++; h.Pts++; a.Pts++; }
  }
  const rows = [...table.values()];
  for (const r of rows) r.GD = r.GF - r.GA;
  rows.sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.name.localeCompare(y.name));
  return rows;
}

/** Round-robin group → standings table with the top-2 marked as advancing. */
function GroupTable({
  matches,
  advance = 2,
}: {
  matches: MatchRow[];
  advance?: number;
}): React.ReactElement {
  const rows = computeStandings(matches);
  const cols = ["P", "W", "D", "L", "GF", "GA", "GD", "Pts"] as const;
  return (
    <table className="w-full max-w-xl text-sm font-tabular">
      <thead>
        <tr className="text-left text-xs text-muted-foreground">
          <th className="py-1 pr-2 font-medium">{t("Team")}</th>
          {cols.map((h) => (
            <th key={h} className="px-1 py-1 text-right font-medium">{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={r.team_id}
            className={`border-t ${i < advance ? "bg-accent/40" : ""}`}
            title={i < advance ? t("Advances") : undefined}
          >
            <td className="py-1 pr-2">
              <span className="mr-1 text-primary">{i < advance ? "▲" : ""}</span>
              <span>{r.name}</span>
            </td>
            {[r.P, r.W, r.D, r.L, r.GF, r.GA, r.GD, r.Pts].map((v, j) => (
              <td
                key={j}
                className={`px-1 py-1 text-right ${j === cols.length - 1 ? "font-semibold" : ""}`}
              >
                {v}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Visual fixture view. A knockout band renders as a connected bracket tree; a
 * round-robin group renders as a standings table (top-2 marked as advancing) —
 * the meaningful "flow" for a group, since there is no tree.
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
      return { label, columns, matches: ms, isKnockout };
    });
  }, [matches]);

  if (matches.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No fixtures yet.")}</p>;
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      {bands.map((band) => (
        <div key={band.label}>
          <h3 className="mb-2 text-sm font-semibold">{band.label}</h3>
          {band.isKnockout ? (
            <div className="lg:col-span-2">
              <KnockoutTree columns={band.columns} />
            </div>
          ) : (
            <GroupTable matches={band.matches} />
          )}
        </div>
      ))}
    </div>
  );
}
