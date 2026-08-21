import { useEffect } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  tournamentsApi,
  type PublicScheduleMatch,
} from "@/api/tournaments";
import { WatchLiveLink } from "./WatchLiveLink";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { ShareButton } from "./ShareButton";
import {
  FINAL_STATUSES,
  LIVE_STATUSES,
  MatchPanel,
  MatchScoreline,
  MatchTabs,
  OVERLINE,
  fmtTime,
  useMatchSnapshot,
  visibleMatchTabs,
  type SnapMatch,
  type TabKey,
} from "./MatchDetail";

/**
 * What this court does next (owner 2026-08-13). Once a match is over its score
 * is the answer to a question the viewer already has; the one they don't is
 * "what's on now?" — and on a stream the camera has not moved, so the same
 * court is about to start another game. Same venue wins, then the same
 * competition. Slots that passed without ever starting sort in behind the
 * genuinely upcoming ones rather than posing as next.
 */
function pickNextMatch(
  all: PublicScheduleMatch[],
  match: SnapMatch,
  nowIso: string,
): PublicScheduleMatch | null {
  const waiting = all
    .filter(
      (m) =>
        m.id !== match.id &&
        m.scheduled_at &&
        !FINAL_STATUSES.has(m.status) &&
        !LIVE_STATUSES.has(m.status),
    )
    .sort((a, b) => ((a.scheduled_at ?? "") < (b.scheduled_at ?? "") ? -1 : 1));
  const upcoming = waiting.filter((m) => (m.scheduled_at ?? "") >= nowIso);
  const pool = upcoming.length > 0 ? upcoming : waiting;
  const sameVenue = match.venue
    ? pool.find((m) => m.venue === match.venue)
    : undefined;
  return sameVenue ?? pool.find((m) => m.leaf_key === match.leaf_key) ?? null;
}

function UpNextCard({
  next,
  timeZone,
}: {
  next: PublicScheduleMatch;
  timeZone: string;
}): React.ReactElement {
  return (
    <section
      data-testid="up-next-card"
      className="rounded-xl border border-border bg-card shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className={OVERLINE}>{t("Up next")}</h2>
        <span className="ml-auto text-xs text-muted-foreground">
          {fmtTime(next.scheduled_at, timeZone) ?? ""}
          {next.venue ? ` · ${next.venue}` : ""}
        </span>
      </div>
      <Link
        to={routes.liveViewer(next.id)}
        data-testid="up-next-link"
        className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-4 py-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-center justify-end gap-1.5 text-sm font-semibold">
          {next.home ? (
            <TeamCrest src={next.home.crest} name={next.home.name} size="xs" />
          ) : null}
          <span className="truncate">{next.home?.name ?? t("TBD")}</span>
        </span>
        <span className="text-xs text-muted-foreground">{t("vs")}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          {next.away ? (
            <TeamCrest src={next.away.crest} name={next.away.name} size="xs" />
          ) : null}
          <span className="truncate">{next.away?.name ?? t("TBD")}</span>
        </span>
      </Link>
    </section>
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
  const { query, snap, tournament, connected } = useMatchSnapshot(matchId);

  // The "Watch live" target. The live snapshot does not carry one, so it comes
  // from the public schedule — deliberately on the SAME query key (and stale
  // time) the public schedule page uses, so a viewer who tapped through from
  // the schedule pays nothing at all for it. Never rendered when the resolver
  // returned null; the score below keeps ticking on its own SSE stream either
  // way. (A `watch_url` on `/api/live/match/{id}/` would remove this fetch.)
  const watchQ = useQuery({
    queryKey: ["public-schedule", tournament?.slug ?? "", tournament?.id ?? ""],
    queryFn: () => tournamentsApi.publicSchedule(tournament!.slug, tournament!.id),
    enabled: Boolean(tournament?.slug && tournament?.id),
    staleTime: 30_000,
    retry: false,
  });
  const watchUrl =
    watchQ.data?.matches.find((m) => m.id === matchId)?.watch_url ?? null;

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
  const tz = tournament?.time_zone ?? "UTC";
  const isLive = match ? LIVE_STATUSES.has(match.status) : false;
  const isFinal = match ? FINAL_STATUSES.has(match.status) : false;

  // Off the schedule this page already fetched for the Watch live link, so
  // pointing at the next match costs no extra request.
  const nextMatch =
    match && isFinal
      ? pickNextMatch(
          watchQ.data?.matches ?? [],
          match,
          new Date().toISOString(),
        )
      : null;

  const visibleTabs = snap ? visibleMatchTabs(snap) : [];
  const requested = searchParams.get("tab") ?? "overview";
  const active: TabKey = visibleTabs.some((tab) => tab.key === requested)
    ? (requested as TabKey)
    : "overview";
  const setTab = (key: TabKey): void => {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (key === "overview") p.delete("tab");
        else p.set("tab", key);
        return p;
      },
      { replace: true },
    );
  };

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
      <WatchLiveLink
        url={watchUrl}
        className="shrink-0"
        label={t("Watch this match live on YouTube")}
      />
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

  return (
    <div className="flex min-h-screen flex-col">
      {header}

      {/* Sticky scoreline band + tab bar (Google-style: always in view). */}
      <div className="sticky top-0 z-10 border-b border-border bg-card shadow-sm">
        <div className="flex w-full flex-col gap-1.5 px-4 pt-2.5 sm:px-6 lg:px-8">
          <MatchScoreline snap={snap} />
          <MatchTabs
            snap={snap}
            active={active}
            onTab={setTab}
            className="-mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
          />
        </div>
      </div>

      <main
        role="tabpanel"
        id={`hub-panel-${active}`}
        aria-labelledby={`hub-tab-${active}`}
        data-testid={`hub-panel-${active}`}
        className="flex w-full flex-1 flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8"
      >
        {/* Directly under the scoreline, above the tab's own content: the
            match is done, so the next thing on this court leads. */}
        {nextMatch ? <UpNextCard next={nextMatch} timeZone={tz} /> : null}
        <MatchPanel snap={snap} tab={active} onTab={setTab} />
        {isLive || isFinal ? (
          <p className="text-center text-xs text-muted-foreground">
            {isLive ? t("Updates automatically.") : t("Final result.")}
          </p>
        ) : null}
      </main>
    </div>
  );
}
