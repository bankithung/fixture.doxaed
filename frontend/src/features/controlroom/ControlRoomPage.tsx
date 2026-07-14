import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudRainWind, ListChecks, Printer, Radio } from "lucide-react";
import { ShiftDayDialog } from "@/features/fixtures/ShiftDayDialog";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type ControlRoomPayload,
} from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/toast";
import { useAuthStore } from "@/features/auth/authStore";
import { ScheduleChangesPanel } from "@/features/fixtures/ScheduleChangesPanel";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import {
  delayFor,
  delayMap,
  FINAL,
  fmtDayLabel,
  fmtKickoff,
  IN_PLAY,
  urgencyWeight,
  type SlotDelay,
} from "./format";
import type { ControlRoomPerms } from "./MatchActionsMenu";
import { MatchRow } from "./MatchRow";
import { MatchTile } from "./MatchTile";
import {
  CompetitionProgressPanel,
  CourtsPanel,
  LeadersPanel,
  SuspensionsPanel,
} from "./TodayWidgets";
import { useControlRoom } from "./useControlRoom";

/** A scheduled match whose kickoff slot has passed but still has no result —
 * "awaiting result" in the ops band. Kept a plain helper so the wall-clock read
 * stays out of render (matches the codebase's relative-time helpers). */
function AdvancementStalledBanner({
  tournamentId,
  count,
}: {
  tournamentId: string;
  count: number;
}): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const refire = useMutation({
    mutationFn: () => tournamentsApi.refireAdvancement(tournamentId),
    onSuccess: (r) => {
      toast.push({
        kind: r.stalled_after === 0 ? "success" : "error",
        title:
          r.stalled_after === 0
            ? t("Bracket repaired. Every finished result advanced.")
            : `${r.stalled_after} ${t("slots are still stalled. Check the feeder results.")}`,
      });
      qc.invalidateQueries({ queryKey: qk.controlRoom(tournamentId) });
      qc.invalidateQueries({ queryKey: qk.matches(tournamentId) });
    },
    onError: () =>
      toast.push({ kind: "error", title: t("Could not re-run advancement.") }),
  });
  return (
    <div
      role="alert"
      data-testid="advancement-stalled"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-2.5"
    >
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">{count}</span>{" "}
        {t(
          "bracket slots are stalled: a finished match's winner never advanced.",
        )}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={refire.isPending}
        onClick={() => refire.mutate()}
      >
        {refire.isPending ? t("Repairing") : t("Re-run advancement")}
      </Button>
    </div>
  );
}


function isOverdue(scheduledAt: string | null): boolean {
  if (!scheduledAt) return false;
  return new Date(scheduledAt).getTime() < Date.now();
}

/**
 * Operations band atop the control room (ops 2026-06-26): what is live now, how
 * far through the day, what still needs attention, and what is up next. Every
 * value is derived from the day aggregate already in scope (zero backend) and
 * rides the same SSE tick, so it stays live without a second connection. Rendered
 * as a prominent hairline-divided stat band (owner 2026-07-03: the day's
 * numbers lead the page), font-tabular, one accent reserved for "live";
 * wraps 2-up on small screens.
 */
function OpsHeaderBand({
  data,
  selectedDay,
  delays,
  tz,
  onNeedsYou,
}: {
  data: ControlRoomPayload;
  selectedDay: string;
  delays: Map<string, SlotDelay>;
  tz: string;
  /** Jumps the board below to its "Needs you" filter — the band states the
   * exception count, the board is where you act on it. */
  onNeedsYou: () => void;
}): React.ReactElement {
  const all = data.venues.flatMap((v) => v.matches);
  const counts = data.days.find((d) => d.date === selectedDay)?.counts;
  const total = counts?.total ?? all.length;
  const completed =
    counts?.completed ?? all.filter((m) => FINAL.has(m.status)).length;
  const liveCount =
    counts?.live ?? all.filter((m) => IN_PLAY.has(m.status)).length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const delayed = all.filter((m) => delayFor(delays, m) != null).length;
  const awaiting = all.filter(
    (m) => m.status === "scheduled" && isOverdue(m.scheduled_at),
  ).length;
  const noVenue = all.filter((m) => !m.venue).length;
  const next = data.queue.find((m) => m.status === "scheduled") ?? null;
  // `||` not `??`: an empty short_name string must fall through to the
  // name, and a fully unresolved slot reads "TBD" (it rendered a bare "v").
  const teamName = (tm: { name: string; short_name?: string } | null): string =>
    tm?.short_name || tm?.name || t("TBD");

  const overline =
    "text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground";
  return (
    <div
      data-testid="ops-band"
      className="panel grid grid-cols-2 divide-border max-lg:divide-y lg:grid-cols-4 lg:divide-x"
    >
      <div className="flex min-w-0 flex-col justify-center gap-1.5 px-5 py-4">
        <p className={overline}>{t("On now")}</p>
        <p className="flex items-baseline gap-2">
          <span className="font-tabular text-3xl font-semibold leading-none">
            {liveCount}
          </span>
          <span className="text-sm text-muted-foreground">{t("live")}</span>
          {liveCount > 0 ? (
            <span className="relative ml-0.5 flex h-2.5 w-2.5 self-center">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex min-w-0 flex-col justify-center gap-1.5 px-5 py-4">
        <p className={overline}>{t("Played")}</p>
        <div className="flex items-center gap-3">
          <p className="font-tabular text-3xl font-semibold leading-none">
            {completed}
            <span className="text-lg font-normal text-muted-foreground">
              /{total}
            </span>
          </p>
          <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        {delayed > 0 ? (
          <p className="truncate font-tabular text-xs text-warning">
            {delayed} {t("running late")}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        data-testid="ops-needs-you"
        onClick={onNeedsYou}
        className="flex min-w-0 flex-col justify-center gap-1.5 px-5 py-4 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className={cn(overline, "block")}>{t("Needs you")}</span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "font-tabular text-3xl font-semibold leading-none",
              awaiting > 0 || noVenue > 0 ? "text-warning" : null,
            )}
          >
            {awaiting + noVenue}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {awaiting > 0
              ? t("awaiting result")
              : noVenue > 0
                ? t("no venue")
                : t("all caught up")}
          </span>
        </span>
      </button>

      <div className="flex min-w-0 flex-col justify-center gap-1.5 px-5 py-4">
        <p className={overline}>{t("Up next")}</p>
        {next ? (
          <div className="min-w-0">
            <p className="font-tabular text-3xl font-semibold leading-none">
              {next.scheduled_at ? fmtKickoff(next.scheduled_at, tz) : t("TBD")}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {teamName(next.home_team)} v {teamName(next.away_team)}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("Nothing queued")}</p>
        )}
      </div>
    </div>
  );
}

type BoardTab = "play" | "courts" | "leaders" | "progress" | "changes";
type PlayFilter = "next" | "attention" | "results" | "all";

/** Consecutive matches sharing a kickoff become one group under a time header,
 * so the feed reads as a run of play instead of a wall of repeated clocks. */
function groupByKickoff(
  matches: ControlRoomMatch[],
  tz: string,
): { label: string; matches: ControlRoomMatch[] }[] {
  const out: { label: string; matches: ControlRoomMatch[] }[] = [];
  for (const m of matches) {
    const label = fmtKickoff(m.scheduled_at, tz);
    const last = out[out.length - 1];
    if (last && last.label === label) last.matches.push(m);
    else out.push({ label, matches: [m] });
  }
  return out;
}

/**
 * THE DAY BOARD — the one combined section (owner 2026-07-14: "one combined
 * section, it's too stacked"). Eight panels down the page became a single card
 * with five tabs. The default tab is the run of play: every match of the day in
 * kickoff order, filtered by what you're doing right now (what's on, what's
 * stuck, what's finished), each row keeping its full actions. Courts, leaders,
 * competition progress and the change log are the other tabs of the same card,
 * so the page is one screen instead of an endless scroll.
 */
function DayBoard({
  tournamentId,
  matches,
  venues,
  competitions,
  tz,
  perms,
  delays,
  isMobile,
  tab,
  setTab,
  filter,
  setFilter,
}: {
  tournamentId: string;
  matches: ControlRoomMatch[];
  venues: ControlRoomPayload["venues"];
  competitions: { leafKey: string; label: string }[];
  tz: string;
  perms: ControlRoomPerms;
  delays: Map<string, SlotDelay>;
  isMobile: boolean;
  tab: BoardTab;
  setTab: (v: BoardTab) => void;
  filter: PlayFilter;
  setFilter: (v: PlayFilter) => void;
}): React.ReactElement {
  const byTime = (a: ControlRoomMatch, b: ControlRoomMatch) =>
    (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? "");

  const buckets = useMemo(() => {
    const next = matches
      .filter((m) => !FINAL.has(m.status))
      .sort(
        (a, b) =>
          Number(IN_PLAY.has(b.status)) - Number(IN_PLAY.has(a.status)) ||
          byTime(a, b),
      );
    const attention = matches
      .filter((m) => urgencyWeight(m) > 0 && !IN_PLAY.has(m.status))
      .sort((a, b) => urgencyWeight(b) - urgencyWeight(a) || byTime(a, b));
    const results = matches
      .filter((m) => FINAL.has(m.status))
      .sort((a, b) => byTime(b, a));
    const all = [...matches].sort(byTime);
    return { next, attention, results, all };
  }, [matches]);

  const feed = buckets[filter];
  const groups = groupByKickoff(feed, tz);
  const liveCount = matches.filter((m) => IN_PLAY.has(m.status)).length;

  const filters: {
    key: PlayFilter;
    label: string;
    count: number;
    empty: string;
  }[] = [
    {
      key: "next",
      label: t("Now & next"),
      count: buckets.next.length,
      empty: t("Every match of the day is finished."),
    },
    {
      key: "attention",
      label: t("Needs attention"),
      count: buckets.attention.length,
      empty: t("All caught up. Nothing is waiting on you."),
    },
    {
      key: "results",
      label: t("Recent results"),
      count: buckets.results.length,
      empty: t("No results yet today."),
    },
    {
      key: "all",
      label: t("All"),
      count: buckets.all.length,
      empty: t("Nothing scheduled on this day."),
    },
  ];
  const active = filters.find((f) => f.key === filter)!;

  const tabs: { key: BoardTab; label: string; count?: number }[] = [
    { key: "play", label: t("Run of play"), count: matches.length },
    { key: "courts", label: t("Courts today"), count: venues.length },
    { key: "leaders", label: t("Leaders") },
    { key: "progress", label: t("Competition progress") },
    { key: "changes", label: t("Change history") },
  ];

  const siblingsOf = (m: ControlRoomMatch) =>
    matches.filter((x) => x.leaf_key === m.leaf_key);

  return (
    <section data-testid="day-board" className="panel flex flex-col">
      {/* Tab strip: the five views of the day, one card. Counts are badges, not
          loose numerals — label-then-number ran together into one long line. */}
      <div
        role="tablist"
        aria-label={t("Match day board")}
        className="flex shrink-0 items-center overflow-x-auto border-b border-border px-2"
      >
        {tabs.map((tb) => {
          const on = tb.key === tab;
          return (
            <button
              key={tb.key}
              type="button"
              role="tab"
              id={`board-tab-${tb.key}`}
              aria-selected={on}
              aria-controls="board-panel"
              data-testid={`board-tab-${tb.key}`}
              onClick={() => setTab(tb.key)}
              className={cn(
                "-mb-px inline-flex h-11 shrink-0 items-center gap-2 border-b-2 px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                on
                  ? "border-b-primary font-semibold text-foreground"
                  : "border-b-transparent font-medium text-muted-foreground hover:text-foreground",
              )}
            >
              {tb.key === "play" && liveCount > 0 ? (
                <span className="relative flex h-2 w-2 shrink-0" aria-label={t("Live now")}>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
              ) : null}
              {tb.label}
              {tb.count != null ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 font-tabular text-[0.6875rem] font-medium leading-none",
                    on
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {tb.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="board-panel"
        aria-labelledby={`board-tab-${tab}`}
        className="min-w-0"
      >
        {tab === "play" ? (
          <>
            {/* Filter rail: one feed, four questions. A bounded segmented
                control with a "Showing" label, so it reads as a control rather
                than a second row of tabs. */}
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
              <span className="text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                {t("Showing")}
              </span>
              <div
                role="group"
                aria-label={t("Filter the run of play")}
                className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5"
              >
                {filters.map((f) => {
                  const on = f.key === filter;
                  const urgent = f.key === "attention" && f.count > 0;
                  return (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={on}
                      data-testid={`feed-filter-${f.key}`}
                      onClick={() => setFilter(f.key)}
                      className={cn(
                        "inline-flex h-7 shrink-0 items-center gap-2 rounded-md px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        on
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {f.label}
                      <span
                        className={cn(
                          "rounded px-1 py-0.5 font-tabular text-[0.6875rem] leading-none",
                          urgent
                            ? "bg-warning-muted text-warning"
                            : on
                              ? "bg-muted text-muted-foreground"
                              : "text-muted-foreground/70",
                        )}
                      >
                        {f.count}
                      </span>
                    </button>
                  );
                })}
              </div>
              <Link
                to={routes.tournamentMatches(tournamentId)}
                className="ml-auto hidden text-xs font-medium text-primary hover:underline sm:inline"
              >
                {t("Open full board")}
              </Link>
            </div>

            {feed.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                {active.empty}
              </p>
            ) : isMobile ? (
              <div className="flex flex-col gap-2 p-2">
                {feed.map((m) => (
                  <MatchTile
                    key={m.id}
                    match={m}
                    timeZone={tz}
                    tournamentId={tournamentId}
                    siblings={siblingsOf(m)}
                    perms={perms}
                    delayMinutes={delayFor(delays, m)}
                  />
                ))}
              </div>
            ) : (
              <div role="table" aria-label={active.label}>
                {groups.map((g) => (
                  <div key={`${g.label}-${g.matches[0].id}`}>
                    <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-1.5">
                      <span className="font-tabular text-[13px] font-semibold">
                        {g.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {g.matches.length}{" "}
                        {g.matches.length === 1 ? t("match") : t("matches")}
                      </span>
                    </div>
                    {g.matches.map((m) => (
                      <MatchRow
                        key={m.id}
                        match={m}
                        timeZone={tz}
                        tournamentId={tournamentId}
                        siblings={siblingsOf(m)}
                        perms={perms}
                        delayMinutes={delayFor(delays, m)}
                        showTime={false}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {tab === "courts" ? (
          <CourtsPanel venues={venues} timeZone={tz} bare />
        ) : null}
        {tab === "leaders" ? <LeadersPanel tournamentId={tournamentId} bare /> : null}
        {tab === "progress" ? (
          <CompetitionProgressPanel matches={matches} bare />
        ) : null}
        {tab === "changes" ? (
          <ScheduleChangesPanel
            tournamentId={tournamentId}
            competitions={competitions}
            embedded
            viewAllTo={routes.tournamentChanges(tournamentId)}
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * The live-ops cockpit (control room spec 2026-06-12 §1/§3.1): a day-by-day,
 * venue-laned view of match day. Day chips select among the days that have
 * matches (the server defaults to today-or-next); each venue renders a
 * NOW/NEXT lane of match tiles with role-gated actions; the cross-venue
 * queue rail shows what's up next anywhere. Live updates ride the public SSE
 * tick stream — every tick invalidates the aggregate (members refetch the
 * authed payload) — with a 60 s poll as the graceful fallback.
 */
export function ControlRoomPage(): React.ReactElement {
  const { id = "" } = useParams();
  const { isMobile } = useBreakpoint();
  const user = useAuthStore((s) => s.user);
  const [day, setDay] = useState<string | null>(null);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [tab, setTab] = useState<BoardTab>("play");
  const [filter, setFilter] = useState<PlayFilter>("next");

  const stageQ = useQuery({
    queryKey: qk.stage(id),
    queryFn: () => tournamentsApi.stage(id),
  });
  const { query, live } = useControlRoom(id, day);
  const data = query.data;

  // Role gates from the stage payload (spec §4); the backend enforces.
  const canManage = stageQ.data?.can_manage ?? false;
  const modules = stageQ.data?.modules ?? [];
  const perms: ControlRoomPerms = {
    canManage,
    canSchedule: canManage || modules.includes("tournament.schedule_editor"),
    canScore: canManage || modules.includes("match.scoring_console"),
    userId: user?.id ?? null,
  };

  // Delay visibility stays client-side from the schedule-changes feed (§2.a).
  const changes = useQuery({
    queryKey: [...qk.scheduleChanges(id), "control-room"],
    queryFn: () => tournamentsApi.scheduleChanges(id, { limit: 100 }),
    enabled: data !== undefined && data.days.length > 0,
  });
  const delays = useMemo(
    () => delayMap(changes.data?.results ?? []),
    [changes.data],
  );

  const allMatches = useMemo(
    () => (data?.venues ?? []).flatMap((v) => v.matches),
    [data],
  );
  const siblingsOf = (m: { leaf_key: string }) =>
    allMatches.filter((x) => x.leaf_key === m.leaf_key);
  const competitions = useMemo(() => {
    const by = new Map<string, string>();
    for (const m of allMatches) {
      if (m.leaf_key && !by.has(m.leaf_key)) by.set(m.leaf_key, m.leaf_label);
    }
    return [...by.entries()].map(([leafKey, label]) => ({
      leafKey,
      label: label || leafKey,
    }));
  }, [allMatches]);

  const tz = data?.tournament.time_zone ?? "UTC";
  const selectedDay = day ?? data?.day ?? "";

  // Member view: a plain member (no manage / no scheduling) who is the assigned
  // scorer on any of the day's matches gets a focused "My matches" lane instead
  // of the full venue board — their job is to enter results, nothing else
  // (ops 2026-06-26). Admins/coordinators always get the full board.
  const isPlainMember = !perms.canManage && !perms.canSchedule;
  const myMatches = perms.userId
    ? allMatches.filter((m) => m.scorer?.id === perms.userId)
    : [];
  const showMine = isPlainMember && myMatches.length > 0;

  if (query.isLoading) {
    return (
      <div className="flex w-full flex-col gap-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-32 animate-pulse rounded-xl border border-border bg-card"
          />
        ))}
      </div>
    );
  }
  if (query.isError || !data) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("Could not load the control room.")}
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {/* P3 advancement health: a stalled bracket is invisible without this
          banner — a feeder finished but its winner never advanced. */}
      {(data.advancement_stalled?.length ?? 0) > 0 ? (
        <AdvancementStalledBanner
          tournamentId={id}
          count={data.advancement_stalled!.length}
        />
      ) : null}
      {/* Header: one row — title, live status, day chips, quiet actions. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 print:hidden">
        <h2 className="page-title">{t("Today")}</h2>
        <span
          data-testid="stream-status"
          title={live ? t("Live updates on") : t("Updating every minute")}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          {live ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          ) : (
            <Radio aria-hidden="true" className="h-3 w-3" />
          )}
          {live ? t("Live") : t("Polling")}
        </span>
        {/* Day chips share the title row (compact pass 2026-07-03); the
            mobile Select stays below where there is no horizontal room. */}
        {data.days.length > 0 && !isMobile ? (
          <div
            role="group"
            aria-label={t("Match day")}
            className="inline-flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5"
          >
            {data.days.map((d) => {
              const active = d.date === selectedDay;
              return (
                <button
                  key={d.date}
                  type="button"
                  data-testid={`day-chip-${d.date}`}
                  aria-pressed={active}
                  onClick={() => setDay(d.date)}
                  className={cn(
                    "inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {fmtDayLabel(d.date)}
                  <span
                    className={cn(
                      "font-tabular",
                      active
                        ? "text-muted-foreground"
                        : "text-muted-foreground/70",
                    )}
                  >
                    {d.counts.completed}/{d.counts.total}
                  </span>
                  {d.counts.live > 0 ? (
                    <span
                      aria-label={t("Live now")}
                      className="h-1.5 w-1.5 rounded-full bg-primary"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {perms.canSchedule ? (
            <button
              type="button"
              data-testid="shift-day"
              onClick={() => setShiftOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CloudRainWind aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Shift a day")}
            </button>
          ) : null}
          {!showMine ? (
            <button
              type="button"
              data-testid="print-day-sheet"
              onClick={() => window.print()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Printer aria-hidden="true" className="h-3.5 w-3.5" />
              {t("Print")}
            </button>
          ) : null}
          <Link
            to={routes.tournamentMatches(id)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs font-medium transition-colors hover:bg-accent"
          >
            <ListChecks aria-hidden="true" className="h-3.5 w-3.5" />
            {t("Matches board")}
          </Link>
        </div>
      </div>

      {data.days.length === 0 ? (
        <section className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-12 text-center">
          <p className="text-sm font-medium">
            {t("Nothing is on the calendar yet")}
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("Schedule matches to see them here.")}
          </p>
          {perms.canManage ? (
            <Link
              to={routes.tournamentFixtures(id)}
              className="text-sm font-medium text-primary hover:underline"
            >
              {t("Open fixture setup")}
            </Link>
          ) : null}
        </section>
      ) : (
        <div
          className={cn(
            "flex min-w-0 flex-col gap-3 transition-opacity print:hidden",
            // Day switch in flight: dim the old day's board instead of
            // blanking the page; content swaps in place when it arrives.
            query.isPlaceholderData && "pointer-events-none opacity-60",
          )}
        >
          {/* Day selector on mobile — desktop chips live in the title row. */}
          {isMobile ? (
            <Select
              aria-label={t("Match day")}
              className="w-full"
              value={selectedDay}
              onChange={(v) => setDay(v)}
              options={data.days.map((d) => ({
                value: d.date,
                label: `${fmtDayLabel(d.date)} · ${d.counts.completed}/${d.counts.total}`,
              }))}
            />
          ) : null}

          {showMine ? (
            // Focused member lane: just the matches this user is scoring today.
            <section data-testid="my-matches" className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{t("My matches")}</h3>
                <span className="rounded-full bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground">
                  {myMatches.length}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("Tap a match to enter its result.")}
                </span>
              </div>
              <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2">
                {myMatches.map((m) => (
                  <MatchTile
                    key={m.id}
                    match={m}
                    timeZone={tz}
                    tournamentId={id}
                    siblings={siblingsOf(m)}
                    perms={perms}
                    delayMinutes={delayFor(delays, m)}
                  />
                ))}
              </div>
            </section>
          ) : (
            // The Today dashboard: the day's numbers, then ONE combined board.
            <>
              <OpsHeaderBand
                data={data}
                selectedDay={selectedDay}
                delays={delays}
                tz={tz}
                onNeedsYou={() => {
                  setTab("play");
                  setFilter("attention");
                }}
              />

              <SuspensionsPanel tournamentId={id} />

              <DayBoard
                tournamentId={id}
                matches={allMatches}
                venues={data.venues}
                competitions={competitions}
                tz={tz}
                perms={perms}
                delays={delays}
                isMobile={isMobile}
                tab={tab}
                setTab={setTab}
                filter={filter}
                setFilter={setFilter}
              />
            </>
          )}
        </div>
      )}
      {/* Print-only operations day sheet: order of play by court with crew
          and a blank result column, for venue managers and referees. */}
      <div data-testid="day-sheet" className="hidden print:block">
        <h1 className="text-xl font-semibold">
          {t("Day sheet")} · {selectedDay ? fmtDayLabel(selectedDay) : ""}
        </h1>
        {Object.entries(
          allMatches.reduce<Record<string, typeof allMatches>>((acc, m) => {
            const v = m.venue || t("Unassigned court");
            (acc[v] = acc[v] ?? []).push(m);
            return acc;
          }, {}),
        ).map(([venue, ms]) => (
          <table key={venue} className="mt-4 w-full border-collapse text-sm">
            <caption className="pb-1 text-left text-base font-semibold">
              {venue}
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase">
                <th className="py-1 pr-2">{t("Time")}</th>
                <th className="py-1 pr-2">{t("Match")}</th>
                <th className="py-1 pr-2">{t("Competition")}</th>
                <th className="py-1 pr-2">{t("Crew")}</th>
                <th className="py-1">{t("Result")}</th>
              </tr>
            </thead>
            <tbody>
              {[...ms]
                .sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""))
                .map((m) => (
                  <tr key={m.id} className="border-b border-border align-top">
                    <td className="py-1.5 pr-2 font-tabular">
                      {m.scheduled_at
                        ? new Date(m.scheduled_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            timeZone: tz,
                          })
                        : ""}
                    </td>
                    <td className="py-1.5 pr-2">
                      {m.home_team?.name ?? "TBD"} {t("vs")} {m.away_team?.name ?? "TBD"}
                    </td>
                    <td className="py-1.5 pr-2">{m.leaf_label}</td>
                    <td className="py-1.5 pr-2">
                      {[m.scorer?.name, ...(m.officials ?? []).map((o) => o.name)]
                        .filter(Boolean)
                        .join(", ")}
                    </td>
                    <td className="w-24 py-1.5">
                      <span className="inline-block w-20 border-b border-border">
                        &nbsp;
                      </span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        ))}
      </div>

      {shiftOpen ? (
        <ShiftDayDialog
          tournamentId={id}
          matches={allMatches}
          competitions={competitions}
          onClose={() => setShiftOpen(false)}
        />
      ) : null}
    </div>
  );
}
