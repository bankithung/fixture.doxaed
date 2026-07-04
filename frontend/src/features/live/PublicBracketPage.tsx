import { useEffect, useMemo } from "react";
import { useParams } from "react-router-dom";
import { type MatchRow, type PublicScheduleMatch } from "@/api/tournaments";
import { BracketView } from "@/features/tournaments/BracketView";
import { usePublicTournament } from "@/features/fixtures/publicTournament";
import { t } from "@/lib/t";
import { PublicViewerHeader } from "./PublicViewerHeader";

/** Public schedule row → the MatchRow shape BracketView renders (set-sport
 * winners already fall out of home/away_score = sets won). */
function toMatchRow(m: PublicScheduleMatch): MatchRow {
  const team = (s: PublicScheduleMatch["home"]) =>
    s ? { id: s.id, name: s.name, short_name: s.short_name } : null;
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

/**
 * Public, login-free KNOCKOUT tab (R13): one connected FifaBracket tree per
 * competition (via the shared BracketView), reading the SAME schedule query
 * as the Matches and Standings tabs so switching is instant; the SSE tick
 * stream advances it as results land. No new backend (the public schedule
 * endpoint already serves every knockout match).
 */
export function PublicBracketPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const { scheduleQ: query, connected, hasKnockout } = usePublicTournament(
    slug,
    id,
  );

  const tournamentName = query.data?.tournament.name;
  useEffect(() => {
    if (tournamentName) document.title = `${tournamentName} · ${t("Knockout")}`;
  }, [tournamentName]);

  // One bracket per competition leaf (TT Singles, Sepak Takraw, …) — only the
  // knockout matches; the group stage lives on the Standings tab.
  const brackets = useMemo(() => {
    const byLeaf = new Map<
      string,
      { key: string; label: string; matches: MatchRow[] }
    >();
    for (const m of query.data?.matches ?? []) {
      if (m.stage !== "knockout") continue;
      const key = m.leaf_key || "_";
      if (!byLeaf.has(key)) {
        byLeaf.set(key, { key, label: m.leaf_label || t("Bracket"), matches: [] });
      }
      byLeaf.get(key)!.matches.push(toMatchRow(m));
    }
    return [...byLeaf.values()];
  }, [query.data]);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={tournamentName}
        active="bracket"
        connected={connected}
        showKnockout={hasKnockout !== false}
      />
      <main className="flex w-full flex-1 flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        {query.isLoading ? (
          <div className="h-48 animate-pulse rounded-xl bg-muted/40" />
        ) : brackets.length === 0 ? (
          <div className="rounded-xl border border-border bg-card p-8 text-center">
            <p className="text-sm font-medium">
              {t("The knockout bracket appears here once the group stage finishes.")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("See group tables on the Standings tab.")}
            </p>
          </div>
        ) : (
          brackets.map((b) => (
            <section
              key={b.key}
              data-testid={`bracket-${b.key}`}
              className="flex flex-col gap-3"
            >
              <h2 className="text-base font-semibold">{b.label}</h2>
              <div className="overflow-x-auto rounded-xl border border-border bg-card p-4">
                <BracketView matches={b.matches} timeZone={query.data?.tournament.time_zone} />
              </div>
            </section>
          ))
        )}
      </main>
    </div>
  );
}
