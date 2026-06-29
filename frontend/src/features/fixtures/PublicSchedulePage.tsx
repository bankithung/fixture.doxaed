import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Printer, Search, Trophy, X } from "lucide-react";
import { liveApi } from "@/api/live";
import {
  tournamentsApi,
  type PublicScheduleMatch,
  type StandingRow,
  type StandingsGroup,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { useEventStream } from "@/lib/useEventStream";
import { PublicViewerTabs } from "@/features/live/PublicViewerHeader";

const LIVE_STATUSES = new Set(["live", "half_time", "extra_time", "penalties"]);
const FINAL_STATUSES = new Set(["completed", "walkover"]);

/** Competition labels arrive joined by separators ("Sepak Takraw — U-14 —
 * Boys"); a raw dashed string is the #1 design tell, so we split into segments
 * and chip them. Internal hyphens with no surrounding spaces ("U-14") survive
 * the split and are tidied to "U14" at render. */
const LABEL_SEP = /\s+[—–·|/-]+\s+/;

function splitLabel(label: string): string[] {
  return label
    .split(LABEL_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The sport segment (first label part), used to group + label competitions. */
function sportOf(m: Pick<PublicScheduleMatch, "leaf_label" | "sport">): string {
  const parts = splitLabel(m.leaf_label);
  if (parts.length) return parts[0];
  if (m.sport) {
    return m.sport.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return t("Other");
}

/** "Sepak Takraw — U-14 — Boys — Group A" minus the competition prefix →
 * "Group A" (falls back to the raw group label when it isn't a prefix). */
function shortGroup(groupLabel: string, leafLabel: string): string {
  if (!groupLabel) return "";
  if (leafLabel && groupLabel.startsWith(leafLabel)) {
    const rest = groupLabel.slice(leafLabel.length).replace(LABEL_SEP, "").trim();
    return rest || groupLabel;
  }
  return groupLabel;
}

function statusMeta(status: string): { label: string; cls: string; live: boolean } {
  if (LIVE_STATUSES.has(status)) {
    return {
      label: status === "half_time" ? "Half time" : "Live",
      cls: "bg-primary/15 text-primary",
      live: true,
    };
  }
  if (FINAL_STATUSES.has(status)) {
    return {
      label: status === "walkover" ? "Walkover" : "Full time",
      cls: "bg-accent text-accent-foreground",
      live: false,
    };
  }
  if (status === "postponed" || status === "abandoned") {
    return {
      label: status,
      cls: "bg-warning-muted text-warning-foreground",
      live: false,
    };
  }
  return {
    label: status.replace(/_/g, " "),
    cls: "bg-secondary text-secondary-foreground",
    live: false,
  };
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Kick-off in the TOURNAMENT's wall clock (invariant 14 — the schedule of a
 * physical event reads in event-local time, matching the `day` grouping). */
function fmtKickoff(iso: string | null, timeZone: string): string {
  if (!iso) return t("TBD");
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

function teamHit(m: PublicScheduleMatch, q: string): boolean {
  if (!q) return true;
  const h = m.home?.name?.toLowerCase() ?? "";
  const a = m.away?.name?.toLowerCase() ?? "";
  return h.includes(q) || a.includes(q);
}

/** Competition label as clean chips: sport (accent) then age/gender/discipline
 * (muted), no separator glyphs. `omitSport` drops the leading sport chip when
 * the surrounding header already names it. */
function LabelChips({
  label,
  omitSport = false,
  className,
}: {
  label: string;
  omitSport?: boolean;
  className?: string;
}): React.ReactElement | null {
  let parts = splitLabel(label);
  if (omitSport) parts = parts.slice(1);
  if (parts.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {parts.map((p, i) => (
        <span
          key={`${p}-${i}`}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium leading-tight",
            !omitSport && i === 0
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {/* "U-14" → "U14": the internal hyphen is the last dash on the page. */}
          {/^U-\d/.test(p) ? p.replace("-", "") : p}
        </span>
      ))}
    </span>
  );
}

function StatusPill({ status }: { status: string }): React.ReactElement {
  const sm = statusMeta(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[0.6875rem] font-medium capitalize",
        sm.cls,
      )}
    >
      {sm.live ? (
        <span className="relative flex h-2 w-2" data-testid="live-pulse">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
      ) : null}
      {t(sm.label)}
    </span>
  );
}

function MatchCard({
  match,
  timeZone,
  labels = "full",
}: {
  match: PublicScheduleMatch;
  timeZone: string;
  /** full = time + leaf chips + group chip; slot = leaf chips + group chip but
   * NO time (a time-slot header already shows it); group = group chip only (the
   * section header names the competition); none = no labels (panel groups). */
  labels?: "full" | "slot" | "group" | "none";
}): React.ReactElement {
  const live = LIVE_STATUSES.has(match.status);
  const done = FINAL_STATUSES.has(match.status) || live;
  const sets = match.set_scores ?? [];
  const hasPens = match.home_pens != null && match.away_pens != null;
  const showTime = labels !== "slot";
  const showLeaf = labels === "full" || labels === "slot";
  const group =
    labels !== "none" ? shortGroup(match.group_label, match.leaf_label) : "";
  return (
    <li
      data-testid={`public-match-${match.id}`}
      className={cn(
        "flex flex-col gap-1.5 px-4 py-3",
        live && "border-l-2 border-primary",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {showTime ? (
          <span className="font-tabular font-semibold text-foreground">
            {fmtKickoff(match.scheduled_at, timeZone)}
          </span>
        ) : null}
        {match.venue ? (
          <span>
            {showTime ? "· " : ""}
            {match.venue}
          </span>
        ) : null}
        {showLeaf ? <LabelChips label={match.leaf_label} /> : null}
        {group ? (
          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[0.6875rem] font-medium text-secondary-foreground">
            {group}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {live && match.current_period ? (
            <span
              data-testid={`period-${match.id}`}
              className="rounded-md bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium capitalize text-primary"
            >
              {t(match.current_period.replace(/_/g, " "))}
            </span>
          ) : null}
          <StatusPill status={match.status} />
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
        <span className="truncate text-right font-medium">
          {match.home?.name ?? t("TBD")}
        </span>
        <span
          className={cn(
            "px-1 text-center font-tabular",
            done ? "font-semibold" : "text-xs text-muted-foreground",
          )}
        >
          {/* ASCII hyphen, not en/em dash: a scoreboard separator, not a label. */}
          {done
            ? `${match.home_score ?? 0} - ${match.away_score ?? 0}`
            : t("vs")}
        </span>
        <span className="truncate font-medium">
          {match.away?.name ?? t("TBD")}
        </span>
      </div>
      {done && (sets.length > 0 || hasPens) ? (
        <p
          data-testid={`points-${match.id}`}
          className="text-center font-tabular text-xs text-muted-foreground"
        >
          {sets.map(([h, a]) => `${h}-${a}`).join(" · ")}
          {sets.length > 0 && hasPens ? " · " : ""}
          {hasPens
            ? `(${match.home_pens}-${match.away_pens} ${t("pens")})`
            : ""}
        </p>
      ) : null}
    </li>
  );
}

/** Compact FIFA-style group table (P W D L +/- Pts) — qualifying rows get a
 * 2px accent left rule (not a fill, not a dot). */
function GroupTable({ rows }: { rows: StandingRow[] }): React.ReactElement {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[0.625rem] uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-1.5 font-medium">{t("Team")}</th>
            {["P", "W", "D", "L", "+/-", "Pts"].map((h) => (
              <th key={h} className="px-2 py-1.5 text-right font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr
              key={r.team_id}
              data-testid={`group-standing-${r.team_id}`}
              className={cn(
                "border-t border-border",
                idx < 2 && "border-l-2 border-primary",
              )}
            >
              <td className="px-4 py-1.5 font-medium">
                <span className="mr-1.5 font-tabular text-xs text-muted-foreground">
                  {idx + 1}
                </span>
                {r.name}
              </td>
              {[r.P, r.W, r.D, r.L, r.GD, r.Pts].map((v, i) => (
                <td
                  key={i}
                  className={cn(
                    "px-2 py-1.5 text-right font-tabular",
                    i === 5
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {i === 4 && typeof v === "number" && v > 0 ? `+${v}` : v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Group = {
  key: string;
  label: string;
  matches: PublicScheduleMatch[];
  standing?: StandingsGroup;
};
type Competition = {
  key: string;
  label: string;
  sport: string;
  teamCount: number;
  liveCount: number;
  groups: Group[];
  matches: PublicScheduleMatch[];
};

function buildCompetitions(
  matches: PublicScheduleMatch[],
  standingsGroups: StandingsGroup[] | undefined,
): Competition[] {
  const stMap = new Map<string, StandingsGroup>();
  for (const g of standingsGroups ?? []) {
    if (g.group_label) stMap.set(g.group_label, g);
  }
  const byLeaf = new Map<string, PublicScheduleMatch[]>();
  for (const m of matches) {
    const key = m.leaf_key || "_";
    if (!byLeaf.has(key)) byLeaf.set(key, []);
    byLeaf.get(key)!.push(m);
  }
  const comps: Competition[] = [];
  for (const [key, ms] of byLeaf) {
    const label = ms[0]?.leaf_label || t("Competition");
    const byGroup = new Map<string, PublicScheduleMatch[]>();
    for (const m of ms) {
      const gk = m.group_label || (m.stage === "knockout" ? "__ko" : "__other");
      if (!byGroup.has(gk)) byGroup.set(gk, []);
      byGroup.get(gk)!.push(m);
    }
    const groups: Group[] = [...byGroup.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([gk, gms]) => ({
        key: gk,
        label:
          gk === "__ko"
            ? t("Knockout")
            : gk === "__other"
              ? t("Fixtures")
              : shortGroup(gk, label) || gk,
        matches: gms,
        standing: gk.startsWith("__") ? undefined : stMap.get(gk),
      }));
    const teams = new Set<string>();
    let live = 0;
    for (const m of ms) {
      if (m.home) teams.add(m.home.id);
      if (m.away) teams.add(m.away.id);
      if (LIVE_STATUSES.has(m.status)) live++;
    }
    comps.push({
      key,
      label,
      sport: ms[0] ? sportOf(ms[0]) : "",
      teamCount: teams.size,
      liveCount: live,
      groups,
      matches: ms,
    });
  }
  return comps.sort((a, b) => a.label.localeCompare(b.label));
}

function LivePulse(): React.ReactElement {
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
    </span>
  );
}

/** The one earned card: live matches, lifted out of position so they're never
 * buried, and pinned regardless of which competition/day is selected. */
function LiveBand({
  matches,
  timeZone,
}: {
  matches: PublicScheduleMatch[];
  timeZone: string;
}): React.ReactElement | null {
  if (matches.length === 0) return null;
  return (
    <section
      data-testid="live-band"
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <div className="mb-3 flex items-center gap-2">
        <LivePulse />
        <h2 className="text-sm font-semibold">{t("Now playing")}</h2>
        <span className="font-tabular text-xs text-muted-foreground">
          {matches.length}
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-visible sm:pb-0 xl:grid-cols-3">
        {matches.map((m) => (
          <div
            key={m.id}
            data-testid={`live-tile-${m.id}`}
            className="min-w-[15rem] shrink-0 border-l-2 border-primary pl-3 sm:min-w-0"
          >
            <LabelChips label={m.leaf_label} className="text-[0.625rem]" />
            <div className="mt-1.5 flex flex-col gap-0.5">
              {[
                [m.home?.name, m.home_score],
                [m.away?.name, m.away_score],
              ].map(([name, score], i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_auto] items-center gap-2 text-sm"
                >
                  <span className="truncate font-medium">
                    {(name as string) ?? t("TBD")}
                  </span>
                  <span className="font-tabular font-semibold">
                    {(score as number) ?? 0}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-1 flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
              <span className="font-tabular">
                {fmtKickoff(m.scheduled_at, timeZone)}
              </span>
              {m.venue ? <span>· {m.venue}</span> : null}
              {m.current_period ? (
                <span className="ml-auto capitalize text-primary">
                  {t(m.current_period.replace(/_/g, " "))}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Persistent competition map: sport headers + leaves, plus a pinned "Today".
 * Rail on desktop, horizontal pill scroller on mobile (one variant rendered). */
function CompetitionRail({
  sports,
  selected,
  onSelect,
  todayLive,
  variant,
}: {
  sports: { sport: string; comps: Competition[] }[];
  selected: string;
  onSelect: (key: string) => void;
  todayLive: number;
  variant: "rail" | "pills";
}): React.ReactElement {
  const isRail = variant === "rail";
  const todayBtn = (
    <button
      type="button"
      data-testid="rail-today"
      aria-current={selected === "today"}
      onClick={() => onSelect("today")}
      className={cn(
        isRail
          ? "flex items-center gap-2 border-l-2 px-4 py-2.5 text-left text-sm"
          : "flex shrink-0 snap-start items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm",
        selected === "today"
          ? isRail
            ? "border-primary bg-primary/10 font-medium text-primary"
            : "border-primary bg-primary/10 font-medium text-primary"
          : isRail
            ? "border-transparent text-foreground hover:bg-muted"
            : "border-border text-foreground hover:bg-muted",
      )}
    >
      <CalendarDays aria-hidden className="h-4 w-4 shrink-0" />
      <span>{t("Today")}</span>
      {todayLive > 0 ? (
        <span className="ml-auto flex items-center gap-1">
          <LivePulse />
        </span>
      ) : null}
    </button>
  );

  const compBtn = (c: Competition) => (
    <button
      key={c.key}
      type="button"
      data-testid={`rail-comp-${c.key}`}
      aria-current={selected === c.key}
      onClick={() => onSelect(c.key)}
      className={cn(
        isRail
          ? "flex w-full items-center gap-2 border-l-2 px-4 py-2.5 text-left"
          : "flex shrink-0 snap-start items-center gap-1.5 rounded-md border px-3 py-1.5",
        selected === c.key
          ? "border-primary bg-primary/10 text-primary"
          : isRail
            ? "border-transparent hover:bg-muted"
            : "border-border hover:bg-muted",
      )}
    >
      <LabelChips label={c.label} omitSport className="min-w-0" />
      {isRail ? (
        <span className="ml-auto flex items-center gap-1.5 font-tabular text-xs text-muted-foreground">
          {c.liveCount > 0 ? <LivePulse /> : null}
          {c.matches.length}
        </span>
      ) : c.liveCount > 0 ? (
        <LivePulse />
      ) : null}
    </button>
  );

  if (!isRail) {
    return (
      <nav
        aria-label={t("Competitions")}
        className="-mx-4 flex gap-2 overflow-x-auto px-4 py-2 [scrollbar-width:none] snap-x snap-mandatory [&::-webkit-scrollbar]:hidden lg:hidden"
      >
        {todayBtn}
        {sports.map((s) => (
          <div key={s.sport} className="flex shrink-0 items-center gap-2">
            <span className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
              {s.sport}
            </span>
            {s.comps.map(compBtn)}
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav
      aria-label={t("Competitions")}
      className="sticky top-0 hidden max-h-screen w-72 shrink-0 flex-col overflow-y-auto border-r border-border py-2 lg:flex"
    >
      {todayBtn}
      {sports.map((s) => (
        <div key={s.sport} className="mt-2 flex flex-col">
          <span className="px-4 pb-1 pt-2 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
            {s.sport}
          </span>
          {s.comps.map(compBtn)}
        </div>
      ))}
    </nav>
  );
}

/** The standings hero: every group of one competition as a table + its
 * fixtures, un-collapsed. The panel is one surface; groups are hairline units. */
function CompetitionStandings({
  comp,
  timeZone,
  q,
}: {
  comp: Competition;
  timeZone: string;
  q: string;
}): React.ReactElement {
  const groups = comp.groups
    .map((g) => ({ ...g, shown: q ? g.matches.filter((m) => teamHit(m, q)) : g.matches }))
    .filter((g) => g.shown.length > 0 || (g.standing?.rows.length ?? 0) > 0);
  if (groups.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        {t("No matches match these filters.")}
      </p>
    );
  }
  return (
    <div
      data-testid={`public-competition-${comp.key}`}
      className="grid grid-cols-1 gap-x-8 gap-y-6 xl:grid-cols-2"
    >
      {groups.map((g) => (
        <div
          key={g.key}
          data-testid={`public-group-${comp.key}-${g.key}`}
          className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
        >
          <h3 className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm font-semibold">
            {g.label}
            <span className="font-tabular text-xs font-normal text-muted-foreground">
              {g.shown.length}
            </span>
          </h3>
          {g.standing && g.standing.rows.length > 0 ? (
            <GroupTable rows={g.standing.rows} />
          ) : null}
          <ul className="divide-y divide-border border-t border-border">
            {g.shown.map((m) => (
              <MatchCard key={m.id} match={m} timeZone={timeZone} labels="none" />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function stageLabel(m: PublicScheduleMatch): string {
  if (m.group_label) return shortGroup(m.group_label, m.leaf_label);
  if (m.stage === "knockout") return `${t("R")}${m.round_no}`;
  return m.stage;
}

/**
 * Print-only order-of-play for ONE chosen day (increment L): grouped by venue
 * then kick-off time, one page per venue (`break-after-page`), plain B&W tables.
 */
function PrintSheet({
  day,
  matches,
  tournamentName,
  timeZone,
}: {
  day: string;
  matches: PublicScheduleMatch[];
  tournamentName: string;
  timeZone: string;
}): React.ReactElement | null {
  const venues = useMemo(() => {
    const by = new Map<string, PublicScheduleMatch[]>();
    const ordered = [...matches].sort((a, b) =>
      (a.scheduled_at ?? "") < (b.scheduled_at ?? "") ? -1 : 1,
    );
    for (const m of ordered) {
      const v = m.venue || t("Unassigned venue");
      if (!by.has(v)) by.set(v, []);
      by.get(v)!.push(m);
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [matches]);

  if (venues.length === 0) return null;
  return (
    <div data-testid="print-sheet" className="hidden print:block">
      {venues.map(([venue, ms]) => (
        <section
          key={venue}
          data-testid={`print-venue-${venue}`}
          className="break-after-page pb-6 last:break-after-auto"
        >
          <h1 className="text-lg font-semibold">
            {tournamentName} · {t("Order of play")}
          </h1>
          <p className="pb-3 text-sm">
            {fmtDay(day)} · {venue}
          </p>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {[t("Time"), t("Match"), t("Competition"), t("Stage")].map(
                  (h) => (
                    <th
                      key={h}
                      className="border-b-2 border-border py-1 pr-3 text-left font-semibold"
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {ms.map((m) => (
                <tr key={m.id}>
                  <td className="border-b border-border py-1 pr-3 font-tabular">
                    {fmtKickoff(m.scheduled_at, timeZone)}
                  </td>
                  <td className="border-b border-border py-1 pr-3">
                    {m.home?.name ?? t("TBD")} {t("vs")}{" "}
                    {m.away?.name ?? t("TBD")}
                  </td>
                  <td className="border-b border-border py-1 pr-3">
                    {splitLabel(m.leaf_label).join(" / ")}
                  </td>
                  <td className="border-b border-border py-1">
                    {stageLabel(m)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

/** Order-of-play for one competition across days, with print. */
function CompetitionByDay({
  comp,
  tournamentName,
  timeZone,
  q,
  printDay,
  setPrintDay,
}: {
  comp: Competition;
  tournamentName: string;
  timeZone: string;
  q: string;
  printDay: string;
  setPrintDay: (d: string) => void;
}): React.ReactElement {
  const matches = q ? comp.matches.filter((m) => teamHit(m, q)) : comp.matches;
  const { days, unscheduled } = useMemo(() => {
    const byDay = new Map<string, PublicScheduleMatch[]>();
    const loose: PublicScheduleMatch[] = [];
    for (const m of matches) {
      if (!m.day) {
        loose.push(m);
        continue;
      }
      if (!byDay.has(m.day)) byDay.set(m.day, []);
      byDay.get(m.day)!.push(m);
    }
    return {
      days: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      unscheduled: loose,
    };
  }, [matches]);

  const effectivePrintDay = printDay || days[0]?.[0] || "";
  const printMatches = days.find(([d]) => d === effectivePrintDay)?.[1] ?? [];

  return (
    <>
      {days.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <span className="text-xs text-muted-foreground">
            {t("Print a day's order of play")}
          </span>
          <Select
            size="sm"
            className="w-48"
            aria-label={t("Day to print")}
            value={effectivePrintDay}
            onChange={setPrintDay}
            options={days.map(([d]) => ({ value: d, label: fmtDay(d) }))}
          />
          <Button
            size="sm"
            variant="outline"
            data-testid="print-button"
            onClick={() => window.print()}
          >
            <Printer aria-hidden className="h-3.5 w-3.5" />
            {t("Print")}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-4 print:hidden">
        {days.map(([day, ms]) => (
          <section
            key={day}
            data-testid={`public-day-${day}`}
            className="overflow-hidden rounded-lg border border-border bg-card"
          >
            <h3 className="border-b border-border bg-muted/40 px-4 py-2 text-sm font-semibold">
              {fmtDay(day)}
              <span className="ml-2 font-tabular text-xs font-normal text-muted-foreground">
                {ms.length} {ms.length === 1 ? t("match") : t("matches")}
              </span>
            </h3>
            <ul className="divide-y divide-border">
              {ms.map((m) => (
                <MatchCard key={m.id} match={m} timeZone={timeZone} labels="group" />
              ))}
            </ul>
          </section>
        ))}

        {unscheduled.length ? (
          <section
            data-testid="public-unscheduled"
            className="overflow-hidden rounded-lg border border-border bg-card"
          >
            <h3 className="border-b border-border bg-muted/40 px-4 py-2 text-sm font-semibold">
              {t("Time to be announced")}
            </h3>
            <ul className="divide-y divide-border">
              {unscheduled.map((m) => (
                <MatchCard key={m.id} match={m} timeZone={timeZone} labels="group" />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {effectivePrintDay ? (
        <PrintSheet
          day={effectivePrintDay}
          matches={printMatches}
          tournamentName={tournamentName}
          timeZone={timeZone}
        />
      ) : null}
    </>
  );
}

/** Cross-competition ORDER OF PLAY for ONE day (the default landing): every
 * match that day in a single time-ordered list (not grouped by sport), each
 * row carrying its own competition chips so you still know the game. Optional
 * thin time-slot headers break the run when the kick-off changes. */
function TodayOverview({
  day,
  matches,
  timeZone,
}: {
  day: string;
  matches: PublicScheduleMatch[];
  timeZone: string;
}): React.ReactElement {
  // Group by kick-off time so the slot reads once, in chronological order.
  const slots = useMemo(() => {
    const ordered = [...matches].sort((a, b) =>
      (a.scheduled_at ?? "~") < (b.scheduled_at ?? "~") ? -1 : 1,
    );
    const by = new Map<string, PublicScheduleMatch[]>();
    for (const m of ordered) {
      const time = m.scheduled_at ? fmtKickoff(m.scheduled_at, timeZone) : t("TBD");
      if (!by.has(time)) by.set(time, []);
      by.get(time)!.push(m);
    }
    return [...by.entries()];
  }, [matches, timeZone]);

  if (slots.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
        {t("No matches on this day.")}
      </p>
    );
  }

  return (
    <div
      data-testid={`public-day-${day}`}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      {slots.map(([time, ms]) => (
        <div key={time} data-testid={`slot-${time}`}>
          <h3 className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5 font-tabular text-xs font-semibold text-muted-foreground">
            {time}
            <span className="font-normal">
              {ms.length} {ms.length === 1 ? t("match") : t("matches")}
            </span>
          </h3>
          <ul className="divide-y divide-border">
            {ms.map((m) => (
              <MatchCard key={m.id} match={m} timeZone={timeZone} labels="slot" />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Public, login-free tournament MATCH CENTER (trust layer, increment H,
 * redesigned to the "competition spine"): a persistent sport-grouped
 * competition rail (plus a pinned Today overview) drives a standings-hero
 * panel; live matches lift into a single "Now playing" band. Labels render as
 * clean chips (zero em/en dashes). Live over the public SSE tick stream
 * (control room spec §3.3) with a 60 s poll fallback, full-width, in its own
 * minimal chrome (no app shell).
 */
export function PublicSchedulePage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const qc = useQueryClient();
  const { up } = useBreakpoint();
  const wideRail = up("lg");

  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTick = useCallback(() => {
    if (tickTimer.current) return;
    tickTimer.current = setTimeout(() => {
      tickTimer.current = null;
      qc.invalidateQueries({ queryKey: ["public-schedule", slug, id] });
      qc.invalidateQueries({ queryKey: ["public-standings", slug, id] });
    }, 500);
  }, [qc, slug, id]);
  useEffect(
    () => () => {
      if (tickTimer.current) clearTimeout(tickTimer.current);
    },
    [],
  );
  const { connected } = useEventStream(
    slug && id ? liveApi.streamUrl(slug, id) : null,
    onTick,
  );

  const query = useQuery({
    queryKey: ["public-schedule", slug, id],
    queryFn: () => tournamentsApi.publicSchedule(slug, id),
    refetchInterval: connected ? false : 60_000,
  });
  const standingsQ = useQuery({
    queryKey: ["public-standings", slug, id],
    queryFn: () => tournamentsApi.publicStandings(slug, id),
    enabled: query.data !== undefined,
    retry: false,
    refetchInterval: connected ? false : 60_000,
  });

  const tz = query.data?.tournament.time_zone ?? "UTC";
  const allMatches = useMemo(() => query.data?.matches ?? [], [query.data]);

  const [selected, setSelected] = useState<string>("today");
  const [panelMode, setPanelMode] = useState<"standings" | "day">("standings");
  const [teamQ, setTeamQ] = useState("");
  const [overviewDay, setOverviewDay] = useState("");
  const [printDay, setPrintDay] = useState("");

  const competitions = useMemo(
    () => buildCompetitions(allMatches, standingsQ.data?.groups),
    [allMatches, standingsQ.data],
  );
  const railSports = useMemo(() => {
    const m = new Map<string, Competition[]>();
    for (const c of competitions) {
      if (!m.has(c.sport)) m.set(c.sport, []);
      m.get(c.sport)!.push(c);
    }
    return [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([sport, comps]) => ({ sport, comps }));
  }, [competitions]);

  const liveMatches = useMemo(
    () => allMatches.filter((m) => LIVE_STATUSES.has(m.status)),
    [allMatches],
  );

  const allDays = useMemo(() => {
    const s = new Set<string>();
    for (const m of allMatches) if (m.day) s.add(m.day);
    return [...s].sort();
  }, [allMatches]);

  const smartDefaultDay = useMemo(() => {
    if (allDays.length === 0) return "";
    let today = "";
    try {
      today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    } catch {
      today = "";
    }
    return allDays.find((d) => d >= today) ?? allDays[0];
  }, [allDays, tz]);

  const effectiveOverviewDay = overviewDay || smartDefaultDay;
  const isPreTournament = useMemo(() => {
    try {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
      return Boolean(effectiveOverviewDay) && effectiveOverviewDay > today;
    } catch {
      return false;
    }
  }, [effectiveOverviewDay, tz]);

  const selectedComp =
    selected === "today" ? null : competitions.find((c) => c.key === selected);

  const q = teamQ.trim().toLowerCase();
  // Scope of the active view (for the count chip).
  const scopeMatches =
    selected === "today"
      ? allMatches.filter((m) => m.day === effectiveOverviewDay)
      : (selectedComp?.matches ?? []);
  const visibleCount = q
    ? scopeMatches.filter((m) => teamHit(m, q)).length
    : scopeMatches.length;

  const overviewMatches = scopeMatches.filter((m) => teamHit(m, q));

  const segBtn = (
    key: "standings" | "day",
    label: string,
    testid: string,
  ) => (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={panelMode === key}
      onClick={() => setPanelMode(key)}
      className={cn(
        "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        panelMode === key
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 print:hidden sm:px-6">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandLogo className="h-7 w-7 rounded-lg" />
          {t("Fixture")}
        </Link>
        <span className="ml-2 truncate text-sm text-muted-foreground">
          {query.data?.tournament.name ?? t("Schedule")}
        </span>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <div className="border-b border-border bg-card px-4 print:hidden sm:px-6">
        <PublicViewerTabs slug={slug} id={id} active="schedule" />
      </div>

      {query.isLoading ? (
        <main className="flex w-full flex-1 flex-col gap-3 px-4 py-6 sm:px-6" aria-busy="true">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-36 animate-pulse rounded-xl border border-border bg-card"
            />
          ))}
        </main>
      ) : query.isError || !query.data ? (
        <main className="flex w-full flex-1 px-4 py-6 sm:px-6">
          <p
            role="alert"
            className="w-full rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground"
          >
            {t("This schedule is not available.")}
          </p>
        </main>
      ) : (
        <main className="flex w-full flex-1 flex-col print:p-0">
          {/* Title + connection state */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-4 print:hidden sm:px-6 lg:px-8">
            <h1 className="text-xl font-semibold tracking-tight">
              {query.data.tournament.name}
            </h1>
            <span
              data-testid="stream-indicator"
              className="inline-flex items-center gap-1.5 font-tabular text-xs text-muted-foreground"
            >
              {allMatches.length} {t("matches")} ·{" "}
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
          </div>

          {allMatches.length === 0 ? (
            <div className="px-4 py-6 sm:px-6 lg:px-8">
              <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
                {t("No matches scheduled yet. Check back soon.")}
              </p>
            </div>
          ) : (
            <>
              {/* Mobile pill nav, pinned under the tabs */}
              {!wideRail ? (
                <div className="px-4 print:hidden sm:px-6">
                  <CompetitionRail
                    sports={railSports}
                    selected={selected}
                    onSelect={(k) => {
                      setSelected(k);
                      setPanelMode("standings");
                    }}
                    todayLive={liveMatches.length}
                    variant="pills"
                  />
                </div>
              ) : null}

              <div className="flex w-full flex-1 items-start">
                {wideRail ? (
                  <CompetitionRail
                    sports={railSports}
                    selected={selected}
                    onSelect={(k) => {
                      setSelected(k);
                      setPanelMode("standings");
                    }}
                    todayLive={liveMatches.length}
                    variant="rail"
                  />
                ) : null}

                {/* Panel */}
                <section className="flex min-w-0 flex-1 flex-col gap-4 px-4 py-4 print:p-0 sm:px-6 lg:px-8">
                  {/* Sub-bar: context title + controls */}
                  <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-b border-border bg-background/85 px-4 py-2.5 backdrop-blur print:hidden sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
                    {selected === "today" ? (
                      <span className="flex items-center gap-2 text-sm font-semibold">
                        <Trophy aria-hidden className="h-4 w-4 text-muted-foreground" />
                        {isPreTournament ? t("Next match day") : t("Today")}
                      </span>
                    ) : selectedComp ? (
                      <LabelChips label={selectedComp.label} />
                    ) : null}

                    {selected === "today" && allDays.length > 1 ? (
                      <Select
                        size="sm"
                        className="w-44"
                        aria-label={t("Day")}
                        value={effectiveOverviewDay}
                        onChange={setOverviewDay}
                        options={allDays.map((d) => ({ value: d, label: fmtDay(d) }))}
                      />
                    ) : null}

                    {selectedComp ? (
                      <div className="inline-flex rounded-lg bg-muted p-0.5">
                        {segBtn("standings", t("Standings"), "panel-standings")}
                        {segBtn("day", t("Order of play"), "view-day")}
                      </div>
                    ) : null}

                    <span
                      data-testid="filter-count"
                      className="ml-auto font-tabular text-xs text-muted-foreground"
                    >
                      {q
                        ? `${visibleCount} ${t("of")} ${scopeMatches.length}`
                        : `${scopeMatches.length}`}{" "}
                      {t("matches")}
                    </span>

                    {/* Search + clear: a full-width row on mobile, bounded on
                        desktop (w-full makes it wrap to its own line). */}
                    <div className="flex w-full items-center gap-2 sm:w-auto sm:flex-1 sm:basis-48 sm:min-w-[11rem] sm:max-w-xs">
                      <div className="relative flex-1">
                        <Search
                          aria-hidden
                          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                        />
                        <input
                          type="search"
                          data-testid="filter-team"
                          aria-label={t("Search teams")}
                          placeholder={t("Search teams…")}
                          value={teamQ}
                          onChange={(e) => setTeamQ(e.target.value)}
                          className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        />
                      </div>
                      {q ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          data-testid="filter-clear"
                          className="shrink-0"
                          onClick={() => setTeamQ("")}
                        >
                          <X aria-hidden className="h-3.5 w-3.5" />
                          {t("Clear")}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {/* The one earned card: live, pinned across any selection */}
                  <LiveBand matches={liveMatches} timeZone={tz} />

                  {/* Body */}
                  {selected === "today" ? (
                    isPreTournament && effectiveOverviewDay ? (
                      <>
                        <p className="text-sm text-muted-foreground">
                          {t("The tournament starts")} {fmtDay(effectiveOverviewDay)}.
                        </p>
                        <TodayOverview
                          day={effectiveOverviewDay}
                          matches={overviewMatches}
                          timeZone={tz}
                        />
                      </>
                    ) : (
                      <TodayOverview
                        day={effectiveOverviewDay}
                        matches={overviewMatches}
                        timeZone={tz}
                      />
                    )
                  ) : selectedComp ? (
                    panelMode === "standings" ? (
                      <CompetitionStandings comp={selectedComp} timeZone={tz} q={q} />
                    ) : (
                      <CompetitionByDay
                        comp={selectedComp}
                        tournamentName={query.data.tournament.name}
                        timeZone={tz}
                        q={q}
                        printDay={printDay}
                        setPrintDay={setPrintDay}
                      />
                    )
                  ) : null}
                </section>
              </div>
            </>
          )}
        </main>
      )}
    </div>
  );
}
