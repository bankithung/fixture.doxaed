import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardCheck,
  ListChecks,
  RotateCcw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { liveApi } from "@/api/live";
import { tournamentsApi, type ControlRoomMatch } from "@/api/tournaments";
import { useAuthStore } from "@/features/auth/authStore";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/Select";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { ControlRoomPerms } from "@/features/controlroom/MatchActionsMenu";
import { MatchSheet } from "@/features/controlroom/MatchSheet";
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
import { routes } from "@/lib/routes";
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
  // Mobile: the filters live in a bottom drawer, native-app style, instead of a
  // bar that would eat half the first screen (owner 2026-07-26).
  const [sheetOpen, setSheetOpen] = useState(false);

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

  // The empty state's onward links only make sense if the member can open the
  // wider board at all.
  const canBrowseAll =
    canManage || modules.includes("match.center_admin_view");

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

  /** The viewer's own seat on a match — only this page can know it. */
  const seatBadges = (m: ControlRoomMatch): React.ReactNode => {
    const roles = myRolesOn(m, userId);
    const scoringSeat = m.scorer?.id === userId;
    return (
      <span
        data-testid={`myrole-${m.id}`}
        className="flex shrink-0 flex-wrap items-center gap-1 text-[0.625rem]"
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
  };

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
      <div
        className="flex w-full flex-col gap-3"
        aria-busy="true"
      >
        <div className="h-24 animate-pulse rounded-xl border border-border bg-card" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (matchesQ.isError) {
    return (
      <div className="flex w-full flex-col gap-3">
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load your matches.")}
        </p>
      </div>
    );
  }

  const pill =
    "inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  // What is actively narrowing the list. Drives the drawer's badge and the
  // removable chips, so a phone user never has to open the drawer to find out
  // why they are looking at 1 match instead of 12.
  const activeFilters: { key: string; label: string; clear: () => void }[] = [];
  if (role !== "all") {
    activeFilters.push({
      key: "role",
      label: t(ROLE_FILTERS.find((r) => r.key === role)?.label ?? role),
      clear: () => setRole("all"),
    });
  }
  if (status !== "all") {
    activeFilters.push({
      key: "status",
      label: t(STATUS_FILTERS.find((f) => f.key === status)?.label ?? status),
      clear: () => setStatus("all"),
    });
  }
  if (effDay !== "all") {
    activeFilters.push({
      key: "day",
      label: fmtDayLabel(effDay),
      clear: () => setDay("all"),
    });
  }
  if (effComp !== "all") {
    activeFilters.push({
      key: "comp",
      label: competitions.find(([k]) => k === effComp)?.[1] ?? effComp,
      clear: () => setComp("all"),
    });
  }
  if (effVenue !== "all") {
    activeFilters.push({
      key: "venue",
      label: effVenue,
      clear: () => setVenue("all"),
    });
  }
  if (search.trim()) {
    activeFilters.push({
      key: "search",
      label: `"${search.trim()}"`,
      clear: () => setSearch(""),
    });
  }
  const resetAll = (): void => {
    setRole("all");
    setStatus("all");
    setDay("all");
    setComp("all");
    setVenue("all");
    setSearch("");
  };

  // One control height per surface — an h-9 input beside an h-10 select read
  // as a mistake (owner 2026-07-26).
  const selectSize = isMobile ? "lg" : "sm";

  /** The search box, reused by the desktop bar and the mobile drawer. */
  const searchField = (
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
        // Must match the Selects beside it: h-9 desk / h-11 phone.
        className={cn("min-w-0 pl-8 text-sm", isMobile && "h-11")}
      />
    </div>
  );

  /** Every select, reused by the desktop bar and the mobile drawer. */
  const selects = (
    <>
      <Select
        size={selectSize}
        aria-label={t("My role")}
        data-testid="mytasks-role"
        value={role}
        onChange={(v) => setRole(v as RoleFilter)}
        options={ROLE_FILTERS.map((r) => ({ value: r.key, label: t(r.label) }))}
      />
      {days.length > 1 ? (
        <Select
          size={selectSize}
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
          size={selectSize}
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
          size={selectSize}
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
        size={selectSize}
        aria-label={t("Group by")}
        data-testid="mytasks-group"
        value={groupBy}
        onChange={(v) => setGroupBy(v as GroupBy)}
        options={(Object.keys(GROUP_LABEL) as GroupBy[]).map((g) => ({
          value: g,
          label: `${t("Group by")} ${t(GROUP_LABEL[g]).toLowerCase()}`,
        }))}
      />
    </>
  );

  /** The status segment, reused by both. */
  const statusSegment = (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5",
        isMobile && "w-full",
      )}
    >
      {STATUS_FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          data-testid={`mytasks-status-${f.key}`}
          aria-pressed={status === f.key}
          onClick={() => setStatus(f.key)}
          className={cn(
            pill,
            isMobile && "h-10 flex-1 justify-center text-sm",
            status === f.key
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(f.label)}
        </button>
      ))}
    </div>
  );

  return (
    <div
      className={cn(
        "flex w-full flex-col",
        isMobile
          ? // Edge-to-edge list; the bottom bar only earns its clearance when
            // there is something to filter.
            cn("px-0 pt-3", mine.length > 0 ? "pb-24" : "pb-6")
          : // The same measure as Today (ControlRoomPage): the full width of the
            // workspace column, whose own px/py gutters are the page padding.
            // No clamp and no second layer of padding (owner 2026-08-05).
            "",
      )}
    >
      <div
        className={cn(
          "overflow-hidden bg-card",
          isMobile
            ? "border-y border-border"
            : "rounded-xl border border-border shadow-sm",
        )}
      >
        {/* The page heading lives INSIDE the panel: floated above it, an empty
            work list read as one huge gap (owner 2026-07-26). */}
        <div className="flex min-w-0 items-start gap-2 border-b border-border px-3 py-3 sm:px-4">
          <ClipboardCheck
            aria-hidden="true"
            className="mt-0.5 h-5 w-5 shrink-0 text-primary"
          />
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight sm:text-lg">
              {t("My tasks")}
            </h1>
            <p className="mt-0.5 text-xs text-muted-foreground sm:text-sm">
              {counts.total > 0
                ? `${t("You are assigned to")} ${counts.total} ${counts.total === 1 ? t("match") : t("matches")}`
                : t("Matches you are assigned to appear here.")}
            </p>
          </div>
        </div>

        {/* With nothing assigned there is nothing to count or filter, so the
            stat strip and the controls stay out of the way entirely and the
            empty state gets the whole panel. */}
        {mine.length > 0 ? (
          <>
        {/* Stat strip. A phone gets a horizontally scrollable chip rail —
            native-app shaped, and it never wraps to four stacked rows. */}
        {isMobile ? (
          <div
            data-testid="mytasks-stats"
            className="flex snap-x gap-2 overflow-x-auto border-b border-border px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]{display:none}"
          >
            {(
              [
                { k: "all" as StatusFilter, label: t("All mine"), v: counts.total, tid: "mytasks-stat-all" },
                { k: "live" as StatusFilter, label: t("Live"), v: counts.live, tid: "mytasks-stat-live" },
                { k: "upcoming" as StatusFilter, label: t("Upcoming"), v: counts.upcoming, tid: "mytasks-stat-upcoming" },
                { k: "done" as StatusFilter, label: t("Done"), v: counts.done, tid: "mytasks-stat-done" },
              ]
            ).map((c) => {
              const on = c.k === "all" ? status === "all" && role === "all" : status === c.k;
              return (
                <button
                  key={c.k}
                  type="button"
                  data-testid={c.tid}
                  aria-pressed={on}
                  onClick={() => {
                    if (c.k === "all") {
                      setStatus("all");
                      setRole("all");
                    } else {
                      setStatus(status === c.k ? "all" : c.k);
                    }
                  }}
                  className={cn(
                    "flex shrink-0 snap-start items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground",
                  )}
                >
                  {c.label}
                  <span className="font-tabular font-semibold tabular-nums">{c.v}</span>
                </button>
              );
            })}
          </div>
        ) : (
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
        )}

        {/* Filters. Desktop keeps the inline bar; a phone shows only what is
            currently applied, as removable chips — the controls themselves
            live in the bottom drawer. */}
        {isMobile ? (
          activeFilters.length > 0 ? (
            <div
              data-testid="mytasks-active-filters"
              className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2"
            >
              {activeFilters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  data-testid={`mytasks-clear-${f.key}`}
                  aria-label={`${t("Remove filter")}: ${f.label}`}
                  onClick={f.clear}
                  className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground"
                >
                  <span className="truncate">{f.label}</span>
                  <span aria-hidden="true" className="text-muted-foreground">
                    ×
                  </span>
                </button>
              ))}
              <button
                type="button"
                data-testid="mytasks-reset"
                onClick={resetAll}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-primary"
              >
                <RotateCcw aria-hidden="true" className="h-3 w-3" />
                {t("Clear")}
              </button>
            </div>
          ) : null
        ) : (
          <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              {searchField}
              {selects}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {statusSegment}
              <span className="ml-auto font-tabular text-xs text-muted-foreground">
                {filtered.length === mine.length
                  ? `${mine.length} ${t("matches")}`
                  : `${filtered.length} ${t("of")} ${mine.length} ${t("matches")}`}
              </span>
            </div>
          </div>
        )}
          </>
        ) : null}

        {/* The work list. */}
        {mine.length === 0 ? (
          // NOTHING assigned: an illustrated state that says who assigns work
          // and offers the one useful way onward, instead of a bare sentence
          // under four zeroes (owner 2026-07-26).
          <div
            data-testid="mytasks-empty"
            className="flex flex-col items-center gap-3 px-6 py-14 text-center"
          >
            <span
              aria-hidden="true"
              className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10"
            >
              <ClipboardCheck className="h-7 w-7 text-primary" />
            </span>
            <h2 className="text-base font-semibold">
              {t("No matches assigned to you yet")}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("An organizer assigns the scoring seat and the officiating roles. As soon as you are put on a match it appears here — with its court, time and what you are on it.")}
            </p>
            {canBrowseAll ? (
              <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                <Link
                  to={routes.tournamentMatches(id)}
                  className={cn(
                    buttonVariants({ size: "sm", variant: "outline" }),
                    "h-9",
                  )}
                >
                  <ListChecks aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("Browse the full schedule")}
                </Link>
                <Link
                  to={routes.tournamentControl(id)}
                  className={cn(
                    buttonVariants({ size: "sm", variant: "ghost" }),
                    "h-9",
                  )}
                >
                  {t("See today's play")}
                </Link>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("This page updates live — no need to refresh.")}
            </p>
          </div>
        ) : filtered.length === 0 ? (
          // Assigned work exists, the FILTERS hid it: name the way back.
          <div
            data-testid="mytasks-no-results"
            className="flex flex-col items-center gap-3 px-6 py-12 text-center"
          >
            <span
              aria-hidden="true"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"
            >
              <Search className="h-6 w-6 text-muted-foreground" />
            </span>
            <h2 className="text-sm font-semibold">
              {t("No matches fit these filters")}
            </h2>
            <p className="max-w-sm text-sm text-muted-foreground">
              {`${t("You have")} ${mine.length} ${mine.length === 1 ? t("assigned match") : t("assigned matches")} ${t("in total.")}`}
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="mytasks-no-results-reset"
              className="mt-1 h-9"
              onClick={resetAll}
            >
              <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Clear filters")}
            </Button>
          </div>
        ) : (
          <div data-testid="mytasks-list">
            {/* Desktop reads as the operations sheet; the phone keeps its
                stacked cards (house table→cards rule). */}
            {isMobile ? (
              groups.map((g) => (
                <div key={g.key}>
                  <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5">
                    <h2 className="text-[13px] font-semibold">{g.label}</h2>
                    <span className="font-tabular text-xs text-muted-foreground">
                      {g.matches.length}
                    </span>
                  </div>
                  {g.matches.map((m) => (
                    <MyTaskCard
                      key={m.id}
                      match={m}
                      timeZone={tz}
                      tournamentId={id}
                      siblings={all.filter((x) => x.leaf_key === m.leaf_key)}
                      perms={perms}
                      badges={seatBadges(m)}
                    />
                  ))}
                </div>
              ))
            ) : (
              <MatchSheet
                ariaLabel={t("My matches")}
                groups={groups.map((g) => ({
                  key: g.key,
                  label: g.label,
                  matches: g.matches,
                }))}
                timeZone={tz}
                tournamentId={id}
                siblingsOf={(m) => all.filter((x) => x.leaf_key === m.leaf_key)}
                perms={perms}
                showCourt={groupBy !== "venue"}
                badgesFor={seatBadges}
              />
            )}
          </div>
        )}
      </div>

      {/* Mobile: a sticky bottom bar is the one door to the filters, the way a
          native app does it — thumb-reachable, always visible while scrolling,
          and it states the current result count so the drawer is only opened
          on purpose. */}
      {isMobile && mine.length > 0 ? (
        <div
          data-testid="mytasks-bottom-bar"
          className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-border bg-card/95 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-card/85"
        >
          <span className="min-w-0 flex-1 truncate font-tabular text-xs text-muted-foreground">
            {filtered.length === mine.length
              ? `${mine.length} ${t("matches")}`
              : `${filtered.length} ${t("of")} ${mine.length} ${t("matches")}`}
          </span>
          <Button
            data-testid="mytasks-filters-open"
            className="h-11 shrink-0 px-4 text-sm"
            onClick={() => setSheetOpen(true)}
          >
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
            {t("Filters")}
            {activeFilters.length > 0 ? (
              <span
                data-testid="mytasks-filter-count"
                className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary-foreground px-1 font-tabular text-[0.6875rem] font-bold text-primary"
              >
                {activeFilters.length}
              </span>
            ) : null}
          </Button>
        </div>
      ) : null}

      {/* The drawer. `variant="sheet"` docks it to the bottom edge and brings
          the focus trap + Escape + backdrop dismiss with it. */}
      <Dialog
        open={isMobile && sheetOpen}
        onOpenChange={setSheetOpen}
        variant="sheet"
        ariaLabel={t("Filter my matches")}
      >
        <div data-testid="mytasks-filter-sheet" className="flex flex-col gap-4">
          {/* Grab handle — a plain flex child, not absolute: the sheet panel
              is not a positioning context, so `absolute` escaped to the
              overlay and pinned it to the top of the screen. */}
          <span
            aria-hidden="true"
            className="mx-auto h-1 w-10 shrink-0 rounded-full bg-border"
          />
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{t("Filters")}</h2>
            {activeFilters.length > 0 ? (
              <button
                type="button"
                data-testid="mytasks-sheet-reset"
                onClick={resetAll}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary"
              >
                <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Reset")}
              </button>
            ) : null}
          </div>

          {searchField}

          <div className="flex flex-col gap-1.5">
            <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t("Status")}
            </span>
            {statusSegment}
          </div>

          {/* One control per row: a 44px-tall list, not a cramped inline bar. */}
          <div className="flex flex-col gap-2 [&>*]:w-full">{selects}</div>

          <Button
            data-testid="mytasks-sheet-apply"
            className="h-12 w-full text-base"
            onClick={() => setSheetOpen(false)}
          >
            {filtered.length === mine.length
              ? t("Show all my matches")
              : `${t("Show")} ${filtered.length} ${filtered.length === 1 ? t("match") : t("matches")}`}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
