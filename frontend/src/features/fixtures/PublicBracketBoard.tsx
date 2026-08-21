import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Users } from "lucide-react";
import { type PublicScheduleMatch } from "@/api/tournaments";
import { BracketView } from "@/features/tournaments/BracketView";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { buildBrackets, pickBracket, toMatchRow } from "./bracketModel";
import { splitLabel, type RosterIndex } from "./publicTournament";
import { Bookmark } from "./publicTournamentViews";

/**
 * "Show the players" — one switch, sitting on the board it changes.
 *
 * A draw names TEAMS, which for a school event is a school and a suffix
 * ("Grace Academy TT-1"); who is actually playing is the next question every
 * parent asks, and until now the only answer was to open each match. Flipping
 * it grows every card to hold its team sheet (owner 2026-08-21).
 */
export function NamesToggle({
  on,
  onChange,
  testid = "bracket-names-toggle",
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  testid?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid={testid}
      onClick={() => onChange(!on)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        on
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-muted",
      )}
    >
      <Users aria-hidden className="h-3.5 w-3.5" />
      {t("Player names")}
    </button>
  );
}

/** One competition's knockout tree, exactly as the standalone Knockout page
 * drew it. The bracket flow UI itself is untouched (owner 2026-08-21) — only
 * where it is reached from has changed. */
export function CompetitionBracket({
  matches,
  timeZone,
  leafKey,
  numbers,
  linkFor,
  rosters,
}: {
  matches: PublicScheduleMatch[];
  timeZone: string | undefined;
  leafKey: string;
  /** Fixture numbering, so "Winner of M12" on the tree names the same match
   * the sheet above prints as M12. */
  numbers?: Map<string, number>;
  linkFor?: (id: string) => string;
  /** Set = the Player names switch is on: every card names its team sheet. */
  rosters?: RosterIndex;
}): React.ReactElement {
  const rows = useMemo(
    () => matches.filter((m) => m.stage === "knockout").map(toMatchRow),
    [matches],
  );
  if (rows.length === 0) return <NoBracket />;
  return (
    <div
      data-testid={`bracket-${leafKey}`}
      className="overflow-x-auto p-3 sm:p-4"
    >
      <BracketView
        matches={rows}
        timeZone={timeZone}
        matchNumbers={numbers}
        linkFor={linkFor ? (m) => linkFor(m.id) : undefined}
        rosters={rosters}
        wrapNames
      />
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
  numbers,
  linkFor,
  rosters,
  namesOn,
  onNames,
}: {
  matches: PublicScheduleMatch[];
  timeZone: string | undefined;
  numbers?: Map<string, number>;
  linkFor?: (id: string) => string;
  /** Set = the Player names switch is on: every card names its team sheet. */
  rosters?: RosterIndex;
  namesOn?: boolean;
  onNames?: (next: boolean) => void;
}): React.ReactElement {
  const [params, setParams] = useSearchParams();

  // One bracket per competition leaf (TT Singles, Sepak Takraw, ...) — only the
  // knockout matches; the group stage lives on the competition's own view.
  const bySport = useMemo(() => buildBrackets(matches), [matches]);

  const sportParam = params.get("kosport") ?? "";
  const compParam = params.get("kocomp") ?? "";
  const sport = bySport.some(([s]) => s === sportParam)
    ? sportParam
    : (bySport[0]?.[0] ?? "");
  const compsOfSport = useMemo(
    () => bySport.find(([s]) => s === sport)?.[1] ?? [],
    [bySport, sport],
  );
  // The SAME resolver the printed draw uses, so Print can never hand back a
  // different bracket from the one on screen.
  const picked = pickBracket(bySport, sportParam, compParam);
  const comp = picked?.key ?? "";
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
              {onNames ? (
                <span className="ml-auto">
                  <NamesToggle on={Boolean(namesOn)} onChange={onNames} />
                </span>
              ) : null}
            </div>
            <div className="overflow-x-auto">
              <BracketView
                matches={b.matches}
                timeZone={timeZone}
                matchNumbers={numbers}
                linkFor={linkFor ? (m) => linkFor(m.id) : undefined}
                rosters={rosters}
                wrapNames
              />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
