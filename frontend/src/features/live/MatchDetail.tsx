import { Fragment, useCallback, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  liveApi,
  type LiveH2HRow,
  type LiveSnapshot,
  type LiveStatRow,
} from "@/api/live";
import { routes } from "@/lib/routes";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useEventStream } from "@/lib/useEventStream";
import { TeamCrest, type CrestSize } from "@/components/ui/TeamCrest";
import { sideView } from "./lineups/adapter";
import { resolveLineupView } from "./lineups/registry";

/**
 * ONE match detail, two surfaces: the public match hub at /m/:id and the
 * drawer the public match sheet slides in over its own list (owner
 * 2026-08-21). Everything about a match that a viewer can see lives here —
 * scoreline, match info, participants, timeline, stats, head to head — so the
 * page and the drawer can never tell two different stories about the same
 * game.
 *
 * The page owns its own chrome (brand bar, share, "what's on next"); this owns
 * the match.
 */

export const OVERLINE =
  "text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground";

export const LIVE_STATUSES = new Set([
  "live",
  "half_time",
  "extra_time",
  "penalties",
]);
export const FINAL_STATUSES = new Set(["completed", "walkover"]);
/** A shared link to a finished match should not refetch forever. */
export const TERMINAL_STATUSES = new Set([
  "completed",
  "walkover",
  "cancelled",
]);

export type SnapMatch = LiveSnapshot["match"];

export type TabKey = "overview" | "lineups" | "timeline" | "stats" | "h2h";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "lineups", label: "Lineups" },
  { key: "timeline", label: "Timeline" },
  { key: "stats", label: "Stats" },
  { key: "h2h", label: "Head to head" },
];

export function statusMeta(status: string): { label: string; cls: string; live: boolean } {
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
      cls: "bg-warning-muted text-warning",
      live: false,
    };
  }
  return {
    label: status.replace(/_/g, " "),
    cls: "bg-secondary text-secondary-foreground",
    live: false,
  };
}

export function LivePulse(): React.ReactElement {
  return (
    <span className="relative flex h-2 w-2" data-testid="live-pulse">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
    </span>
  );
}

export function StatusPill({ status }: { status: string }): React.ReactElement {
  const sm = statusMeta(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-[0.6875rem] font-medium capitalize",
        sm.cls,
      )}
    >
      {sm.live ? <LivePulse /> : null}
      {t(sm.label)}
    </span>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "yellow_card" to "Yellow card" (event types and periods alike). */
function humanizeKey(s: string): string {
  return cap(s.replace(/_/g, " "));
}

/** One leaf-key segment ("u15", "boys", "5v5") to display form. */
function humanizeSeg(s: string): string {
  if (/^u-?\d+$/i.test(s)) return s.replace(/-/g, "").toUpperCase();
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Competition context as chips (never a dash-joined string): sport first
 * (primary tint), then the leaf segments, then the group/round label. */
export function CompetitionChips({ match }: { match: SnapMatch }): React.ReactElement | null {
  const segs = (match.leaf_key ?? "").split(".").filter(Boolean);
  const sportChip = match.sport_meta?.name ?? (segs[0] ? humanizeSeg(segs[0]) : "");
  const rest = segs.slice(1).map(humanizeSeg);
  // A knockout match's `group_label` IS its competition label ("Table Tennis ·
  // Open Category · Boys · Doubles"), so rendering it whole printed the
  // competition twice — the second time as exactly the dash-joined blob the
  // chips exist to avoid. Only a group label that says something the chips do
  // not ("Group A") earns a chip of its own.
  const groupSegs = (match.group_label ?? "")
    .split(/\s+[\u00b7\u2013\u2014|/-]+\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const named = new Set(
    [sportChip, ...rest].filter(Boolean).map((x) => x.toLowerCase()),
  );
  const last = groupSegs[groupSegs.length - 1] ?? "";
  const group = last && !named.has(last.toLowerCase()) ? last : "";
  if (!sportChip && rest.length === 0 && !group) return null;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {sportChip ? (
        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] font-medium leading-tight text-primary">
          {sportChip}
        </span>
      ) : null}
      {rest.map((p, i) => (
        <span
          key={`${p}-${i}`}
          className="rounded-md bg-muted px-1.5 py-0.5 text-[0.6875rem] font-medium leading-tight text-muted-foreground"
        >
          {p}
        </span>
      ))}
      {group ? (
        <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[0.6875rem] font-medium leading-tight text-secondary-foreground">
          {group}
        </span>
      ) : null}
    </span>
  );
}

function fmtInTz(
  iso: string | null | undefined,
  tz: string,
  opts: Intl.DateTimeFormatOptions,
): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: tz }).format(
      new Date(iso),
    );
  } catch {
    return iso.slice(11, 16);
  }
}

export function fmtTime(iso: string | null | undefined, tz: string): string | null {
  return fmtInTz(iso, tz, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtDateTime(iso: string | null | undefined, tz: string): string | null {
  return fmtInTz(iso, tz, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtDate(iso: string | null | undefined, tz: string): string | null {
  return fmtInTz(iso, tz, { day: "numeric", month: "short", year: "numeric" });
}

/** Secondary-attribution label per event type ("Assist Striker"). */
function relLabel(type: string): string {
  if (type === "goal" || type === "penalty_scored") return t("Assist");
  if (type === "substitution") return t("Off");
  return t("With");
}

/** A team's crest + name on the hub. A TBD side has no team, so it shows no
 * badge at all rather than a placeholder for a team nobody knows yet. */
export function TeamNameLink({
  team,
  tournament,
  className,
  crestSize = "sm",
  crestSide = "start",
}: {
  team: { id: string; name: string; crest?: string } | null;
  tournament: LiveSnapshot["tournament"];
  className?: string;
  crestSize?: CrestSize;
  /** Which edge carries the badge. The scoreline flanks the score with them
   * ("end" on the home side, "start" on the away side) so both badges sit
   * against the number; elsewhere the badge simply leads the name. */
  crestSide?: "start" | "end";
}): React.ReactElement {
  if (!team) return <span className={className}>{t("TBD")}</span>;
  const body = (
    <>
      {crestSide === "start" ? (
        <TeamCrest src={team.crest} name={team.name} size={crestSize} />
      ) : null}
      <span className="truncate group-hover:underline">{team.name}</span>
      {crestSide === "end" ? (
        <TeamCrest src={team.crest} name={team.name} size={crestSize} />
      ) : null}
    </>
  );
  const box = cn(
    "group flex min-w-0 items-center gap-2",
    crestSide === "end" ? "justify-end" : "justify-start",
  );
  if (!tournament) return <span className={cn(className, box)}>{body}</span>;
  return (
    <Link
      to={routes.publicTeam(tournament.slug, tournament.id, team.id)}
      className={cn(
        className,
        box,
        "rounded-md hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {body}
    </Link>
  );
}

function EmptyCard({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <section className="rounded-xl border border-border bg-card shadow-sm">
      <p className="px-5 py-8 text-center text-sm text-muted-foreground">
        {children}
      </p>
    </section>
  );
}

/** Reverse-chron event list with period markers (Timeline tab; the snapshot
 * already delivers newest-first). */
function EventList({
  events,
  match,
  limit,
}: {
  events: LiveSnapshot["events"];
  match: SnapMatch;
  limit?: number;
}): React.ReactElement {
  const rows = limit != null ? events.slice(0, limit) : events;
  const sideOf = (teamId: string | null): "home" | "away" | null =>
    teamId && teamId === match.home_team?.id
      ? "home"
      : teamId && teamId === match.away_team?.id
        ? "away"
        : null;
  return (
    <ol className="flex flex-col">
      {rows.map((e, i) => {
        const marker =
          limit == null && e.period && (i === 0 || rows[i - 1].period !== e.period);
        const side = sideOf(e.team_id);
        return (
          <Fragment key={e.sequence_no}>
            {marker ? (
              <li
                aria-hidden="true"
                className="border-t border-border bg-muted/50 px-4 py-1 text-center text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground first:border-t-0"
              >
                {humanizeKey(e.period)}
              </li>
            ) : null}
            <li className="flex items-start gap-3 border-t border-border px-4 py-2.5 text-sm first:border-t-0">
              <span className="w-9 shrink-0 pt-px text-right font-tabular text-xs text-muted-foreground">
                {e.minute != null ? `${e.minute}'` : ""}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  side === "home"
                    ? "bg-primary"
                    : side === "away"
                      ? "bg-info"
                      : "bg-muted-foreground/40",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="leading-snug">
                  <span className="font-medium">{t(humanizeKey(e.type))}</span>
                  {e.player ? (
                    <span className="text-muted-foreground"> · {e.player}</span>
                  ) : null}
                </p>
                {e.related_player ? (
                  <p className="text-xs text-muted-foreground">
                    {relLabel(e.type)} {e.related_player}
                  </p>
                ) : null}
              </div>
              {side ? (
                <span className="shrink-0 pt-px text-xs text-muted-foreground">
                  {side === "home"
                    ? (match.home_team?.short_name ?? "")
                    : (match.away_team?.short_name ?? "")}
                </span>
              ) : null}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** Mirrored home/away bars per stat row (token colors, no sport assumptions:
 * whatever the stats array contains is what renders). */
function StatsPanel({
  stats,
  match,
}: {
  stats: LiveStatRow[];
  match: SnapMatch;
}): React.ReactElement {
  if (stats.length === 0) {
    return <EmptyCard>{t("No match stats recorded yet.")}</EmptyCard>;
  }
  return (
    <section className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs font-medium">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-primary" />
          {match.home_team ? (
            <TeamCrest
              src={match.home_team.crest}
              name={match.home_team.name}
              size="xs"
            />
          ) : null}
          <span className="truncate">{match.home_team?.name ?? t("TBD")}</span>
        </span>
        <span className={OVERLINE}>{t("Match stats")}</span>
        <span className="inline-flex min-w-0 items-center justify-end gap-1.5">
          <span className="truncate">{match.away_team?.name ?? t("TBD")}</span>
          {match.away_team ? (
            <TeamCrest
              src={match.away_team.crest}
              name={match.away_team.name}
              size="xs"
            />
          ) : null}
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-info" />
        </span>
      </div>
      <div className="flex flex-col gap-3 p-4">
        {stats.map((s) => {
          const max = Math.max(s.home, s.away, 1);
          return (
            <div key={s.type} data-testid={`stat-${s.type}`}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-tabular font-semibold">{s.home}</span>
                <span className="text-xs text-muted-foreground">
                  {t(humanizeKey(s.type))}
                </span>
                <span className="font-tabular font-semibold">{s.away}</span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1">
                <div className="flex h-1.5 justify-end overflow-hidden rounded-full bg-muted">
                  <span
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(s.home / max) * 100}%` }}
                  />
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-info"
                    style={{ width: `${(s.away / max) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Prior meetings of the two teams, each linked to its own hub. */
function H2HList({
  h2h,
  match,
  timeZone,
}: {
  h2h: LiveH2HRow[];
  match: SnapMatch;
  timeZone: string;
}): React.ReactElement {
  /** A prior meeting only ever involves these two teams, so the snapshot's
   * own pair carries both the name and the badge. */
  const teamOf = (teamId: string): { name: string; crest?: string } =>
    teamId === match.home_team?.id
      ? match.home_team
      : teamId === match.away_team?.id
        ? match.away_team
        : { name: t("Unknown") };
  return (
    <ul className="flex flex-col divide-y divide-border">
      {h2h.map((row) => (
        <li key={row.id}>
          <Link
            to={routes.liveViewer(row.id)}
            data-testid={`h2h-row-${row.id}`}
            className="flex min-h-[44px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="w-20 shrink-0 font-tabular text-xs text-muted-foreground">
              {fmtDate(row.scheduled_at, timeZone) ?? ""}
            </span>
            <span className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
              <span className="flex min-w-0 items-center justify-end gap-1.5 font-medium">
                <TeamCrest
                  src={teamOf(row.home_team_id).crest}
                  name={teamOf(row.home_team_id).name}
                  size="xs"
                />
                <span className="truncate">{teamOf(row.home_team_id).name}</span>
              </span>
              <span className="font-tabular font-semibold">
                {row.status === "walkover"
                  ? t("W/O")
                  : `${row.home_score ?? 0} - ${row.away_score ?? 0}`}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 font-medium">
                <TeamCrest
                  src={teamOf(row.away_team_id).crest}
                  name={teamOf(row.away_team_id).name}
                  size="xs"
                />
                <span className="truncate">{teamOf(row.away_team_id).name}</span>
              </span>
            </span>
            {(row.set_scores?.length ?? 0) > 0 ? (
              <span className="hidden shrink-0 font-tabular text-xs text-muted-foreground sm:inline">
                {(row.set_scores ?? []).map(([h, a]) => `${h}-${a}`).join(" ")}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
/**
 * The shared match-snapshot fetch: the public snapshot, live over the
 * tournament SSE tick stream with a 60 s poll fallback, stopping for good once
 * the match is terminal. Both the hub page and the drawer mount it, so a
 * viewer who taps a row pays for exactly one match request either way.
 */
export function useMatchSnapshot(matchId: string): {
  query: ReturnType<typeof useQuery<LiveSnapshot>>;
  snap: LiveSnapshot | undefined;
  tournament: LiveSnapshot["tournament"];
  connected: boolean;
} {
  const qc = useQueryClient();
  // SSE connection state must feed the poll fallback, but the stream URL only
  // exists once the snapshot arrives: a ref breaks the cycle.
  const connectedRef = useRef(false);
  const query = useQuery({
    queryKey: ["live", matchId],
    queryFn: () => liveApi.snapshot(matchId),
    enabled: Boolean(matchId),
    refetchInterval: (q) => {
      const status = q.state.data?.match.status;
      if (status && TERMINAL_STATUSES.has(status)) return false;
      return connectedRef.current ? false : 60_000;
    },
  });

  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTick = useCallback(() => {
    if (tickTimer.current) return;
    tickTimer.current = setTimeout(() => {
      tickTimer.current = null;
      void qc.invalidateQueries({ queryKey: ["live", matchId] });
    }, 500);
  }, [qc, matchId]);
  useEffect(
    () => () => {
      if (tickTimer.current) clearTimeout(tickTimer.current);
    },
    [],
  );

  const snap = query.data;
  const terminal = snap ? TERMINAL_STATUSES.has(snap.match.status) : false;
  const tournament = snap?.tournament;
  const { connected } = useEventStream(
    tournament && !terminal
      ? liveApi.streamUrl(tournament.slug, tournament.id)
      : null,
    onTick,
  );
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  return { query, snap, tournament, connected };
}

/** Which tabs this match actually has anything to put in. */
export function visibleMatchTabs(
  snap: LiveSnapshot,
): { key: TabKey; label: string }[] {
  const isLive = LIVE_STATUSES.has(snap.match.status);
  const isFinal = FINAL_STATUSES.has(snap.match.status);
  return TABS.filter((tab) => {
    if (tab.key === "stats")
      return (snap.stats?.length ?? 0) > 0 || isLive || isFinal;
    if (tab.key === "h2h") return (snap.h2h?.length ?? 0) > 0;
    return true;
  });
}

/** The scoreline band: status, competition, both sides against the score. */
export function MatchScoreline({
  snap,
  dense = false,
}: {
  snap: LiveSnapshot;
  /** The drawer is narrower than a page and sits inside its own header. */
  dense?: boolean;
}): React.ReactElement {
  const match = snap.match;
  const tournament = snap.tournament;
  const tz = tournament?.time_zone ?? "UTC";
  const isLive = LIVE_STATUSES.has(match.status);
  const isFinal = FINAL_STATUSES.has(match.status);
  const setView = liveSetView(match);
  const finishedSets = setView ? setView.finished : (match.set_scores ?? []);
  const periodTerm = match.sport_meta?.terms.period ?? t("Set");
  const kickoff = fmtDateTime(match.scheduled_at, tz);
  const scored =
    (isLive || isFinal) && match.home_score != null && match.away_score != null;

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill status={match.status} />
        {isLive && (setView || match.current_period) ? (
          <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium capitalize text-primary">
            {setView
              ? `${periodTerm} ${setView.setNo}`
              : t(match.current_period.replace(/_/g, " "))}
          </span>
        ) : null}
        {/* One line. The chips wrapped four rows deep for a four-segment
            category and pushed the scoreboard down the page (owner
            2026-08-26). */}
        <span className="flex min-w-0 flex-nowrap items-center gap-1 overflow-hidden">
          <CompetitionChips match={match} />
        </span>
        <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {kickoff ?? ""}
          {match.venue ? `${kickoff ? " · " : ""}${match.venue}` : ""}
        </span>
      </div>

      <div
        aria-live="polite"
        className="grid grid-cols-[1fr_auto_1fr] items-center gap-3"
      >
        {/* The headline: a full-size badge against each side of the score,
            which stays centred and tabular between them. */}
        <TeamNameLink
          team={match.home_team}
          tournament={tournament}
          crestSize={dense ? "sm" : "lg"}
          crestSide="end"
          className={cn(
            "min-w-0 truncate text-right font-semibold",
            dense ? "text-sm sm:text-base" : "text-base sm:text-lg",
          )}
        />
        <div className="text-center">
          <div
            className={cn(
              "font-tabular font-semibold tabular-nums",
              dense ? "text-2xl sm:text-3xl" : "text-3xl sm:text-4xl",
            )}
          >
            {setView ? (
              <>
                {setView.points[0]}
                <span className="mx-1.5 text-muted-foreground">-</span>
                {setView.points[1]}
              </>
            ) : scored ? (
              <>
                {match.home_score}
                <span className="mx-1.5 text-muted-foreground">-</span>
                {match.away_score}
              </>
            ) : match.status === "walkover" ? (
              t("W/O")
            ) : (
              <span className={dense ? "text-xl" : "text-2xl sm:text-3xl"}>
                {fmtTime(match.scheduled_at, tz) ?? t("vs")}
              </span>
            )}
          </div>
          {setView ? (
            <p className="font-tabular text-xs text-muted-foreground">
              {t("Sets")} {setView.sets[0]}-{setView.sets[1]}
            </p>
          ) : null}
        </div>
        <TeamNameLink
          team={match.away_team}
          tournament={tournament}
          crestSize={dense ? "sm" : "lg"}
          crestSide="start"
          className={cn(
            "min-w-0 truncate text-left font-semibold",
            dense ? "text-sm sm:text-base" : "text-base sm:text-lg",
          )}
        />
      </div>

      {finishedSets.length > 0 ||
      (match.home_pens != null && match.away_pens != null) ? (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {finishedSets.map((s, i) => (
            <span
              key={i}
              className="rounded-md bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground"
            >
              {s[0]}-{s[1]}
            </span>
          ))}
          {match.home_pens != null && match.away_pens != null ? (
            <span className="font-tabular text-xs text-muted-foreground">
              {t("Pens")} {match.home_pens}-{match.away_pens}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The tab bar over the panels. */
export function MatchTabs({
  snap,
  active,
  onTab,
  className,
}: {
  snap: LiveSnapshot;
  active: TabKey;
  onTab: (key: TabKey) => void;
  className?: string;
}): React.ReactElement {
  return (
    <nav
      role="tablist"
      aria-label={t("Match sections")}
      className={cn(
        "flex gap-1 overflow-x-auto [scrollbar-width:none] snap-x snap-mandatory [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {visibleMatchTabs(snap).map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          id={`hub-tab-${tab.key}`}
          aria-selected={tab.key === active}
          aria-controls={`hub-panel-${tab.key}`}
          data-testid={`hub-tab-${tab.key}`}
          onClick={() => onTab(tab.key)}
          className={cn(
            "min-h-[44px] shrink-0 snap-start border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tab.key === active
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t(tab.label)}
        </button>
      ))}
    </nav>
  );
}

/** The body of ONE tab. Everything a viewer can know about the match lives in
 * one of these, so page and drawer show the same thing. */
export function MatchPanel({
  snap,
  tab,
  onTab,
}: {
  snap: LiveSnapshot;
  tab: TabKey;
  onTab: (key: TabKey) => void;
}): React.ReactElement {
  const match = snap.match;
  const tz = snap.tournament?.time_zone ?? "UTC";
  const stats = snap.stats ?? [];
  const h2h = snap.h2h ?? [];
  const events = snap.events ?? [];
  const kickoff = fmtDateTime(match.scheduled_at, tz);

  const sportKey = match.sport_meta?.key ?? (match.sport || "football");
  const family = match.sport_meta?.family ?? "timed";
  const lineupModule = resolveLineupView(sportKey, family);
  const homeSide = sideView(match.home_team, match.lineups?.home);
  const awaySide = sideView(match.away_team, match.lineups?.away);
  const hasSheets =
    (homeSide?.entries.length ?? 0) > 0 || (awaySide?.entries.length ?? 0) > 0;

  if (tab === "lineups") {
    return hasSheets ? (
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <lineupModule.Lineups home={homeSide} away={awaySide} />
      </section>
    ) : (
      <EmptyCard>{t("Team sheets are not yet announced.")}</EmptyCard>
    );
  }
  if (tab === "timeline") {
    return events.length > 0 ? (
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <EventList events={events} match={match} />
      </section>
    ) : (
      <EmptyCard>{t("No events yet.")}</EmptyCard>
    );
  }
  if (tab === "stats") return <StatsPanel stats={stats} match={match} />;
  if (tab === "h2h") {
    return (
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <H2HList h2h={h2h} match={match} timeZone={tz} />
      </section>
    );
  }
  return (
    <>
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <h2 className={OVERLINE}>{t("Match info")}</h2>
        </div>
        <dl className="flex flex-col gap-2 px-4 py-3 text-sm">
          <div className="flex items-center gap-2">
            <dt className="w-24 shrink-0 text-xs text-muted-foreground">
              {t("Kick off")}
            </dt>
            <dd className="font-tabular font-medium">
              {kickoff ?? t("Time to be confirmed")}
            </dd>
          </div>
          {match.venue ? (
            <div className="flex items-center gap-2">
              <dt className="w-24 shrink-0 text-xs text-muted-foreground">
                {t("Venue")}
              </dt>
              <dd className="font-medium">{match.venue}</dd>
            </div>
          ) : null}
          {/* No Competition row: the header names it, and repeating it here
              printed the same four chips a second time (owner 2026-08-26). */}
        </dl>
      </section>

      {/* Who is actually playing. On the hub it is a tab away; a viewer who
          opened ONE match came for exactly this, so the drawer and the page
          both lead the overview with it once a sheet is confirmed. */}
      {hasSheets ? (
        <section className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className={OVERLINE}>{t("Participants")}</h2>
            <button
              type="button"
              onClick={() => onTab("lineups")}
              className="min-h-[44px] rounded-md px-2 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("Full team sheets")}
            </button>
          </div>
          <lineupModule.Lineups home={homeSide} away={awaySide} />
        </section>
      ) : null}

      {/* No "Score by game" section: the finished sets already sit under the
          scoreboard above, and printing them twice was the biggest source of
          stacking on this page (owner 2026-08-26). */}
      {events.length > 0 ? (
        <section className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className={OVERLINE}>{t("Latest events")}</h2>
            <button
              type="button"
              onClick={() => onTab("timeline")}
              className="min-h-[44px] rounded-md px-2 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("Full timeline")}
            </button>
          </div>
          <EventList events={events} match={match} limit={3} />
        </section>
      ) : null}

      {h2h.length > 0 ? (
        <section className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className={OVERLINE}>{t("Head to head")}</h2>
            <button
              type="button"
              onClick={() => onTab("h2h")}
              className="min-h-[44px] rounded-md px-2 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {h2h.length === 1
                ? t("1 previous meeting")
                : `${h2h.length} ${t("previous meetings")}`}
            </button>
          </div>
          <H2HList h2h={h2h.slice(0, 1)} match={match} timeZone={tz} />
        </section>
      ) : null}
    </>
  );
}
