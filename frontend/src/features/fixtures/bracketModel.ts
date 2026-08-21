import { type MatchRow, type PublicScheduleMatch } from "@/api/tournaments";
import { t } from "@/lib/t";
import { splitLabel } from "./publicTournament";

/** The knockout MODEL behind both boards that draw it: the public bracket
 * board on screen and the printed draw. It lives apart from the components so
 * ONE builder answers "which brackets exist, what are they called, and which
 * one is selected" — a second copy in the print document is exactly how a
 * printed draw ends up showing a different competition from the screen.
 */

/** Public schedule row to the MatchRow shape BracketView renders (set-sport
 * winners already fall out of home/away_score = sets won). */
export function toMatchRow(m: PublicScheduleMatch): MatchRow {
  const team = (s: PublicScheduleMatch["home"]) =>
    s
      ? { id: s.id, name: s.name, short_name: s.short_name, crest: s.crest }
      : null;
  return {
    id: m.id,
    stage: m.stage,
    group_label: m.group_label,
    round_no: m.round_no,
    match_no: m.match_no,
    status: m.status,
    home_team: team(m.home),
    away_team: team(m.away),
    home_score: m.home_score,
    away_score: m.away_score,
    sport: m.sport,
    set_scores: m.set_scores,
    leaf_key: m.leaf_key,
    venue: m.venue,
    scoring: null,
    scheduled_at: m.scheduled_at,
    home_pens: m.home_pens,
    away_pens: m.away_pens,
    stage_no: m.stage_no,
    // pass the typed pointers through so an unresolved slot shows "Group A #1"
    home_source: m.home_source,
    away_source: m.away_source,
  };
}

export interface Bracket {
  key: string;
  label: string;
  sport: string;
  matches: MatchRow[];
}

/** Every competition's knockout tree, grouped by sport. ONE builder, so the
 * board on screen and the printed draw can never disagree about which
 * brackets exist or what they are called. */
export function buildBrackets(
  matches: PublicScheduleMatch[],
): [string, Bracket[]][] {
  const byLeaf = new Map<string, Bracket>();
  for (const m of matches) {
    if (m.stage !== "knockout") continue;
    const key = m.leaf_key || "_";
    let b = byLeaf.get(key);
    if (!b) {
      const label = m.leaf_label || t("Bracket");
      b = {
        key,
        label,
        sport: splitLabel(label)[0] ?? t("Bracket"),
        matches: [],
      };
      byLeaf.set(key, b);
    }
    b.matches.push(toMatchRow(m));
  }
  const grouped = new Map<string, Bracket[]>();
  for (const b of byLeaf.values()) {
    if (!grouped.has(b.sport)) grouped.set(b.sport, []);
    grouped.get(b.sport)!.push(b);
  }
  return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** The bracket the board is showing, from its own URL params — the print
 * document reads the SAME selection, so Print gives you the draw you are
 * looking at, not a different one. */
export function pickBracket(
  bySport: [string, Bracket[]][],
  sportParam: string,
  compParam: string,
): Bracket | null {
  const sport = bySport.some(([s]) => s === sportParam)
    ? sportParam
    : (bySport[0]?.[0] ?? "");
  const comps = bySport.find(([s]) => s === sport)?.[1] ?? [];
  return comps.find((c) => c.key === compParam) ?? comps[0] ?? null;
}

