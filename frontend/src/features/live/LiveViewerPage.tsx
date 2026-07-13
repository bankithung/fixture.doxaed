import { Fragment, useCallback, useEffect, useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  liveApi,
  type LiveH2HRow,
  type LiveSnapshot,
  type LiveStatRow,
} from "@/api/live";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { routes } from "@/lib/routes";
import { isSetSport, liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useEventStream } from "@/lib/useEventStream";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { ShareButton } from "./ShareButton";
import { sideView } from "./lineups/adapter";
import { resolveLineupView } from "./lineups/registry";

const OVERLINE =
  "text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground";

const LIVE_STATUSES = new Set(["live", "half_time", "extra_time", "penalties"]);
const FINAL_STATUSES = new Set(["completed", "walkover"]);
/** A shared link to a finished match should not refetch forever. */
const TERMINAL_STATUSES = new Set(["completed", "walkover", "cancelled"]);

type SnapMatch = LiveSnapshot["match"];

type TabKey = "overview" | "lineups" | "timeline" | "stats" | "h2h";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "lineups", label: "Lineups" },
  { key: "timeline", label: "Timeline" },
  { key: "stats", label: "Stats" },
  { key: "h2h", label: "Head to head" },
];

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

function LivePulse(): React.ReactElement {
  return (
    <span className="relative flex h-2 w-2" data-testid="live-pulse">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
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
function CompetitionChips({ match }: { match: SnapMatch }): React.ReactElement | null {
  const segs = (match.leaf_key ?? "").split(".").filter(Boolean);
  const sportChip = match.sport_meta?.name ?? (segs[0] ? humanizeSeg(segs[0]) : "");
  const rest = segs.slice(1).map(humanizeSeg);
  const group = match.group_label ?? "";
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

function fmtTime(iso: string | null | undefined, tz: string): string | null {
  return fmtInTz(iso, tz, { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtDateTime(iso: string | null | undefined, tz: string): string | null {
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

function TeamNameLink({
  team,
  tournament,
  className,
}: {
  team: { id: string; name: string } | null;
  tournament: LiveSnapshot["tournament"];
  className?: string;
}): React.ReactElement {
  if (!team) return <span className={className}>{t("TBD")}</span>;
  if (!tournament) return <span className={className}>{team.name}</span>;
  return (
    <Link
      to={routes.publicTeam(tournament.slug, tournament.id, team.id)}
      className={cn(
        className,
        "rounded-md hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {team.name}
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
          <span className="truncate">{match.home_team?.name ?? t("TBD")}</span>
        </span>
        <span className={OVERLINE}>{t("Match stats")}</span>
        <span className="inline-flex min-w-0 items-center justify-end gap-1.5">
          <span className="truncate">{match.away_team?.name ?? t("TBD")}</span>
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
  const nameOf = (teamId: string): string =>
    teamId === match.home_team?.id
      ? match.home_team.name
      : teamId === match.away_team?.id
        ? match.away_team.name
        : t("Unknown");
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
              <span className="truncate text-right font-medium">
                {nameOf(row.home_team_id)}
              </span>
              <span className="font-tabular font-semibold">
                {row.status === "walkover"
                  ? t("W/O")
                  : `${row.home_score ?? 0} - ${row.away_score ?? 0}`}
              </span>
              <span className="truncate font-medium">
                {nameOf(row.away_team_id)}
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
 * Public match hub at /m/:id (no login): Google-sports-panel-grade match
 * page. Sticky scoreline header + deep-linked tabs (Overview / Lineups /
 * Timeline / Stats / H2H); per-sport lineup visuals via the view registry;
 * live over the tournament SSE tick stream with a 60s poll fallback.
 */
export function LiveViewerPage(): React.ReactElement {
  const { matchId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();

  // SSE connection state must feed the poll fallback, but the stream URL only
  // exists once the snapshot arrives: a ref breaks the cycle.
  const connectedRef = useRef(false);
  const query = useQuery({
    queryKey: ["live", matchId],
    queryFn: () => liveApi.snapshot(matchId),
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

  useEffect(() => {
    if (!snap) return;
    const m = snap.match;
    const home = m.home_team?.name ?? t("TBD");
    const away = m.away_team?.name ?? t("TBD");
    const scored =
      (LIVE_STATUSES.has(m.status) || FINAL_STATUSES.has(m.status)) &&
      m.home_score != null &&
      m.away_score != null;
    const mid = scored ? `${m.home_score} - ${m.away_score}` : t("vs");
    document.title = `${home} ${mid} ${away} · ${snap.tournament?.name ?? t("Fixture")}`;
  }, [snap]);

  const match = snap?.match;
  const stats = snap?.stats ?? [];
  const h2h = snap?.h2h ?? [];
  const events = snap?.events ?? [];
  const tz = tournament?.time_zone ?? "UTC";
  const isLive = match ? LIVE_STATUSES.has(match.status) : false;
  const isFinal = match ? FINAL_STATUSES.has(match.status) : false;

  const visibleTabs = TABS.filter((tab) => {
    if (tab.key === "stats") return stats.length > 0 || isLive || isFinal;
    if (tab.key === "h2h") return h2h.length > 0;
    return true;
  });
  const requested = searchParams.get("tab") ?? "overview";
  const active: TabKey = visibleTabs.some((tab) => tab.key === requested)
    ? (requested as TabKey)
    : "overview";
  const setTab = useCallback(
    (key: TabKey) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (key === "overview") p.delete("tab");
          else p.set("tab", key);
          return p;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const header = (
    <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 sm:px-6 lg:px-8">
      <Link
        to={routes.landing()}
        className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <BrandLogo className="h-7 w-7 rounded-lg" />
        {t("Fixture")}
      </Link>
      {tournament ? (
        <Link
          to={routes.publicSchedule(tournament.slug, tournament.id)}
          data-testid="hub-tournament-link"
          className="ml-1 min-w-0 truncate rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {tournament.name}
        </Link>
      ) : null}
      {connected ? (
        <span
          className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-medium text-success"
          data-testid="live-connected"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          {t("Live updates")}
        </span>
      ) : (
        <span className="ml-auto" />
      )}
      <ShareButton
        title={
          match
            ? `${match.home_team?.name ?? t("TBD")} ${t("vs")} ${match.away_team?.name ?? t("TBD")}`
            : undefined
        }
      />
      <ThemeToggle />
    </header>
  );

  if (query.isLoading) {
    return (
      <div className="flex min-h-screen flex-col">
        {header}
        <main className="flex w-full flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <div className="h-40 animate-pulse rounded-xl border border-border bg-card" />
          <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
        </main>
      </div>
    );
  }
  if (query.isError || !snap || !match) {
    return (
      <div className="flex min-h-screen flex-col">
        {header}
        <main className="flex w-full flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-6 text-center">
            <p role="alert" className="text-sm text-destructive">
              {t("This match could not be loaded.")}
            </p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="min-h-[44px] rounded-md border border-border px-4 py-1.5 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("Retry")}
            </button>
          </div>
        </main>
      </div>
    );
  }

  const setView = liveSetView(match);
  const finishedSets = setView ? setView.finished : (match.set_scores ?? []);
  const kickoff = fmtDateTime(match.scheduled_at, tz);
  const periodTerm = match.sport_meta?.terms.period ?? t("Set");
  const scored = (isLive || isFinal) && match.home_score != null && match.away_score != null;

  const sportKey = match.sport_meta?.key ?? (match.sport || "football");
  const family = match.sport_meta?.family ?? "timed";
  const lineupModule = resolveLineupView(sportKey, family);
  const homeSide = sideView(match.home_team, match.lineups?.home);
  const awaySide = sideView(match.away_team, match.lineups?.away);
  const hasSheets =
    (homeSide?.entries.length ?? 0) > 0 || (awaySide?.entries.length ?? 0) > 0;

  const panels: Record<TabKey, React.ReactNode> = {
    overview: (
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
            <div className="flex items-center gap-2">
              <dt className="w-24 shrink-0 text-xs text-muted-foreground">
                {t("Competition")}
              </dt>
              <dd>
                <CompetitionChips match={match} />
              </dd>
            </div>
          </dl>
        </section>

        {isSetSport(match) && (match.set_scores?.length ?? 0) > 0 ? (
          <section className="rounded-xl border border-border bg-card shadow-sm">
            <div className="border-b border-border px-4 py-3">
              <h2 className={OVERLINE}>{t("Score by")} {periodTerm.toLowerCase()}</h2>
            </div>
            <ul className="flex flex-col divide-y divide-border">
              {(match.set_scores ?? []).map((s, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between px-4 py-2 text-sm"
                >
                  <span className="text-xs text-muted-foreground">
                    {periodTerm} {i + 1}
                  </span>
                  <span className="font-tabular">
                    <span className={cn((s[0] ?? 0) > (s[1] ?? 0) && "font-semibold")}>
                      {s[0] ?? 0}
                    </span>
                    <span className="mx-1.5 text-muted-foreground">-</span>
                    <span className={cn((s[1] ?? 0) > (s[0] ?? 0) && "font-semibold")}>
                      {s[1] ?? 0}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {events.length > 0 ? (
          <section className="rounded-xl border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className={OVERLINE}>{t("Latest events")}</h2>
              <button
                type="button"
                onClick={() => setTab("timeline")}
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
                onClick={() => setTab("h2h")}
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
    ),
    lineups: hasSheets ? (
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <lineupModule.Lineups home={homeSide} away={awaySide} />
      </section>
    ) : (
      <EmptyCard>{t("Team sheets are not yet announced.")}</EmptyCard>
    ),
    timeline:
      events.length > 0 ? (
        <section className="rounded-xl border border-border bg-card shadow-sm">
          <EventList events={events} match={match} />
        </section>
      ) : (
        <EmptyCard>{t("No events yet.")}</EmptyCard>
      ),
    stats: <StatsPanel stats={stats} match={match} />,
    h2h: (
      <section className="rounded-xl border border-border bg-card shadow-sm">
        <H2HList h2h={h2h} match={match} timeZone={tz} />
      </section>
    ),
  };

  return (
    <div className="flex min-h-screen flex-col">
      {header}

      {/* Sticky scoreline band + tab bar (Google-style: always in view). */}
      <div className="sticky top-0 z-10 border-b border-border bg-card shadow-sm">
        <div className="flex w-full flex-col gap-1.5 px-4 pt-2.5 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusPill status={match.status} />
            {isLive && (setView || match.current_period) ? (
              <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium capitalize text-primary">
                {setView
                  ? `${periodTerm} ${setView.setNo}`
                  : t(match.current_period.replace(/_/g, " "))}
              </span>
            ) : null}
            <CompetitionChips match={match} />
            <span className="ml-auto text-xs text-muted-foreground">
              {kickoff ?? ""}
              {match.venue ? `${kickoff ? " · " : ""}${match.venue}` : ""}
            </span>
          </div>

          <div
            aria-live="polite"
            className="grid grid-cols-[1fr_auto_1fr] items-center gap-3"
          >
            <TeamNameLink
              team={match.home_team}
              tournament={tournament}
              className="min-w-0 truncate text-right text-base font-semibold sm:text-lg"
            />
            <div className="text-center">
              <div className="font-tabular text-3xl font-semibold tabular-nums sm:text-4xl">
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
                  <span className="text-2xl sm:text-3xl">
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
              className="min-w-0 truncate text-left text-base font-semibold sm:text-lg"
            />
          </div>

          {finishedSets.length > 0 || (match.home_pens != null && match.away_pens != null) ? (
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

          <nav
            role="tablist"
            aria-label={t("Match sections")}
            className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] snap-x snap-mandatory [&::-webkit-scrollbar]:hidden sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
          >
            {visibleTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                id={`hub-tab-${tab.key}`}
                aria-selected={tab.key === active}
                aria-controls={`hub-panel-${tab.key}`}
                data-testid={`hub-tab-${tab.key}`}
                onClick={() => setTab(tab.key)}
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
        </div>
      </div>

      <main
        role="tabpanel"
        id={`hub-panel-${active}`}
        aria-labelledby={`hub-tab-${active}`}
        data-testid={`hub-panel-${active}`}
        className="flex w-full flex-1 flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8"
      >
        {panels[active]}
        {isLive || isFinal ? (
          <p className="text-center text-xs text-muted-foreground">
            {isLive ? t("Updates automatically.") : t("Final result.")}
          </p>
        ) : null}
      </main>
    </div>
  );
}
