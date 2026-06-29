import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, History, Radio } from "lucide-react";
import { tournamentsApi, type ControlRoomPayload } from "@/api/tournaments";
import { Select } from "@/components/ui/Select";
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
  type SlotDelay,
} from "./format";
import type { ControlRoomPerms } from "./MatchActionsMenu";
import { MatchTile } from "./MatchTile";
import { QueueRail } from "./QueueRail";
import { useControlRoom } from "./useControlRoom";
import { VenueLane } from "./VenueLane";

/** A scheduled match whose kickoff slot has passed but still has no result —
 * "awaiting result" in the ops band. Kept a plain helper so the wall-clock read
 * stays out of render (matches the codebase's relative-time helpers). */
function isOverdue(scheduledAt: string | null): boolean {
  if (!scheduledAt) return false;
  return new Date(scheduledAt).getTime() < Date.now();
}

/**
 * Operations band atop the control room (ops 2026-06-26): what is live now, how
 * far through the day, what still needs attention, and what is up next. Every
 * value is derived from the day aggregate already in scope (zero backend) and
 * rides the same SSE tick, so it stays live without a second connection. Cells
 * are hairline-separated (gap-px over a border fill), font-tabular, one accent
 * reserved for "live"; wraps 2-up then 4-up.
 */
function OpsHeaderBand({
  data,
  selectedDay,
  delays,
  tz,
}: {
  data: ControlRoomPayload;
  selectedDay: string;
  delays: Map<string, SlotDelay>;
  tz: string;
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
  const teamName = (tm: { name: string; short_name?: string } | null): string =>
    tm?.short_name ?? tm?.name ?? t("TBD");

  const overline =
    "text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground";
  const chip =
    "inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400";
  return (
    <div
      data-testid="ops-band"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4"
    >
      <div className="flex flex-col bg-card p-4">
        <p className={overline}>{t("On now")}</p>
        <p className="mt-1 flex items-baseline gap-1.5">
          <span className="font-tabular text-2xl font-semibold leading-none">
            {liveCount}
          </span>
          <span className="text-xs text-muted-foreground">
            {liveCount === 1 ? t("match live") : t("matches live")}
          </span>
          {liveCount > 0 ? (
            <span className="relative ml-0.5 flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex flex-col bg-card p-4">
        <p className={overline}>{t("Today")}</p>
        <p className="mt-1 flex items-baseline gap-1.5">
          <span className="font-tabular text-2xl font-semibold leading-none">
            {completed}
            <span className="text-muted-foreground">/{total}</span>
          </span>
          <span className="text-xs text-muted-foreground">{t("done")}</span>
        </p>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
        {delayed > 0 ? (
          <p className="mt-1.5 font-tabular text-xs text-amber-600 dark:text-amber-400">
            {delayed} {t("running late")}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col bg-card p-4">
        <p className={overline}>{t("Needs you")}</p>
        {awaiting > 0 || noVenue > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {awaiting > 0 ? (
              <span className={chip}>
                <span className="font-tabular">{awaiting}</span>{" "}
                {t("awaiting result")}
              </span>
            ) : null}
            {noVenue > 0 ? (
              <span className={chip}>
                <span className="font-tabular">{noVenue}</span> {t("no venue")}
              </span>
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("All caught up")}
          </p>
        )}
      </div>

      <div className="flex flex-col bg-card p-4">
        <p className={overline}>{t("Up next")}</p>
        {next ? (
          <div className="mt-1 min-w-0">
            <p className="font-tabular text-sm font-semibold">
              {next.scheduled_at ? fmtKickoff(next.scheduled_at, tz) : t("TBD")}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {teamName(next.home_team)} v {teamName(next.away_team)}
            </p>
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Nothing queued")}
          </p>
        )}
      </div>
    </div>
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
  const [changesOpen, setChangesOpen] = useState(false);

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
      <div className="flex w-full flex-col gap-4" aria-busy="true">
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
    <div className="flex w-full flex-col gap-5">
      {/* Header: identity + stream health. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("Live operations")}
          </p>
          <h2 className="text-lg font-semibold tracking-tight">
            {t("Control room")}
          </h2>
        </div>
        <span
          data-testid="stream-status"
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
            live
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {live ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          ) : (
            <Radio aria-hidden="true" className="h-3 w-3" />
          )}
          {live ? t("Live updates on") : t("Updating every minute")}
        </span>
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
        <>
          {showMine ? null : (
            <OpsHeaderBand
              data={data}
              selectedDay={selectedDay}
              delays={delays}
              tz={tz}
            />
          )}

          {/* Day selector — chips on desktop, the custom Select on mobile. */}
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
          ) : (
            <div
              role="group"
              aria-label={t("Match day")}
              className="flex flex-wrap items-center gap-1.5"
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
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-foreground hover:bg-accent",
                    )}
                  >
                    {fmtDayLabel(d.date)}
                    <span
                      className={cn(
                        "font-tabular",
                        active
                          ? "text-primary-foreground/80"
                          : "text-muted-foreground",
                      )}
                    >
                      {d.counts.completed}/{d.counts.total}
                    </span>
                    {d.counts.live > 0 ? (
                      <span
                        aria-label={t("Live now")}
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          active ? "bg-primary-foreground" : "bg-primary",
                        )}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}

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
            <>
              <QueueRail queue={data.queue} timeZone={tz} delays={delays} />

              {/* Per-venue lanes. */}
              {data.venues.length === 0 ? (
                <p className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
                  {t("No matches on this day.")}
                </p>
              ) : (
                <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {data.venues.map((v) => (
                    <VenueLane
                      key={v.venue || "unassigned"}
                      venue={v.venue}
                      matches={v.matches}
                      timeZone={tz}
                      tournamentId={id}
                      perms={perms}
                      delays={delays}
                      siblingsOf={siblingsOf}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {/* Changes drawer — the audit-backed slot-change feed (§1.1). */}
          {!showMine && allMatches.length > 0 ? (
            <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <button
                type="button"
                data-testid="changes-drawer-toggle"
                aria-expanded={changesOpen}
                className="flex w-full items-center gap-2 px-4 py-3 text-left"
                onClick={() => setChangesOpen((o) => !o)}
              >
                <History aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                <h3 className="text-sm font-semibold">{t("Change history")}</h3>
                <span className="hidden text-xs text-muted-foreground sm:block">
                  {t("Time and venue changes, with who and why.")}
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                    changesOpen && "rotate-180",
                  )}
                />
              </button>
              {changesOpen ? (
                <div className="border-t border-border p-3">
                  <ScheduleChangesPanel
                    tournamentId={id}
                    competitions={competitions}
                  />
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
