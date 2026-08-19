import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CalendarDays,
  Clock,
  ListOrdered,
  Printer,
  Search,
  Star,
  Trophy,
  X,
} from "lucide-react";
import { useFollows } from "@/lib/follows";
import { type PublicScheduleMatch } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import { PublicLeaders } from "@/features/live/PublicLeaders";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { routes } from "@/lib/routes";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { TeamCrest, type CrestSize } from "@/components/ui/TeamCrest";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { PublicViewerTabs } from "@/features/live/PublicViewerHeader";
import {
  FINAL_STATUSES,
  LIVE_STATUSES,
  buildCompetitions,
  shortGroup,
  splitLabel,
  usePublicTournament,
  type Competition,
} from "./publicTournament";
import { GroupTable, LabelChips } from "./publicTournamentViews";

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

/** A team's crest + name, linked to its page. Every public row that names a
 * team goes through here, so the badge a parent scans for is the same one on
 * the list, the live band and the follow band. A TBD side has no team yet, so
 * it gets neither crest nor link. */
function TeamName({
  side,
  className,
  crestSize = "xs",
}: {
  side: { id: string; name: string; crest?: string } | null | undefined;
  className?: string;
  /** Scales with the surface: rows stay "xs", the live hero goes large. */
  crestSize?: CrestSize;
}): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  if (!side) return <span className={className}>{t("TBD")}</span>;
  return (
    <Link
      to={routes.publicTeam(slug, id, side.id)}
      // Sits above the row's stretched match link (which covers the row), so
      // a team name still opens that team's page. `w-fit` keeps the link only
      // as wide as its content, leaving the rest of the row to that link.
      className={cn(
        className,
        "group pointer-events-auto relative z-10 flex w-fit max-w-full items-center gap-1.5 hover:text-primary",
      )}
    >
      <TeamCrest src={side.crest} name={side.name} size={crestSize} />
      {/* Truncation lives on the name, not the row: the crest never shrinks. */}
      <span className="truncate group-hover:underline">{side.name}</span>
    </Link>
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
  const setView = liveSetView(match);
  // Chips show completed sets; the running set IS the headline while live.
  const sets = setView ? setView.finished : (match.set_scores ?? []);
  const hasPens = match.home_pens != null && match.away_pens != null;
  const showTime = labels !== "slot";
  const showLeaf = labels === "full" || labels === "slot";
  const group =
    labels !== "none" ? shortGroup(match.group_label, match.leaf_label) : "";
  return (
    <li
      data-testid={`public-match-${match.id}`}
      className={cn(
        "relative flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-accent focus-within:bg-accent",
        live && "border-l-2 border-primary",
      )}
    >
      {/* Stretched link: the WHOLE row opens the match centre (line-ups,
          court view, timeline). The team names sit above it and still go to
          their own pages — no nested anchors. */}
      <Link
        to={routes.liveViewer(match.id)}
        aria-label={`${match.home?.name ?? t("TBD")} ${t("vs")} ${match.away?.name ?? t("TBD")}`}
        className="absolute inset-0 z-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />
      <div className="pointer-events-none relative z-10 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
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
          {/* Above the row's stretched match link (which covers the row), so
              this opens YouTube instead of the match centre. */}
          <WatchLiveLink
            url={match.watch_url}
            variant="ghost"
            className="pointer-events-auto relative z-10 h-6 px-1.5 text-[0.6875rem] text-primary hover:bg-primary/10"
            testid={`watch-live-${match.id}`}
            label={t("Watch this match live on YouTube")}
          />
          {live && (setView || match.current_period) ? (
            <span
              data-testid={`period-${match.id}`}
              className="rounded-md bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium capitalize text-primary"
            >
              {setView
                ? `${t("Set")} ${setView.setNo}`
                : t(match.current_period.replace(/_/g, " "))}
            </span>
          ) : null}
          <StatusPill status={match.status} />
        </span>
      </div>
      <div className="relative z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-sm">
        <TeamName side={match.home} className="truncate text-right font-medium" />
        <span
          className={cn(
            "pointer-events-none px-1 text-center font-tabular",
            done ? "font-semibold" : "text-xs text-muted-foreground",
          )}
        >
          {/* ASCII hyphen, not en/em dash: a scoreboard separator, not a label.
              Live set sport: the CURRENT SET's points headline the row. */}
          {done
            ? setView
              ? `${setView.points[0]} - ${setView.points[1]}`
              : `${match.home_score ?? 0} - ${match.away_score ?? 0}`
            : t("vs")}
        </span>
        <TeamName side={match.away} className="truncate font-medium" />
      </div>
      {done && (sets.length > 0 || hasPens || setView) ? (
        <p
          data-testid={`points-${match.id}`}
          className="pointer-events-none relative z-10 text-center font-tabular text-xs text-muted-foreground"
        >
          {setView ? `${t("Sets")} ${setView.sets[0]}-${setView.sets[1]}` : ""}
          {setView && sets.length > 0 ? " · " : ""}
          {sets.map(([h, a]) => `${h}-${a}`).join(" · ")}
          {(setView || sets.length > 0) && hasPens ? " · " : ""}
          {hasPens
            ? `(${match.home_pens}-${match.away_pens} ${t("pens")})`
            : ""}
        </p>
      ) : null}
    </li>
  );
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
 * buried, and pinned regardless of which competition/day is selected. Each
 * match renders as the scorer console's scoreboard (big centered tabular
 * score, status pill, Set N · Sets line, finished-set chips) so the public
 * band and the console read as the same product surface. */
/** Follow v1 (P6): the viewer's starred teams pin their next and live
 * matches above the day lists. Follows are device-local (no login). */
function FollowedBand({
  matches,
  timeZone,
}: {
  matches: PublicScheduleMatch[];
  timeZone: string;
}): React.ReactElement | null {
  const follows = useFollows();
  if (follows.length === 0) return null;
  const followed = new Set(follows);
  const mine = matches
    .filter(
      (m) =>
        (m.home && followed.has(m.home.id)) ||
        (m.away && followed.has(m.away.id)),
    )
    .filter((m) => !FINAL_STATUSES.has(m.status))
    .slice(0, 6);
  if (mine.length === 0) return null;
  return (
    <section
      data-testid="followed-band"
      className="border-b border-border bg-card"
    >
      <p className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
        <Star aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
        {t("Following")}
      </p>
      <ul className="divide-y divide-border">
        {mine.map((m) => (
          <MatchCard key={m.id} match={m} timeZone={timeZone} />
        ))}
      </ul>
    </section>
  );
}


function LiveBand({
  matches,
  timeZone,
}: {
  matches: PublicScheduleMatch[];
  timeZone: string;
}): React.ReactElement | null {
  if (matches.length === 0) return null;
  const single = matches.length === 1;
  return (
    <section
      data-testid="live-band"
      className="flex flex-col gap-2 border-b border-border bg-card p-3 sm:p-4"
    >
      <div className="flex items-center gap-2">
        <LivePulse />
        <h2 className="text-sm font-semibold">{t("Now playing")}</h2>
        <span className="font-tabular text-xs text-muted-foreground">
          {matches.length}
        </span>
      </div>
      <div className={cn("grid gap-3", !single && "lg:grid-cols-2")}>
        {matches.map((m) => {
          const sv = liveSetView(m);
          const sm = statusMeta(m.status);
          const score: [number, number] = sv
            ? sv.points
            : [m.home_score ?? 0, m.away_score ?? 0];
          const hasPens = m.home_pens != null && m.away_pens != null;
          return (
            <div
              key={m.id}
              data-testid={`live-tile-${m.id}`}
              className="relative overflow-hidden rounded-xl border border-border bg-card shadow-sm"
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -right-20 -top-20 h-48 w-48 rounded-full bg-primary/10 blur-3xl"
              />
              <div className="relative flex flex-col items-center gap-3 px-4 py-6 sm:px-6">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
                    sm.cls,
                  )}
                >
                  <LivePulse />
                  {t(sm.label)}
                  {/* Football periods never describe a set sport; its pill
                      relies on the Set N line under the score. */}
                  {!sv && m.current_period ? (
                    <span className="capitalize text-muted-foreground">
                      · {t(m.current_period.replace(/_/g, " "))}
                    </span>
                  ) : null}
                </span>

                {/* One column on a phone (a 4xl score between two shrinking
                    name cells collided at 390px), three from `sm` up. */}
                <div className="grid w-full max-w-xl grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr] sm:gap-6">
                  <div className="min-w-0 text-center sm:text-right">
                    {/* The hero of the whole page: a full-size badge either
                        side of the score, centred on a phone and hugging the
                        score from `sm` up. */}
                    <TeamName
                      side={m.home}
                      crestSize="lg"
                      className="mx-auto truncate text-sm font-medium sm:mx-0 sm:ml-auto sm:text-base"
                    />
                    <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                      {t("Home")}
                    </div>
                  </div>
                  <div className="text-center">
                    <Link
                      to={routes.liveViewer(m.id)}
                      aria-label={t("Open the match centre")}
                      className={cn(
                        "block rounded-md px-1 font-tabular font-semibold tabular-nums transition-colors hover:text-primary",
                        single ? "text-4xl sm:text-6xl" : "text-4xl sm:text-5xl",
                      )}
                    >
                      {score[0]}
                      <span className="px-2 text-muted-foreground">-</span>
                      {score[1]}
                    </Link>
                    {sv ? (
                      <p className="mt-1 font-tabular text-sm text-muted-foreground">
                        {t("Set")} {sv.setNo} · {t("Sets")} {sv.sets[0]}-{sv.sets[1]}
                      </p>
                    ) : null}
                  </div>
                  <div className="min-w-0 text-center sm:text-left">
                    <TeamName
                      side={m.away}
                      crestSize="lg"
                      className="mx-auto truncate text-sm font-medium sm:mx-0 sm:mr-auto sm:text-base"
                    />
                    <div className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                      {t("Away")}
                    </div>
                  </div>
                </div>

                {sv && sv.finished.length > 0 ? (
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {sv.finished.map((s, i) => (
                      <span
                        key={i}
                        className="rounded-md bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground"
                      >
                        {s[0]}-{s[1]}
                      </span>
                    ))}
                  </div>
                ) : null}

                {hasPens ? (
                  <p className="font-tabular text-xs text-muted-foreground">
                    {t("Pens")} {m.home_pens}-{m.away_pens}
                  </p>
                ) : null}

                {/* The score keeps ticking behind it — this opens a new tab. */}
                <WatchLiveLink
                  url={m.watch_url}
                  testid={`watch-live-tile-${m.id}`}
                  label={t("Watch this match live on YouTube")}
                />

                <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <LabelChips label={m.leaf_label} />
                  <span className="font-tabular">
                    {fmtKickoff(m.scheduled_at, timeZone)}
                  </span>
                  {m.venue ? <span>· {m.venue}</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** What follows the live game (owner 2026-08-13). A finished match empties the
 * live band on the next tick, and the question a viewer has at that moment is
 * "what's on now?" — so the answer sits directly under it. Scoped like every
 * other band: the open category's next matches, or the tournament's on Today.
 * Matches whose slot has already passed but never started fall back in below
 * the genuinely upcoming ones rather than posing as next. */
function UpNextBand({
  matches,
  timeZone,
}: {
  matches: PublicScheduleMatch[];
  timeZone: string;
}): React.ReactElement | null {
  const next = useMemo(() => {
    const now = new Date().toISOString();
    const waiting = matches
      .filter(
        (m) =>
          m.scheduled_at &&
          !FINAL_STATUSES.has(m.status) &&
          !LIVE_STATUSES.has(m.status),
      )
      .sort((a, b) => ((a.scheduled_at ?? "") < (b.scheduled_at ?? "") ? -1 : 1));
    const upcoming = waiting.filter((m) => (m.scheduled_at ?? "") >= now);
    return (upcoming.length > 0 ? upcoming : waiting).slice(0, 3);
  }, [matches]);

  if (next.length === 0) return null;
  return (
    <section data-testid="upnext-band" className="border-b border-border bg-card">
      <p className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <Clock aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Up next")}
      </p>
      <ul className="divide-y divide-border">
        {next.map((m) => (
          <MatchCard key={m.id} match={m} timeZone={timeZone} />
        ))}
      </ul>
    </section>
  );
}

/** Every group table of one competition, side by side and directly under the
 * live band (owner 2026-08-13): the whole category's standings read in one
 * glance instead of one table per screen with a fixture list between them.
 * The fixtures still live under their own group heading further down. */
function CompetitionTables({
  comp,
}: {
  comp: Competition;
}): React.ReactElement | null {
  const tables = comp.groups.filter((g) => (g.standing?.rows.length ?? 0) > 0);
  if (tables.length === 0) return null;
  return (
    <section
      data-testid={`public-tables-${comp.key}`}
      className="border-b border-border bg-card"
    >
      <p className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        <ListOrdered aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Standings")}
      </p>
      {/* Two per row and no more (owner 2026-08-13): a third column squeezes
          "Dimapur Government Higher Secondary School" into an ellipsis. */}
      <div className="grid grid-cols-1 gap-3 p-3 sm:p-4 md:grid-cols-2">
        {tables.map((g) => (
          <div
            key={g.key}
            data-testid={`public-table-${comp.key}-${g.key}`}
            className="flex flex-col overflow-hidden rounded-lg border border-border"
          >
            <h3 className="border-b border-border px-4 py-2 text-sm font-semibold">
              {g.label}
            </h3>
            <GroupTable rows={g.standing!.rows} family={comp.family} />
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
      // A solid surface: with only a right border the page background showed
      // straight through and the rail read as transparent (owner 2026-07-26).
      // The column is a solid full-height surface (`self-stretch`); the nav
      // content inside it is what scrolls and sticks.
      className="hidden w-72 shrink-0 self-stretch border-r border-border lg:block"
    >
      <div className="sticky top-0 max-h-screen overflow-y-auto pb-4">
      <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2.5">
        <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {t("Competitions")}
        </span>
      </div>
      <div className="pt-2">{todayBtn}</div>
      {sports.map((s) => (
        <div key={s.sport} className="mt-1 flex flex-col">
          <span className="px-4 pb-1 pt-2.5 text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {s.sport}
          </span>
          {s.comps.map(compBtn)}
        </div>
      ))}
      </div>
    </nav>
  );
}

/** One competition's fixtures, un-collapsed, under their group heading. The
 * tables themselves sit above in `CompetitionTables` (all of them together);
 * repeating each one over its own fixture list only pushed the next group off
 * the screen. The panel is one surface; groups are hairline units. */
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
    // A group with no fixture left to show is now an empty card: its table
    // already stands above, so there is nothing here to render.
    .filter((g) => g.shown.length > 0);
  if (groups.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        {t("No matches match these filters.")}
      </p>
    );
  }
  return (
    <div
      data-testid={`public-competition-${comp.key}`}
      className="grid grid-cols-1 gap-x-6 gap-y-4 p-3 sm:p-4 xl:grid-cols-2"
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
          <ul className="divide-y divide-border">
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
                  {/* Crests print too (owner ask): they are real <img>, and a
                      teamless side keeps its plain "TBD" so the column never
                      grows a badge for nobody. */}
                  <td className="border-b border-border py-1 pr-3">
                    <span className="flex items-center gap-1.5">
                      {m.home ? (
                        <TeamCrest src={m.home.crest} name={m.home.name} size="xs" />
                      ) : null}
                      <span>{m.home?.name ?? t("TBD")}</span>
                      <span className="text-muted-foreground">{t("vs")}</span>
                      {m.away ? (
                        <TeamCrest src={m.away.crest} name={m.away.name} size="xs" />
                      ) : null}
                      <span>{m.away?.name ?? t("TBD")}</span>
                    </span>
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
      <p className="p-6 text-center text-sm text-muted-foreground">
        {t("No matches on this day.")}
      </p>
    );
  }

  return (
    <div
      data-testid={`public-day-${day}`}
      className="overflow-hidden bg-card"
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
  const { up } = useBreakpoint();
  const wideRail = up("lg");

  const {
    scheduleQ: query,
    standingsQ,
    connected,
    hasKnockout,
  } = usePublicTournament(slug, id);

  const tournamentName = query.data?.tournament.name;
  useEffect(() => {
    if (tournamentName) document.title = `${tournamentName} · ${t("Matches")}`;
  }, [tournamentName]);

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

  /** Everything below the control bar obeys the selection (owner 2026-08-13).
   * Open a category and the bands are that category's — a "Now playing" tile
   * for another game, or a leader board pooling every sport, reads as part of
   * the category you opened and is simply wrong. Today stays the whole
   * tournament. Both bands already render null when they have nothing. */
  const bandMatches = selectedComp?.matches ?? allMatches;
  const bandLive = useMemo(
    () => bandMatches.filter((m) => LIVE_STATUSES.has(m.status)),
    [bandMatches],
  );

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
    <div className="flex min-h-screen flex-col">
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
        <PublicViewerTabs
          slug={slug}
          id={id}
          active="schedule"
          showKnockout={hasKnockout !== false}
        />
      </div>

      {query.isLoading ? (
        <main
          className="flex w-full flex-1 flex-col p-0 sm:px-6 sm:py-4 lg:px-8"
          aria-busy="true"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-px overflow-hidden border-y border-border bg-card sm:rounded-xl sm:border sm:shadow-sm">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse border-b border-border bg-muted/40" />
            ))}
          </div>
        </main>
      ) : query.isError || !query.data ? (
        <main className="flex w-full flex-1 p-0 sm:px-6 sm:py-4 lg:px-8">
          <p
            role="alert"
            className="w-full border-y border-border bg-card p-8 text-center text-sm text-muted-foreground sm:rounded-xl sm:border sm:shadow-sm"
          >
            {t("This schedule is not available.")}
          </p>
        </main>
      ) : (
        <main className="flex w-full flex-1 flex-col p-0 print:p-0 sm:px-6 sm:py-4 lg:px-8">
          {/* ONE section, nothing outside it (owner 2026-07-26): the tournament
              name, the competition rail and the whole panel live on a single
              surface, divided by hairlines. */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-y border-border bg-card print:border-0 sm:rounded-xl sm:border sm:shadow-sm">
          {/* Title + connection state — the section's own header band. */}
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-3 py-3 print:hidden sm:px-4">
            <h1 className="text-lg font-semibold tracking-tight sm:text-xl">
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
            <p className="p-8 text-center text-sm text-muted-foreground">
              {t("No matches scheduled yet. Check back soon.")}
            </p>
          ) : (
            <>
              {/* Mobile pill nav, pinned under the tabs */}
              {!wideRail ? (
                <div className="border-b border-border px-3 py-2 print:hidden">
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

              <div className="flex w-full flex-1 items-stretch">
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
                <section className="flex min-w-0 flex-1 flex-col print:p-0">
                  {/* Control bar. Two clear rows on a phone (context, then
                      the controls) collapsing to one on a desk — the old
                      single crowded row squeezed the day selector to an
                      unreadable stub (owner 2026-07-26). Solid `bg-card`, not
                      a translucent wash over the page background. */}
                  <div className="sticky top-0 z-20 flex flex-col gap-2 border-b border-border bg-card px-3 py-2.5 print:hidden sm:px-4 xl:flex-row xl:items-center xl:gap-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {selected === "today" ? (
                        <span className="flex shrink-0 items-center gap-2 text-sm font-semibold">
                          <Trophy aria-hidden className="h-4 w-4 text-primary" />
                          {isPreTournament ? t("Next match day") : t("Today")}
                        </span>
                      ) : selectedComp ? (
                        <LabelChips label={selectedComp.label} />
                      ) : null}

                      {selectedComp ? (
                        <div className="inline-flex shrink-0 rounded-lg bg-muted p-0.5">
                          {segBtn("standings", t("Standings"), "panel-standings")}
                          {segBtn("day", t("Order of play"), "view-day")}
                        </div>
                      ) : null}

                      <span
                        data-testid="filter-count"
                        className="shrink-0 rounded-full bg-secondary px-2 py-0.5 font-tabular text-xs font-medium text-secondary-foreground"
                      >
                        {q
                          ? `${visibleCount} ${t("of")} ${scopeMatches.length}`
                          : `${scopeMatches.length}`}{" "}
                        {t("matches")}
                      </span>
                    </div>

                    <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center xl:ml-auto xl:w-auto">
                      {/* The day picker gets room to show a whole date, and a
                          calendar affordance so it reads as a control. */}
                      {selected === "today" && allDays.length > 1 ? (
                        <div className="flex min-w-0 items-center gap-2">
                          <CalendarDays
                            aria-hidden
                            className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block"
                          />
                          <Select
                            size="sm"
                            className="w-full min-w-0 sm:w-56"
                            aria-label={t("Match day")}
                            value={effectiveOverviewDay}
                            onChange={setOverviewDay}
                            options={allDays.map((d) => ({
                              value: d,
                              label: fmtDay(d),
                            }))}
                          />
                        </div>
                      ) : null}

                      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:min-w-[13rem]">
                        <div className="relative min-w-0 flex-1">
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
                            className="h-9 w-full min-w-0 rounded-md border border-border bg-background pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
                  </div>

                  {/* The one earned card: live, pinned inside the selection,
                      then what follows it, then the tables it feeds. */}
                  <LiveBand matches={bandLive} timeZone={tz} />
                  <UpNextBand matches={bandMatches} timeZone={tz} />
                  <FollowedBand matches={bandMatches} timeZone={tz} />
                  {selectedComp && panelMode === "standings" ? (
                    <CompetitionTables comp={selectedComp} />
                  ) : null}
                  <PublicLeaders
                    slug={slug}
                    id={id}
                    flat
                    leafKey={selectedComp?.key}
                  />

                  {/* Body */}
                  {selected === "today" ? (
                    isPreTournament && effectiveOverviewDay ? (
                      <>
                        <p className="border-b border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground sm:px-4">
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
          </div>
        </main>
      )}
    </div>
  );
}
