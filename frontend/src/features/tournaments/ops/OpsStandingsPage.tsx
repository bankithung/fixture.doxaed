import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { liveApi } from "@/api/live";
import {
  tournamentsApi,
  type StandingsGroup,
} from "@/api/tournaments";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useEventStream } from "@/lib/useEventStream";
import { BracketView } from "@/features/tournaments/BracketView";

/** Humanize a competition leaf key ("sepak_takraw.u14" → "Sepak Takraw · U14"). */
function humanizeLeaf(key: string): string {
  if (!key) return t("Tournament");
  return key
    .split(".")
    .map((seg) =>
      seg.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    )
    .join(" · ");
}

/** One group's standings table from the server (honours the tournament's
 * points + tiebreakers — `compute_standings`). GF/GA/GD fold away on mobile. */
function GroupCard({ group }: { group: StandingsGroup }): React.ReactElement {
  const wideCols: [string, (r: StandingsGroup["rows"][number]) => number][] = [
    ["GF", (r) => r.GF],
    ["GA", (r) => r.GA],
    ["GD", (r) => r.GD],
  ];
  return (
    <section
      data-testid={`ops-group-${group.group_label}`}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
    >
      <h3 className="flex h-9 items-center border-b border-border px-4 text-[13px] font-semibold tracking-tight">
        {group.group_label}
      </h3>
      <table className="w-full text-sm font-tabular">
        <thead className="border-b border-border">
          <tr className="text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
            <th className="py-2 pl-4 pr-2 text-left font-medium">
              {t("Team")}
            </th>
            {["P", "W", "D", "L"].map((h) => (
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
          {group.rows.map((r, i) => (
            <tr
              key={r.team_id}
              data-testid={`ops-standing-${r.team_id}`}
              className="border-t border-border/60"
            >
              <td className="py-1.5 pl-4 pr-2">
                <div className="flex items-center gap-2">
                  <span className="w-4 text-right text-xs text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.name}</span>
                    {r.school ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {r.school}
                      </span>
                    ) : null}
                  </span>
                </div>
              </td>
              {[r.P, r.W, r.D, r.L].map((v, j) => (
                <td key={j} className="px-1.5 py-1.5 text-right">
                  {v}
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
          ))}
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
    return [...seen]
      .sort()
      .map((key) => ({ key, label: humanizeLeaf(key) }));
  }, [matches]);

  const selected = leaf ?? competitions[0]?.key ?? "";
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
      if (m.stage !== "knockout" && m.group_label && standMap.has(m.group_label)) {
        labels.add(m.group_label);
      }
    }
    return [...labels].sort();
  }, [scoped, standMap]);

  const header = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="text-xl font-semibold tracking-tight">
        {t("Standings & bracket")}
      </h2>
      {competitions.length > 0 ? (
        <span className="font-tabular text-xs text-muted-foreground">
          {competitions.length} {t("competitions")}
        </span>
      ) : null}
    </div>
  );

  if (matchesQ.isLoading) {
    return (
      <div className="flex w-full flex-col gap-5">
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
      <div className="flex w-full flex-col gap-5">
        {header}
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load standings.")}
        </p>
      </div>
    );
  }
  if (matches.length === 0) {
    return (
      <div className="flex w-full flex-col gap-5">
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
    <div className="flex w-full flex-col gap-5">
      {header}

      {competitions.length > 1 ? (
        <div
          role="group"
          aria-label={t("Competition")}
          className="inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5"
        >
          {competitions.map((c) => {
            const active = c.key === selected;
            return (
              <button
                key={c.key || "_all"}
                type="button"
                data-testid={`comp-chip-${c.key || "all"}`}
                aria-pressed={active}
                onClick={() => setLeaf(c.key)}
                className={cn(
                  "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {groupLabels.length === 0 && knockout.length === 0 ? (
        <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {t("No standings for this competition yet.")}
        </p>
      ) : (
        <>
          {groupLabels.length > 0 ? (
            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
              {groupLabels.map((lbl) => (
                <GroupCard key={lbl} group={standMap.get(lbl)!} />
              ))}
            </div>
          ) : null}

          {knockout.length > 0 ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {t("Knockout")}
              </h3>
              <BracketView matches={knockout} timeZone={tournamentQ.data?.time_zone} />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
