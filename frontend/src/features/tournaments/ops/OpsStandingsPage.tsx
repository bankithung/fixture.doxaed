import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import { tournamentsApi, type StandingsGroup } from "@/api/tournaments";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { isSetSport } from "@/lib/setDisplay";
import { t } from "@/lib/t";
import { useEventStream } from "@/lib/useEventStream";
import { BracketView } from "@/features/tournaments/BracketView";
import { Bookmark } from "@/features/fixtures/publicTournamentViews";

/** Humanized segments of a competition leaf key ("sepak_takraw.u14.boys" →
 * ["Sepak Takraw", "U14", "Boys"]). */
function leafSegments(key: string): string[] {
  if (!key) return [t("Tournament")];
  return key
    .split(".")
    .map((seg) =>
      seg.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    );
}

/** "Sepak Takraw — u-14 — boys — Group A" → "Group A" (legacy and current
 * separators both). Stage labels ("3rd Place") pass through unchanged. */
function shortGroupTitle(label: string): string {
  const parts = label.split(/\s+[\u00b7\u2014]\s+/);
  return parts[parts.length - 1] || label;
}

/** One group's standings table from the server (honours the tournament's
 * points + tiebreakers — `compute_standings`). Columns are SPORT-NATIVE
 * (P1.c): timed sports read P/W/D/L + GF/GA/GD; target (set) sports read
 * P/W/L + Sets + point diff — a sepak table never shows goal columns.
 * Wide columns fold away on mobile. */
function GroupCard({
  group,
  family = "timed",
  qualify = 0,
}: {
  group: StandingsGroup;
  family?: "timed" | "target";
  /** How many of the top rows advance to the knockout (0 = unknown). Derived
   * from the bracket's own group_position pointers, so the table shows the
   * qualification line the fixture actually uses. */
  qualify?: number;
}): React.ReactElement {
  type Row = StandingsGroup["rows"][number];
  const narrowCols: [string, (r: Row) => number][] =
    family === "target"
      ? [
          ["P", (r) => r.P],
          ["W", (r) => r.W],
          ["L", (r) => r.L],
        ]
      : [
          ["P", (r) => r.P],
          ["W", (r) => r.W],
          ["D", (r) => r.D],
          ["L", (r) => r.L],
        ];
  const wideCols: [string, (r: Row) => number | string][] =
    family === "target"
      ? [
          [t("Sets"), (r) => `${r.GF}-${r.GA}`],
          ["+/-", (r) => r.PD_pts ?? 0],
        ]
      : [
          ["GF", (r) => r.GF],
          ["GA", (r) => r.GA],
          ["GD", (r) => r.GD],
        ];
  const played = group.rows.reduce((n, r) => n + r.P, 0) > 0;
  return (
    <section
      data-testid={`ops-group-${group.group_label}`}
      className="flex min-w-0 flex-col"
    >
      <div className="flex items-baseline gap-2 pb-1">
        <h4
          title={group.group_label}
          className="text-xs font-semibold uppercase tracking-wide text-primary"
        >
          {shortGroupTitle(group.group_label)}
        </h4>
        {!played ? (
          <span className="text-xs text-muted-foreground">
            {t("Not started")}
          </span>
        ) : null}
      </div>
      <table className="w-full overflow-hidden rounded-lg border border-border font-tabular text-sm">
        <thead>
          <tr className="border-b border-border text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
            <th className="py-2 pl-4 pr-2 text-left font-medium">
              {t("Team")}
            </th>
            {narrowCols.map(([h]) => (
              <th key={h} className="px-1.5 py-1.5 text-right font-medium">
                {h}
              </th>
            ))}
            {wideCols.map(([h]) => (
              <th
                key={h}
                className="hidden px-1.5 py-1.5 text-right font-medium sm:table-cell"
              >
                {h}
              </th>
            ))}
            <th className="px-1.5 py-1.5 pr-4 text-right font-medium">
              {t("Pts")}
            </th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((r, i) => {
            const q = qualify > 0 && i < qualify;
            return (
              <tr
                key={r.team_id}
                data-testid={`ops-standing-${r.team_id}`}
                className={cn(
                  "border-b border-border/60 transition-colors last:border-b-0 hover:bg-secondary/40",
                  q && "bg-success-muted/40",
                )}
              >
                <td className="py-1.5 pl-4 pr-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "w-5 shrink-0 rounded text-center text-xs font-semibold",
                        q
                          ? "bg-success-muted text-success"
                          : "text-muted-foreground",
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {r.name}
                      </span>
                      {/* The school line only earns its space when it says
                          something the team name did not — school-entered teams
                          carry the school AS the name, and it printed twice. */}
                      {r.school && r.school !== r.name ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {r.school}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </td>
                {narrowCols.map(([h, get]) => (
                  <td key={h} className="px-1.5 py-1.5 text-right">
                    {get(r)}
                  </td>
                ))}
                {wideCols.map(([h, get]) => (
                  <td
                    key={h}
                    className="hidden px-1.5 py-1.5 text-right text-muted-foreground sm:table-cell"
                  >
                    {get(r)}
                  </td>
                ))}
                <td className="px-1.5 py-1.5 pr-4 text-right font-semibold">
                  {r.Pts}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Operations: live standings & bracket per competition (ops 2026-06-26). The
 * server's `compute_standings` (accurate points + tiebreakers) drives the group
 * tables; the knockout matches render through the shared BracketView tree. A
 * competition picker scopes the view (group_label is globally unique, so each
 * server standings group maps cleanly to its competition). Everything rides the
 * tournament's public SSE tick, so tables and brackets advance with no refresh.
 */
export function OpsStandingsPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const [leaf, setLeaf] = useState<string | null>(null);
  // The sport facet lives in the URL (?sport=) so it survives navigation
  // between ops pages and deep-links (P1.c, multisport design).
  const [searchParams, setSearchParams] = useSearchParams();
  const sport = searchParams.get("sport");
  const setSport = (sp: string) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("sport", sp);
        return next;
      },
      { replace: true },
    );
  const metaQ = useQuery({
    queryKey: ["sports-meta", id],
    queryFn: () => tournamentsApi.sportsMeta(id),
    staleTime: 300_000,
  });

  const tournamentQ = useQuery({
    queryKey: ["tournament", id],
    queryFn: () => tournamentsApi.get(id),
  });
  const matchesQ = useQuery({
    queryKey: qk.matches(id),
    queryFn: () => tournamentsApi.matches(id),
  });
  const standingsQ = useQuery({
    queryKey: qk.standings(id),
    queryFn: () => tournamentsApi.standings(id),
  });

  // Live: the tournament tick invalidates both queries so the view advances.
  const slug = tournamentQ.data?.slug || null;
  useEventStream(slug ? liveApi.streamUrl(slug, id) : null, () => {
    qc.invalidateQueries({ queryKey: qk.matches(id) });
    qc.invalidateQueries({ queryKey: qk.standings(id) });
  });

  const matches = useMemo(() => matchesQ.data ?? [], [matchesQ.data]);
  const competitions = useMemo(() => {
    const seen = new Set<string>();
    for (const m of matches) seen.add(m.leaf_key);
    return [...seen].sort().map((key) => {
      const segs = leafSegments(key);
      return { key, sport: segs[0], rest: segs.slice(1).join(" ") };
    });
  }, [matches]);

  const sports = useMemo(
    () => [...new Set(competitions.map((c) => c.sport))],
    [competitions],
  );
  const activeSport = sport ?? sports[0] ?? "";
  const inSport = competitions.filter((c) => c.sport === activeSport);
  // Chips carry HUMANIZED sport names ("Sepak Takraw"); descriptors are
  // keyed by the underscored sport key — normalize before looking up.
  const activeSportKey = activeSport.toLowerCase().replace(/\s+/g, "_");
  const family =
    metaQ.data?.descriptors[activeSportKey]?.family ??
    (isSetSport({ sport: activeSportKey }) ? "target" : "timed");
  const selected =
    leaf && inSport.some((c) => c.key === leaf)
      ? leaf
      : (inSport[0]?.key ?? "");
  const scoped = useMemo(
    () => matches.filter((m) => m.leaf_key === selected),
    [matches, selected],
  );
  const knockout = useMemo(
    () => scoped.filter((m) => m.stage === "knockout"),
    [scoped],
  );

  const standMap = useMemo(() => {
    const map = new Map<string, StandingsGroup>();
    for (const g of standingsQ.data?.groups ?? []) map.set(g.group_label, g);
    return map;
  }, [standingsQ.data]);
  const groupLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const m of scoped) {
      if (
        m.stage !== "knockout" &&
        m.group_label &&
        standMap.has(m.group_label)
      ) {
        labels.add(m.group_label);
      }
    }
    return [...labels].sort();
  }, [scoped, standMap]);

  // How many per group advance: read it off the bracket's own group_position
  // pointers (invariant 9), so the qualification line the table draws is the
  // one the fixture will actually honour.
  const qualify = useMemo(() => {
    let top = 0;
    for (const m of knockout) {
      for (const src of [m.home_source, m.away_source]) {
        if (
          src?.type === "group_position" &&
          typeof src.position === "number"
        ) {
          top = Math.max(top, src.position);
        }
      }
    }
    return top;
  }, [knockout]);

  const header = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="page-title">{t("Standings & bracket")}</h2>
      {competitions.length > 0 ? (
        <span className="font-tabular text-xs text-muted-foreground">
          {competitions.length} {t("competitions")}
        </span>
      ) : null}
    </div>
  );

  if (matchesQ.isLoading) {
    return (
      <div className="flex w-full flex-col gap-3">
        {header}
        <div
          aria-busy="true"
          className="h-48 animate-pulse rounded-xl border border-border bg-card"
        />
      </div>
    );
  }
  if (matchesQ.isError) {
    return (
      <div className="flex w-full flex-col gap-3">
        {header}
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load standings.")}
        </p>
      </div>
    );
  }
  if (matches.length === 0) {
    return (
      <div className="flex w-full flex-col gap-3">
        {header}
        <section className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
          <p className="text-sm font-medium">{t("No fixtures yet")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("Shown once fixtures are generated.")}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {header}

      {/* Mirrors the PUBLIC standings sheet (owner 2026-07-14: "use that page
          as the reference"): sport bookmarks sitting on one card, category
          bookmarks inside it, then every table and the bracket in that same
          card — instead of loose chip rows above four floating panels. */}
      <div data-testid="standings-board" className="flex flex-col">
        {sports.length > 1 ? (
          <div
            role="tablist"
            aria-label={t("Sports")}
            className="flex flex-wrap items-end gap-1 px-2"
          >
            {sports.map((sp) => (
              <Bookmark
                key={sp}
                testid={`sport-chip-${sp}`}
                active={sp === activeSport}
                onClick={() => {
                  setSport(sp);
                  setLeaf(null);
                }}
                label={sp}
                count={competitions.filter((c) => c.sport === sp).length}
              />
            ))}
          </div>
        ) : null}

        <div
          className={cn(
            "flex flex-col gap-5 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5",
            sports.length > 1 && "rounded-tl-none",
          )}
        >
          {inSport.length > 1 ? (
            <div
              role="tablist"
              aria-label={t("Categories")}
              className="flex flex-wrap items-center gap-1.5 border-b border-border pb-3"
            >
              {inSport.map((c) => (
                <Bookmark
                  key={c.key || "_all"}
                  testid={`comp-chip-${c.key || "all"}`}
                  active={c.key === selected}
                  onClick={() => setLeaf(c.key)}
                  label={c.rest || c.sport}
                />
              ))}
            </div>
          ) : null}

          {groupLabels.length === 0 && knockout.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("No standings for this competition yet.")}
            </p>
          ) : null}

          {groupLabels.length > 0 ? (
            <section className="flex flex-col overflow-hidden rounded-xl border border-border">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/60 px-4 py-2.5">
                <h3 className="text-sm font-semibold">
                  {t("Group standings")}
                </h3>
                <span className="font-tabular text-xs text-muted-foreground">
                  {groupLabels.length}{" "}
                  {groupLabels.length === 1 ? t("group") : t("groups")}
                </span>
                {qualify > 0 ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t("Top")} <span className="font-tabular">{qualify}</span>{" "}
                    {t("of each group advances")}
                  </span>
                ) : null}
              </div>
              <div className="grid grid-cols-1 items-start gap-x-6 gap-y-5 p-4 xl:grid-cols-2">
                {groupLabels.map((lbl) => (
                  <GroupCard
                    key={lbl}
                    group={standMap.get(lbl)!}
                    family={family}
                    qualify={qualify}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {knockout.length > 0 ? (
            <section className="flex flex-col overflow-hidden rounded-xl border border-border">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/60 px-4 py-2.5">
                <h3 className="text-sm font-semibold">{t("Knockout")}</h3>
                <span className="font-tabular text-xs text-muted-foreground">
                  {knockout.length}{" "}
                  {knockout.length === 1 ? t("match") : t("matches")}
                </span>
              </div>
              <div className="p-4">
                <BracketView
                  matches={knockout}
                  timeZone={tournamentQ.data?.time_zone}
                />
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
