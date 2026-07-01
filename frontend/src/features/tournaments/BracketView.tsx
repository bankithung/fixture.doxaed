import { useMemo } from "react";
import type { MatchRow } from "@/api/tournaments";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
import { FifaBracket } from "./FifaBracket";

/** Drop a trailing "3rd Place" playoff segment so a knockout band heading reads
 * as the competition, not its consolation match (labels are " — "-joined). */
function stripPlayoffSuffix(label: string): string {
  const segs = label.split(" — ");
  if (segs.length > 1 && segs[segs.length - 1]?.trim() === "3rd Place") segs.pop();
  return segs.join(" — ");
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

/** Round-robin group → a clean FIFA-style standings table: numbered rank, a
 * 2px accent rule on the top-N qualifying rows (no glyph), tabular figures. */
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
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[0.625rem] uppercase tracking-wide text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">{t("Team")}</th>
            {cols.map((h) => (
              <th key={h} className="px-2 py-1.5 text-right font-medium">
                {t(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.team_id}
              className={cn(
                "border-t border-border",
                i < advance && "border-l-2 border-primary",
              )}
              title={i < advance ? t("Advances") : undefined}
            >
              <td className="px-3 py-1.5 font-medium">
                <span className="mr-1.5 font-tabular text-xs text-muted-foreground">
                  {i + 1}
                </span>
                {r.name}
              </td>
              {[r.P, r.W, r.D, r.L, r.GF, r.GA, r.GD, r.Pts].map((v, j) => (
                <td
                  key={j}
                  className={cn(
                    "px-2 py-1.5 text-right font-tabular",
                    j === cols.length - 1
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Visual fixture view. A knockout band renders as a connected bracket tree; a
 * round-robin group renders as a standings table (top-2 marked as advancing) —
 * the meaningful "flow" for a group, since there is no tree.
 */
export function BracketView({
  matches,
  timeZone,
}: {
  matches: MatchRow[];
  /** IANA TZ for kickoff formatting + the bracket footnote (omit = viewer local). */
  timeZone?: string;
}): React.ReactElement {
  const bands = useMemo(() => {
    // Groups key on leaf_key + group_label so two DIFFERENT categories that
    // both contain a "Group A" stay separate. Knockout keys on leaf_key ALONE
    // so a competition's whole bracket is ONE band, including its 3rd-place
    // playoff (which carries a trailing "3rd Place" group_label segment and
    // would otherwise spin off an empty phantom band); FifaBracket draws that
    // consolation match below the tree.
    const byGroup = new Map<
      string,
      { key: string; label: string; matches: MatchRow[] }
    >();
    for (const m of matches) {
      const isKo = m.stage === "knockout";
      const label = isKo
        ? stripPlayoffSuffix(m.group_label || t("Bracket"))
        : m.group_label || t("Bracket");
      const key = isKo ? `${m.leaf_key}::ko` : `${m.leaf_key}::${label}`;
      const band = byGroup.get(key);
      if (!band) {
        byGroup.set(key, { key, label, matches: [m] });
      } else {
        band.matches.push(m);
        // Prefer a shorter (non-suffixed, winner-bracket) label if seen later.
        if (isKo && label.length < band.label.length) band.label = label;
      }
    }
    return [...byGroup.values()].map(({ key, label, matches: ms }) => {
      const byRound = new Map<number, MatchRow[]>();
      for (const m of ms) {
        if (!byRound.has(m.round_no)) byRound.set(m.round_no, []);
        byRound.get(m.round_no)!.push(m);
      }
      const columns = [...byRound.entries()].sort((a, b) => a[0] - b[0]);
      const isKnockout = ms.some((m) => m.stage === "knockout");
      return { key, label, columns, matches: ms, isKnockout };
    });
  }, [matches]);

  if (matches.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("No fixtures yet.")}</p>;
  }

  // Group tables tile two-up; each knockout bracket takes the full width (a
  // bracket tree is wide — never squeeze it into a half column).
  const groupBands = bands.filter((b) => !b.isKnockout);
  const koBands = bands.filter((b) => b.isKnockout);

  return (
    <div className="flex flex-col gap-8">
      {groupBands.length > 0 ? (
        <div className="grid items-start gap-8 lg:grid-cols-2">
          {groupBands.map((band) => (
            <div key={band.key}>
              <h3 className="mb-2">
                <LeafLabel label={band.label} size="md" />
              </h3>
              <GroupTable matches={band.matches} />
            </div>
          ))}
        </div>
      ) : null}
      {koBands.map((band) => (
        <div key={band.key}>
          <h3 className="mb-2">
            <LeafLabel label={band.label} size="md" />
          </h3>
          <FifaBracket columns={band.columns} timeZone={timeZone} />
        </div>
      ))}
    </div>
  );
}
