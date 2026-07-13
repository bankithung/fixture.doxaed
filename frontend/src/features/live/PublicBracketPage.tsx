import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { type MatchRow, type PublicScheduleMatch } from "@/api/tournaments";
import { BracketView } from "@/features/tournaments/BracketView";
import {
  splitLabel,
  usePublicTournament,
} from "@/features/fixtures/publicTournament";
import { Bookmark } from "@/features/fixtures/publicTournamentViews";
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
interface Bracket {
  key: string;
  label: string;
  sport: string;
  matches: MatchRow[];
}

export function PublicBracketPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { scheduleQ: query, connected, hasKnockout } = usePublicTournament(
    slug,
    id,
  );

  const tournamentName = query.data?.tournament.name;
  useEffect(() => {
    if (tournamentName) document.title = `${tournamentName} · ${t("Knockout")}`;
  }, [tournamentName]);

  // One bracket per competition leaf (TT Singles, Sepak Takraw, …) — only the
  // knockout matches; the group stage lives on the Standings tab. Grouped by
  // sport for the bookmark board.
  const bySport = useMemo(() => {
    const byLeaf = new Map<string, Bracket>();
    for (const m of query.data?.matches ?? []) {
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
  }, [query.data]);

  // Sport, then category — a bracket is big, so ONE renders at a time by
  // default (owner 2026-07-13). Kept in the URL so a view is shareable.
  const sportParam = params.get("sport") ?? "";
  const compParam = params.get("comp") ?? "";
  const sport = bySport.some(([s]) => s === sportParam)
    ? sportParam
    : (bySport[0]?.[0] ?? "");
  const compsOfSport = useMemo(
    () => bySport.find(([s]) => s === sport)?.[1] ?? [],
    [bySport, sport],
  );
  const comp = compsOfSport.some((c) => c.key === compParam)
    ? compParam
    : (compsOfSport[0]?.key ?? "");
  const shown = compsOfSport.filter((c) => c.key === comp);

  const setFilter = (next: { sport?: string; comp?: string }): void => {
    const p = new URLSearchParams(params);
    if (next.sport !== undefined) {
      p.set("sport", next.sport);
      p.delete("comp");
    }
    if (next.comp !== undefined) p.set("comp", next.comp);
    setParams(p, { replace: true });
  };

  const brackets = compsOfSport;

  return (
    <div className="flex min-h-screen flex-col">
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
          /* Same bookmarked board as Standings: sport tabs on top, categories
             inside, ONE bracket at a time (they are large). */
          <div data-testid="bracket-board" className="flex flex-col">
            <div
              role="tablist"
              aria-label={t("Sports")}
              className="flex flex-wrap items-end gap-1 overflow-x-auto px-2"
            >
              {bySport.map(([s, comps]) => (
                <Bookmark
                  key={s}
                  testid={`bracket-sport-pick-${s}`}
                  active={sport === s}
                  onClick={() => setFilter({ sport: s })}
                  label={s}
                  count={comps.length}
                />
              ))}
            </div>

            <div className="flex flex-col gap-4 rounded-xl rounded-tl-none border border-border bg-card p-4 shadow-sm sm:p-5">
              {compsOfSport.length > 1 ? (
                <div
                  role="tablist"
                  aria-label={t("Categories")}
                  className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3"
                >
                  {compsOfSport.map((c) => (
                    <Bookmark
                      key={c.key}
                      testid={`bracket-comp-pick-${c.key}`}
                      active={comp === c.key}
                      onClick={() => setFilter({ comp: c.key })}
                      label={splitLabel(c.label).slice(1).join(" ") || c.label}
                    />
                  ))}
                </div>
              ) : null}

              {shown.map((b) => (
                <section
                  key={b.key}
                  data-testid={`bracket-${b.key}`}
                  className="flex flex-col gap-3"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2 className="text-sm font-semibold">
                      {splitLabel(b.label).slice(1).join(" · ") || b.label}
                    </h2>
                    <span className="font-tabular text-xs text-muted-foreground">
                      {b.matches.length} {t("matches")}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <BracketView
                      matches={b.matches}
                      timeZone={query.data?.tournament.time_zone}
                    />
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
