import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { type MatchRow, type PublicScheduleMatch } from "@/api/tournaments";
import { BracketView } from "@/features/tournaments/BracketView";
import { t } from "@/lib/t";
import { splitLabel } from "./publicTournament";
import { Bookmark } from "./publicTournamentViews";

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

interface Bracket {
  key: string;
  label: string;
  sport: string;
  matches: MatchRow[];
}

/** One competition's knockout tree, exactly as the standalone Knockout page
 * drew it. The bracket flow UI itself is untouched (owner 2026-08-21) — only
 * where it is reached from has changed. */
export function CompetitionBracket({
  matches,
  timeZone,
  leafKey,
}: {
  matches: PublicScheduleMatch[];
  timeZone: string | undefined;
  leafKey: string;
}): React.ReactElement {
  const rows = useMemo(
    () =>
      matches.filter((m) => m.stage === "knockout").map(toMatchRow),
    [matches],
  );
  if (rows.length === 0) return <NoBracket />;
  return (
    <div
      data-testid={`bracket-${leafKey}`}
      className="overflow-x-auto p-3 sm:p-4"
    >
      <BracketView matches={rows} timeZone={timeZone} />
    </div>
  );
}

function NoBracket(): React.ReactElement {
  return (
    <div className="p-8 text-center">
      <p className="text-sm font-medium">
        {t("The knockout bracket appears here once the group stage finishes.")}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t("Group tables are on the Standings view of each competition.")}
      </p>
    </div>
  );
}

/**
 * Every competition's knockout tree behind one bookmarked board: sport tabs on
 * top, categories inside, ONE bracket at a time (a tree is large). This was the
 * whole /bracket page; it now lives inside the match centre as the "Knockout"
 * scope, so a viewer never leaves the page to follow the draw.
 *
 * The selection rides its own URL params (`kosport` / `kocomp`) so a bracket
 * stays shareable without colliding with the page's own competition scope.
 */
export function PublicBracketBoard({
  matches,
  timeZone,
}: {
  matches: PublicScheduleMatch[];
  timeZone: string | undefined;
}): React.ReactElement {
  const [params, setParams] = useSearchParams();

  // One bracket per competition leaf (TT Singles, Sepak Takraw, ...) — only the
  // knockout matches; the group stage lives on the competition's own view.
  const bySport = useMemo(() => {
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
  }, [matches]);

  const sportParam = params.get("kosport") ?? "";
  const compParam = params.get("kocomp") ?? "";
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
      p.set("kosport", next.sport);
      p.delete("kocomp");
    }
    if (next.comp !== undefined) p.set("kocomp", next.comp);
    setParams(p, { replace: true });
  };

  if (compsOfSport.length === 0) return <NoBracket />;

  return (
    <div data-testid="bracket-board" className="flex flex-col p-3 sm:p-4">
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

      <div className="flex flex-col gap-4 rounded-xl rounded-tl-none border border-border bg-card p-3 shadow-sm sm:p-4">
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
              <BracketView matches={b.matches} timeZone={timeZone} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
