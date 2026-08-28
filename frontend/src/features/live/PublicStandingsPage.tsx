import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { RotateCcw, Trophy } from "lucide-react";
import {
  buildCompetitions,
  usePublicTournament,
  type Competition,
} from "@/features/fixtures/publicTournament";
import {
  Bookmark,
  Chip,
  FilterFab,
  GroupTable,
} from "@/features/fixtures/publicTournamentViews";
import { splitLabel } from "@/features/fixtures/publicTournament";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { PublicViewerHeader } from "./PublicViewerHeader";

/**
 * Public STANDINGS tab (Google-panel style): every competition's group tables
 * in one place, grouped by sport. Columns are sport-native (a table tennis or
 * sepak table reads P W L Sets +/-, never a draw column). Reads the same
 * schedule + standings queries as the Matches and Knockout tabs, so switching
 * tabs is instant and the SSE tick keeps every table live.
 *
 * ONE section, built like the Matches page (owner 2026-08-28): the
 * tournament name is the section's own header band — no "Standings" title
 * and strap-line, the tab already says that — and the tables live directly
 * under it. On a desk the sport / category bookmarks sit inside the panel;
 * on a phone they become the floating Filter pill + bottom sheet the Matches
 * page wears, so the picker never scrolls away and the tables get the whole
 * width of the screen.
 */
export function PublicStandingsPage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { isMobile } = useBreakpoint();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { scheduleQ, standingsQ, connected } = usePublicTournament(
    slug,
    id,
  );

  const tournamentName = scheduleQ.data?.tournament.name;
  useEffect(() => {
    if (tournamentName) {
      document.title = `${tournamentName} · ${t("Standings")}`;
    }
  }, [tournamentName]);

  // Every competition that has a table, grouped by sport.
  const all = useMemo(() => {
    const comps = buildCompetitions(
      scheduleQ.data?.matches ?? [],
      standingsQ.data?.groups,
    )
      .map((c) => ({
        ...c,
        groups: c.groups.filter((g) => (g.standing?.rows.length ?? 0) > 0),
      }))
      .filter((c) => c.groups.length > 0);
    const bySport = new Map<string, Competition[]>();
    for (const c of comps) {
      if (!bySport.has(c.sport)) bySport.set(c.sport, []);
      bySport.get(c.sport)!.push(c);
    }
    return [...bySport.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [scheduleQ.data, standingsQ.data]);

  // Sport + category filter (owner 2026-07-13: a 20-competition tournament
  // stacked every table on one page). Kept in the URL so a filtered view is
  // shareable; an unknown value falls back to showing everything.
  const sportParam = params.get("sport") ?? "";
  const compParam = params.get("comp") ?? "";
  const sport = all.some(([s]) => s === sportParam) ? sportParam : "";
  const compsOfSport = useMemo(
    () => (sport ? (all.find(([s]) => s === sport)?.[1] ?? []) : []),
    [all, sport],
  );
  const comp = compsOfSport.some((c) => c.key === compParam) ? compParam : "";

  const setFilter = (next: { sport?: string; comp?: string }): void => {
    const p = new URLSearchParams(params);
    const s = next.sport ?? sport;
    const c = next.comp ?? "";
    if (s) p.set("sport", s);
    else p.delete("sport");
    if (c) p.set("comp", c);
    else p.delete("comp");
    setParams(p, { replace: true });
  };

  const sections = useMemo(
    () =>
      all
        .filter(([s]) => !sport || s === sport)
        .map(
          ([s, comps]) =>
            [s, comp ? comps.filter((c) => c.key === comp) : comps] as [
              string,
              Competition[],
            ],
        ),
    [all, sport, comp],
  );

  const loading =
    scheduleQ.isLoading || (scheduleQ.data !== undefined && standingsQ.isLoading);

  const compName = (c: Competition): string =>
    splitLabel(c.label).slice(1).join(" · ") || c.label;
  const totalComps = all.reduce((n, [, comps]) => n + comps.length, 0);
  const shownTables = sections.reduce(
    (n, [, comps]) => n + comps.reduce((m, c) => m + c.groups.length, 0),
    0,
  );
  const activeFilters = (sport ? 1 : 0) + (comp ? 1 : 0);
  const pickedComp = compsOfSport.find((c) => c.key === comp);
  /** What is on screen, as the phone's pill reads it. */
  const scopeName = !sport
    ? t("All sports")
    : pickedComp
      ? `${sport} · ${compName(pickedComp)}`
      : sport;

  /* Authored once, worn by whichever surface fits: bookmarks on a desk, chips
     in the phone's sheet. */
  const sportPicker = (
    variant: "bookmark" | "chip",
  ): React.ReactElement => {
    const Pick = variant === "bookmark" ? Bookmark : Chip;
    return (
      <div
        role="tablist"
        aria-label={t("Sports")}
        className="flex flex-wrap items-center gap-1.5 print:hidden"
      >
        <Pick
          testid="standings-sport-all"
          active={!sport}
          onClick={() => setFilter({ sport: "", comp: "" })}
          label={t("All sports")}
          count={totalComps}
        />
        {all.map(([s, comps]) => (
          <Pick
            key={s}
            testid={`standings-sport-pick-${s}`}
            active={sport === s}
            onClick={() => setFilter({ sport: s, comp: "" })}
            label={s}
            count={comps.length}
          />
        ))}
      </div>
    );
  };
  const compPicker = (
    variant: "bookmark" | "chip",
  ): React.ReactElement | null => {
    if (!sport || compsOfSport.length <= 1) return null;
    const Pick = variant === "bookmark" ? Bookmark : Chip;
    return (
      <div
        role="tablist"
        aria-label={t("Categories")}
        className={cn(
          "flex flex-wrap items-center gap-1.5",
          variant === "bookmark" && "border-b border-border pb-3",
        )}
      >
        <Pick
          testid="standings-comp-all"
          active={!comp}
          onClick={() => setFilter({ comp: "" })}
          label={t("All categories")}
        />
        {compsOfSport.map((c) => (
          <Pick
            key={c.key}
            testid={`standings-comp-pick-${c.key}`}
            active={comp === c.key}
            onClick={() => setFilter({ comp: c.key })}
            label={splitLabel(c.label).slice(1).join(" ") || c.label}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="flex min-h-screen flex-col print-doc">
      <PublicViewerHeader
        slug={slug}
        id={id}
        tournamentName={tournamentName}
        active="standings"
        connected={connected}
      />
      <main className="flex w-full max-w-full min-w-0 flex-1 flex-col p-0 sm:px-6 sm:py-4 lg:px-8">
        {/* ONE section, nothing outside it: the tournament name is its header
            band and the tables sit straight under it. Edge to edge on a phone
            (the screen is the card), a card on a desk. */}
        <section className="flex min-w-0 flex-1 flex-col border-y border-border bg-card print:border-0 sm:rounded-xl sm:border sm:shadow-sm">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-3 py-3 print:hidden sm:px-4">
            <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
              {tournamentName ?? t("Standings")}
            </h1>
            {!loading && !scheduleQ.isError ? (
              <span
                data-testid="standings-indicator"
                className="inline-flex items-center gap-1.5 font-tabular text-xs text-muted-foreground"
              >
                {shownTables} {shownTables === 1 ? t("table") : t("tables")} ·{" "}
                {connected ? (
                  <>
                    <span className="inline-flex h-2 w-2 rounded-full bg-primary" />
                    <span className="font-medium text-primary">
                      {t("live updates")}
                    </span>
                  </>
                ) : (
                  t("updates automatically")
                )}
              </span>
            ) : null}
          </div>

          {loading ? (
            <div aria-busy="true" className="m-3 h-48 animate-pulse rounded-xl bg-muted/40 sm:m-4" />
          ) : scheduleQ.isError ? (
            <p
              role="alert"
              className="p-8 text-center text-sm text-muted-foreground"
            >
              {t("These standings are not available.")}
            </p>
          ) : all.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-medium">{t("No group tables yet.")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Tables appear when the draw places teams into groups.")}
              </p>
            </div>
          ) : (
            /* ONE combined sheet: sport bookmarks on top, category bookmarks
               inside, every table in the same panel with a clear rule between
               categories (owner 2026-07-13). On a phone the bookmarks are the
               floating pill instead, and the panel has no frame of its own. */
            <div
              data-testid="standings-board"
              className={cn("flex flex-col", !isMobile && "p-4 sm:p-5")}
            >
              {!isMobile ? sportPicker("bookmark") : null}

              <div
                className={cn(
                  "flex flex-col gap-4 sm:gap-5",
                  !isMobile &&
                    "rounded-xl rounded-tl-none border border-border bg-card p-4 sm:p-5",
                )}
              >
                {!isMobile ? compPicker("bookmark") : null}

                {sections.map(([s, comps]) => (
                  <section
                    key={s}
                    data-testid={`standings-sport-${s}`}
                    className="flex flex-col gap-4 sm:gap-5"
                  >
                    {!sport ? (
                      <h2 className="px-3 pt-3 text-base font-semibold sm:px-0 sm:pt-0">
                        {s}
                      </h2>
                    ) : null}
                    {comps.map((c) => (
                      <div
                        key={c.key}
                        data-testid={`standings-comp-${c.key}`}
                        className="flex flex-col overflow-hidden border-y border-border sm:rounded-lg sm:border"
                      >
                        {/* Each category is its OWN titled block: a real
                            heading on a tinted band, not tiny chips. */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/60 px-3 py-2 sm:px-4 sm:py-2.5">
                          <h3 className="text-[0.8125rem] font-semibold sm:text-sm">
                            {compName(c)}
                          </h3>
                          <span className="font-tabular text-xs text-muted-foreground">
                            {c.groups.length}{" "}
                            {c.groups.length === 1 ? t("group") : t("groups")}
                          </span>
                        </div>
                        {/* On a phone the tables run edge to edge: a long
                            school name stays on one line and the table
                            scrolls sideways instead of wrapping to four. */}
                        <div className="grid grid-cols-1 items-start gap-x-6 gap-y-3 py-2 sm:gap-y-5 sm:p-4 2xl:grid-cols-2">
                          {c.groups.map((g) => (
                            <div key={g.key} className="flex min-w-0 flex-col">
                              <h4 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-primary sm:px-0">
                                {g.label}
                              </h4>
                              <div className="min-w-0 overflow-hidden border-y border-border sm:rounded-lg sm:border">
                                <GroupTable
                                  rows={g.standing!.rows}
                                  family={c.family}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* The phone's floating FILTER pill, the one the Matches page wears:
            it names what is on screen and opens the picker from anywhere on
            the page instead of a tab row that scrolled away. */}
        {isMobile && !loading && all.length > 0 ? (
          <FilterFab
            testid="standings-filters-open"
            onClick={() => setSheetOpen(true)}
            label={scopeName}
            count={activeFilters}
            icon={Trophy}
          />
        ) : null}

        <Dialog
          open={isMobile && sheetOpen}
          onOpenChange={setSheetOpen}
          variant="sheet"
          ariaLabel={t("Filter the standings")}
        >
          <div
            data-testid="standings-filter-sheet"
            className="flex flex-col gap-4"
          >
            <span
              aria-hidden="true"
              className="mx-auto h-1 w-10 shrink-0 rounded-full bg-border"
            />
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold">{t("Filters")}</h2>
              {activeFilters > 0 ? (
                <button
                  type="button"
                  data-testid="standings-sheet-reset"
                  onClick={() => setFilter({ sport: "", comp: "" })}
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary"
                >
                  <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Reset")}
                </button>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {t("Sport")}
              </span>
              {sportPicker("chip")}
            </div>

            {compPicker("chip") ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {t("Category")}
                </span>
                {compPicker("chip")}
              </div>
            ) : null}

            <Button
              data-testid="standings-sheet-apply"
              className="h-12 w-full text-base"
              onClick={() => setSheetOpen(false)}
            >
              {t("Show")} {shownTables}{" "}
              {shownTables === 1 ? t("table") : t("tables")}
            </Button>
          </div>
        </Dialog>
      </main>
    </div>
  );
}
