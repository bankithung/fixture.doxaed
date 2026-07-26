import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Search } from "lucide-react";
import { liveApi } from "@/api/live";
import { tournamentsApi, type ControlRoomMatch } from "@/api/tournaments";
import { useAuthStore } from "@/features/auth/authStore";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import type { ControlRoomPerms } from "@/features/controlroom/MatchActionsMenu";
import { MatchRow } from "@/features/controlroom/MatchRow";
import { RowActions } from "@/features/controlroom/MatchActionsMenu";
import { StatusPill } from "@/features/controlroom/MatchTile";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
import { liveSetView } from "@/lib/setDisplay";
import { useBreakpoint } from "@/lib/useBreakpoint";
import {
  FINAL,
  IN_PLAY,
  fmtDayLabel,
  fmtKickoff,
  leafLabelOf,
  statusBucket,
  tzDate,
} from "@/features/controlroom/format";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useEventStream } from "@/lib/useEventStream";

/**
 * Operations — "My tasks" (owner 2026-07-26). Every invited member's own work
 * list: the matches THEY are assigned to, and nothing else. Same shape as the
 * tournament-wide Matches board (stat strip that filters, day/competition/court
 * filters, status pills, grouping, the same dense rows) but scoped to the
 * viewer, so a scorer or referee never has to hunt their two matches out of a
 * hundred.
 *
 * "Assigned" means either seat: the scoring seat (`Match.scorer`) OR any
 * officiating slot (`MatchOfficial`, so referee / assistant / umpire /
 * linesman / commissioner all count). The board's own "My matches" toggle only
 * ever checked the scorer seat, which left officials with no view of their day.
 *
 * Read-only scoping is client-side on purpose: the enriched matches endpoint
 * already returns scorer + officials per row and every member may read it, so
 * this page needs no new API surface and rides the same SSE tick.
 */

type StatusFilter = "all" | "upcoming" | "live" | "done";
type RoleFilter = "all" | "scoring" | "officiating";
type GroupBy = "day" | "competition" | "venue" | "status";

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "upcoming", label: "Upcoming" },
  { key: "live", label: "Live" },
  { key: "done", label: "Done" },
];

const ROLE_FILTERS: { key: RoleFilter; label: string }[] = [
  { key: "all", label: "All my matches" },
  { key: "scoring", label: "I am scoring" },
  { key: "officiating", label: "I am officiating" },
];

const GROUP_LABEL: Record<GroupBy, string> = {
  day: "Day",
  competition: "Competition",
  venue: "Court",
  status: "Status",
};

const STATUS_GROUP_LABEL: Record<string, string> = {
  live: "Live now",
  upcoming: "Upcoming",
  done: "Completed",
  other: "Other",
};
const STATUS_GROUP_ORDER = ["live", "upcoming", "done", "other"];

/** My officiating roles on a match, humanized ("Referee", "Linesman"). */
function myRolesOn(m: ControlRoomMatch, userId: string | null): string[] {
  if (!userId) return [];
  return (m.officials ?? [])
    .filter((o) => o.user_id === userId)
    .map((o) => o.role.replace(/_/g, " "));
}

function StatCell({
  label,
  value,
  active = false,
  testid,
  onClick,
}: {
  label: string;
  value: number;
  active?: boolean;
  testid: string;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex min-w-0 flex-col justify-center gap-1 px-4 py-3 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        active && "bg-secondary/60",
      )}
    >
      <span className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "font-tabular text-2xl font-semibold leading-none",
          active && "text-primary",
        )}
      >
        {value}
      </span>
    </button>
  );
}


/** One assigned match as a stacked card — the phone form of the dense row.
 * `MatchRow` is a fixed-width desktop table row (it overflows a 390px card),
 * and this page is used courtside on a phone more than anywhere else, so the
 * narrow breakpoint gets its own layout per the house table→cards rule. */
function MyTaskCard({
  match,
  timeZone,
  tournamentId,
  siblings,
  perms,
  badges,
}: {
  match: ControlRoomMatch;
  timeZone: string;
  tournamentId: string;
  siblings: ControlRoomMatch[];
  perms: ControlRoomPerms;
  badges: React.ReactNode;
}): React.ReactElement {
  const done = FINAL.has(match.status);
  const live = IN_PLAY.has(match.status);
  const showScore = live || done;
  const sv = liveSetView(match);
  return (
    <div
      data-testid={`tile-${match.id}`}
      data-done={done ? "true" : undefined}
      className={cn(
        "flex flex-col gap-2 border-b border-border p-3 last:border-b-0",
        done && "bg-success-muted/50",
        live && "border-l-2 border-l-primary",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusPill match={match} />
        <span className="shrink-0 font-tabular text-xs text-foreground">
          {fmtKickoff(match.scheduled_at, timeZone)}
        </span>
        {match.venue ? (
          <span className="shrink-0 truncate rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
            {match.venue}
          </span>
        ) : (
          <span className="shrink-0 rounded bg-warning-muted px-1.5 py-0.5 text-[0.6875rem] font-medium text-warning">
            {t("No court")}
          </span>
        )}
        <span className="ml-auto shrink-0">
          <RowActions
            tournamentId={tournamentId}
            match={match}
            siblings={siblings}
            perms={perms}
          />
        </span>
      </div>

      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-sm">
          <span className="truncate font-medium">
            {match.home_team?.name ?? t("TBD")}
          </span>
          <span className="truncate font-medium">
            {match.away_team?.name ?? t("TBD")}
          </span>
        </div>
        {showScore ? (
          <span
            className="shrink-0 font-tabular text-base font-semibold tabular-nums"
            title={sv ? `${t("Sets")} ${sv.sets[0]}-${sv.sets[1]}` : undefined}
          >
            {sv
              ? `${sv.points[0]} - ${sv.points[1]}`
              : `${match.home_score ?? 0} - ${match.away_score ?? 0}`}
          </span>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <LeafLabel label={match.leaf_label} />
        {badges}
      </div>
    </div>
  );
}

export function MyTasksPage(): React.ReactElement {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const userId = user?.id ?? null;

  const [role, setRole] = useState<RoleFilter>("all");
  const [comp, setComp] = useState<string>("all");
  const [venue, setVenue] = useState<string>("all");
  const [day, setDay] = useState<string>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [groupBy, setGroupBy] = useState<GroupBy>("day");
  const [search, setSearch] = useState("");
  const { isMobile } = useBreakpoint();

  const tournamentQ = useQuery({
    queryKey: qk.tournament(id),
    queryFn: () => tournamentsApi.get(id),
  });
  const matchesQ = useQuery({
    queryKey: qk.matches(id),
    queryFn: () => tournamentsApi.matchesEnriched(id),
  });
  const stageQ = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
  });

  const canManage = stageQ.data?.can_manage ?? false;
  const modules = stageQ.data?.modules ?? [];
  const perms: ControlRoomPerms = {
    canManage,
    canSchedule: canManage || modules.includes("tournament.schedule_editor"),
    canScore: canManage || modules.includes("match.scoring_console"),
    userId,
  };

  const tz = tournamentQ.data?.time_zone ?? "UTC";
  const slug = tournamentQ.data?.slug || null;

  useEventStream(slug ? liveApi.streamUrl(slug, id) : null, () => {
    qc.invalidateQueries({ queryKey: qk.matches(id) });
  });

  const all = useMemo(() => matchesQ.data ?? [], [matchesQ.data]);

  // Mine = either seat. Computed once so every count below agrees with the list.
  const mine = useMemo(() => {
    if (!userId) return [];
    return all.filter(
      (m) =>
        m.scorer?.id === userId ||
        (m.officials ?? []).some((o) => o.user_id === userId),
    );
  }, [all, userId]);

  const competitions = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of mine) map.set(m.leaf_key, leafLabelOf(m));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [mine]);
  const venues = useMemo(() => {
    const set = new Set<string>();
    for (const m of mine) if (m.venue) set.add(m.venue);
    return [...set].sort();
  }, [mine]);
  const days = useMemo(() => {
    const set = new Set<string>();
    for (const m of mine) {
      const d = tzDate(m.scheduled_at, tz);
      if (d) set.add(d);
    }
    return [...set].sort();
  }, [mine, tz]);

  const counts = useMemo(() => {
    let live = 0;
    let upcoming = 0;
    let done = 0;
    let scoring = 0;
    for (const m of mine) {
      const b = statusBucket(m.status);
      if (b === "live") live += 1;
      if (b === "upcoming") upcoming += 1;
      if (b === "done") done += 1;
      if (m.scorer?.id === userId) scoring += 1;
    }
    return { total: mine.length, live, upcoming, done, scoring };
  }, [mine, userId]);

  // A stored filter whose option has gone (the assignment changed under us)
  // must fall back to "all", or the list would silently show nothing. Derived,
  // never written back — there is no correct-after-render flash.
  const effComp = competitions.some(([k]) => k === comp) ? comp : "all";
  const effVenue = venues.includes(venue) ? venue : "all";
  const effDay = days.includes(day) ? day : "all";

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return mine.filter((m) => {
      if (role === "scoring" && m.scorer?.id !== userId) return false;
      if (role === "officiating" && myRolesOn(m, userId).length === 0) return false;
      if (effComp !== "all" && m.leaf_key !== effComp) return false;
      if (effVenue !== "all" && m.venue !== effVenue) return false;
      if (effDay !== "all" && tzDate(m.scheduled_at, tz) !== effDay) return false;
      if (status !== "all" && statusBucket(m.status) !== status) return false;
      if (needle) {
        const hay = `${m.home_team?.name ?? ""} ${m.away_team?.name ?? ""} ${leafLabelOf(m)} ${m.venue}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [mine, role, effComp, effVenue, effDay, status, search, tz, userId]);

  const groups = useMemo(() => {
    const keyed = filtered.map((m) => {
      let key: string;
      let label: string;
      let sort: string;
      if (groupBy === "day") {
        key = tzDate(m.scheduled_at, tz);
        label = key ? fmtDayLabel(key) : t("Unscheduled");
        sort = key || "9999";
      } else if (groupBy === "competition") {
        key = m.leaf_key;
        label = leafLabelOf(m);
        sort = label;
      } else if (groupBy === "venue") {
        key = m.venue || "";
        label = m.venue || t("No court");
        sort = m.venue || "zzzz";
      } else {
        key = statusBucket(m.status);
        label = t(STATUS_GROUP_LABEL[key] ?? key);
        sort = String(STATUS_GROUP_ORDER.indexOf(key));
      }
      return { m, key, label, sort };
    });
    keyed.sort(
      (a, b) =>
        a.sort.localeCompare(b.sort) ||
        (a.m.scheduled_at ?? "").localeCompare(b.m.scheduled_at ?? ""),
    );
    const out: { key: string; label: string; matches: ControlRoomMatch[] }[] = [];
    for (const row of keyed) {
      const last = out[out.length - 1];
      if (last && last.key === row.key) last.matches.push(row.m);
      else out.push({ key: row.key, label: row.label, matches: [row.m] });
    }
    return out;
  }, [filtered, groupBy, tz]);

  if (matchesQ.isLoading || stageQ.isLoading) {
    return (
      <div className="flex w-full flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8" aria-busy="true">
        <div className="h-24 animate-pulse rounded-xl border border-border bg-card" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (matchesQ.isError) {
    return (
      <div className="flex w-full flex-col gap-3 px-4 py-6 sm:px-6 lg:px-8">
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load your matches.")}
        </p>
      </div>
    );
  }

  const pill =
    "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <ClipboardCheck aria-hidden="true" className="h-5 w-5 text-primary" />
            {t("My tasks")}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {counts.total > 0
              ? `${t("You are assigned to")} ${counts.total} ${counts.total === 1 ? t("match") : t("matches")}`
              : t("Matches you are assigned to appear here.")}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        {/* Stat strip — each cell filters the list to exactly what it counts. */}
        <div
          data-testid="mytasks-stats"
          className="grid grid-cols-2 divide-x divide-y divide-border border-b border-border sm:grid-cols-4 sm:divide-y-0"
        >
          <StatCell
            label={t("Assigned to me")}
            value={counts.total}
            testid="mytasks-stat-all"
            active={status === "all" && role === "all"}
            onClick={() => {
              setStatus("all");
              setRole("all");
            }}
          />
          <StatCell
            label={t("Live now")}
            value={counts.live}
            testid="mytasks-stat-live"
            active={status === "live"}
            onClick={() => setStatus(status === "live" ? "all" : "live")}
          />
          <StatCell
            label={t("Upcoming")}
            value={counts.upcoming}
            testid="mytasks-stat-upcoming"
            active={status === "upcoming"}
            onClick={() => setStatus(status === "upcoming" ? "all" : "upcoming")}
          />
          <StatCell
            label={t("Done")}
            value={counts.done}
            testid="mytasks-stat-done"
            active={status === "done"}
            onClick={() => setStatus(status === "done" ? "all" : "done")}
          />
        </div>

        {/* Filters. */}
        <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full min-w-0 sm:flex-1 sm:max-w-xs">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label={t("Search my matches")}
                data-testid="mytasks-search"
                placeholder={t("Search team, school or court…")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
            <Select
              aria-label={t("My role")}
              data-testid="mytasks-role"
              value={role}
              onChange={(v) => setRole(v as RoleFilter)}
              options={ROLE_FILTERS.map((r) => ({
                value: r.key,
                label: t(r.label),
              }))}
            />
            {days.length > 1 ? (
              <Select
                aria-label={t("Day")}
                data-testid="mytasks-day"
                value={effDay}
                onChange={setDay}
                options={[
                  { value: "all", label: t("All days") },
                  ...days.map((d) => ({ value: d, label: fmtDayLabel(d) })),
                ]}
              />
            ) : null}
            {competitions.length > 1 ? (
              <Select
                aria-label={t("Competition")}
                data-testid="mytasks-comp"
                value={effComp}
                onChange={setComp}
                options={[
                  { value: "all", label: t("All competitions") },
                  ...competitions.map(([k, label]) => ({ value: k, label })),
                ]}
              />
            ) : null}
            {venues.length > 1 ? (
              <Select
                aria-label={t("Court")}
                data-testid="mytasks-venue"
                value={effVenue}
                onChange={setVenue}
                options={[
                  { value: "all", label: t("All courts") },
                  ...venues.map((v) => ({ value: v, label: v })),
                ]}
              />
            ) : null}
            <Select
              aria-label={t("Group by")}
              data-testid="mytasks-group"
              value={groupBy}
              onChange={(v) => setGroupBy(v as GroupBy)}
              options={(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => ({
                value: g,
                label: `${t("Group by")} ${t(GROUP_LABEL[g]).toLowerCase()}`,
              }))}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  data-testid={`mytasks-status-${s.key}`}
                  aria-pressed={status === s.key}
                  onClick={() => setStatus(s.key)}
                  className={cn(
                    pill,
                    status === s.key
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(s.label)}
                </button>
              ))}
            </div>
            <span className="ml-auto font-tabular text-xs text-muted-foreground">
              {filtered.length === mine.length
                ? `${mine.length} ${t("matches")}`
                : `${filtered.length} ${t("of")} ${mine.length} ${t("matches")}`}
            </span>
          </div>
        </div>

        {/* The work list. */}
        {mine.length === 0 ? (
          <p
            data-testid="mytasks-empty"
            className="px-4 py-12 text-center text-sm text-muted-foreground"
          >
            {t("You have no assigned matches in this tournament yet. An organizer assigns scorers and officials — you will see your matches here as soon as they do.")}
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted-foreground">
            {t("None of your matches fit these filters.")}
          </p>
        ) : (
          <div data-testid="mytasks-list">
            {groups.map((g) => (
              <div key={g.key}>
                <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5">
                  <h2 className="text-[13px] font-semibold">{g.label}</h2>
                  <span className="font-tabular text-xs text-muted-foreground">
                    {g.matches.length}
                  </span>
                </div>
                {g.matches.map((m) => {
                  const roles = myRolesOn(m, userId);
                  const scoringSeat = m.scorer?.id === userId;
                  const badges = (
                    <span
                      data-testid={`myrole-${m.id}`}
                      className="flex shrink-0 items-center gap-1 text-[0.625rem]"
                    >
                      {scoringSeat ? (
                        <span className="rounded bg-primary/15 px-1.5 py-0.5 font-medium text-primary">
                          {t("Scoring")}
                        </span>
                      ) : null}
                      {roles.map((r) => (
                        <span
                          key={r}
                          className="rounded bg-info-muted px-1.5 py-0.5 font-medium capitalize text-info"
                        >
                          {r}
                        </span>
                      ))}
                    </span>
                  );
                  const siblings = all.filter((x) => x.leaf_key === m.leaf_key);
                  if (isMobile) {
                    return (
                      <MyTaskCard
                        key={m.id}
                        match={m}
                        timeZone={tz}
                        tournamentId={id}
                        siblings={siblings}
                        perms={perms}
                        badges={badges}
                      />
                    );
                  }
                  return (
                    <MatchRow
                      key={m.id}
                      match={m}
                      timeZone={tz}
                      tournamentId={id}
                      siblings={siblings}
                      perms={perms}
                      showCourt={groupBy !== "venue"}
                      badges={badges}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
