import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  CalendarDays,
  Clock,
  Columns3,
  GitMerge,
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
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { PublicLeaders } from "@/features/live/PublicLeaders";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import { routes } from "@/lib/routes";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { PublicViewerTabs } from "@/features/live/PublicViewerHeader";
import { ShareButton } from "@/features/live/ShareButton";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { BrandLogo } from "@/components/ui/BrandLogo";
import {
  FINAL_STATUSES,
  LIVE_STATUSES,
  buildCompetitions,
  matchNumbers,
  shortGroup,
  splitLabel,
  usePublicTournament,
  type Competition,
} from "./publicTournament";
import { GroupTable, LabelChips } from "./publicTournamentViews";
import {
  LivePulse,
  MatchCard,
  TeamName,
  fmtDay,
  fmtDayShort,
  fmtKickoff,
  statusMeta,
  teamHit,
} from "./publicMatchCard";
import { CourtBoard, courtDefaultFits } from "./CourtBoard";
import { MatchSheet } from "./MatchSheet";
import { PublicBracketBoard, CompetitionBracket } from "./PublicBracketBoard";

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
  // Five courts can all be live at once, and five hero tiles push the sheet a
  // screen and a half down. Past two, the band tiles tighter.
  const many = matches.length > 2;
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
      <div
        className={cn(
          "grid gap-3",
          !single && "sm:grid-cols-2",
          many && "xl:grid-cols-3",
        )}
      >
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
              <div
                className={cn(
                  "relative flex flex-col items-center gap-3 px-4 sm:px-6",
                  many ? "py-4" : "py-6",
                )}
              >
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
                        single
                          ? "text-4xl sm:text-6xl"
                          : many
                            ? "text-3xl sm:text-4xl"
                            : "text-4xl sm:text-5xl",
                      )}
                    >
                      {score[0]}
                      <span className="px-2 text-muted-foreground">-</span>
                      {score[1]}
                    </Link>
                    {sv ? (
                      <p className="mt-1 font-tabular text-sm text-muted-foreground">
                        {t("Set")} {sv.setNo} · {t("Sets")} {sv.sets[0]}-
                        {sv.sets[1]}
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
      .sort((a, b) =>
        (a.scheduled_at ?? "") < (b.scheduled_at ?? "") ? -1 : 1,
      );
    const upcoming = waiting.filter((m) => (m.scheduled_at ?? "") >= now);
    return (upcoming.length > 0 ? upcoming : waiting).slice(0, 3);
  }, [matches]);

  if (next.length === 0) return null;
  return (
    <section
      data-testid="upnext-band"
      className="border-b border-border bg-card"
    >
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

/** One entry of the scope navigator (the rail on a desk, the sheet on a
 * phone) — Today, Knockout, or one competition. */
function ScopeButton({
  testid,
  active,
  onClick,
  icon: Icon,
  label,
  chips,
  count,
  live,
}: {
  testid: string;
  active: boolean;
  onClick: () => void;
  icon?: typeof CalendarDays;
  label?: string;
  chips?: string;
  count?: number;
  live?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-current={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 border-l-2 px-4 py-2.5 text-left text-sm transition-colors",
        active
          ? "border-primary bg-primary/10 font-medium text-primary"
          : "border-transparent text-foreground hover:bg-muted",
      )}
    >
      {Icon ? <Icon aria-hidden className="h-4 w-4 shrink-0" /> : null}
      {chips ? (
        <LabelChips label={chips} omitSport className="min-w-0" />
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1.5 font-tabular text-xs text-muted-foreground">
        {live ? <LivePulse /> : null}
        {count != null ? count : null}
      </span>
    </button>
  );
}

/** The persistent competition map: a pinned Today, a pinned Knockout (the old
 * separate page, folded in) and then every competition under its sport. ONE
 * list, rendered into the desktop rail and the phone's sheet alike, so both
 * surfaces can never drift. */
function ScopeList({
  sports,
  selected,
  onSelect,
  todayLabel,
  todayLive,
  hasKnockout,
  koCount,
}: {
  sports: { sport: string; comps: Competition[] }[];
  selected: string;
  onSelect: (key: string) => void;
  todayLabel: string;
  todayLive: number;
  hasKnockout: boolean;
  koCount: number;
}): React.ReactElement {
  return (
    <>
      <div className="pt-2">
        <ScopeButton
          testid="rail-today"
          active={selected === "today"}
          onClick={() => onSelect("today")}
          icon={CalendarDays}
          label={todayLabel}
          live={todayLive > 0}
        />
        {hasKnockout ? (
          <ScopeButton
            testid="rail-knockout"
            active={selected === "knockout"}
            onClick={() => onSelect("knockout")}
            icon={GitMerge}
            label={t("Knockout")}
            count={koCount}
          />
        ) : null}
      </div>
      {sports.map((s) => (
        <div key={s.sport} className="mt-1 flex flex-col">
          <span className="px-4 pb-1 pt-2.5 text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {s.sport}
          </span>
          {s.comps.map((c) => (
            <ScopeButton
              key={c.key}
              testid={`rail-comp-${c.key}`}
              active={selected === c.key}
              onClick={() => onSelect(c.key)}
              chips={c.label}
              count={c.matches.length}
              live={c.liveCount > 0}
            />
          ))}
        </div>
      ))}
    </>
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
    .map((g) => ({
      ...g,
      shown: q ? g.matches.filter((m) => teamHit(m, q)) : g.matches,
    }))
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
      className="grid grid-cols-1 items-start gap-x-6 gap-y-4 p-3 sm:p-4 xl:grid-cols-2"
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
              <MatchCard
                key={m.id}
                match={m}
                timeZone={timeZone}
                labels="none"
              />
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
                        <TeamCrest
                          src={m.home.crest}
                          name={m.home.name}
                          size="xs"
                        />
                      ) : null}
                      <span>{m.home?.name ?? t("TBD")}</span>
                      <span className="text-muted-foreground">{t("vs")}</span>
                      {m.away ? (
                        <TeamCrest
                          src={m.away.crest}
                          name={m.away.name}
                          size="xs"
                        />
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
        <div className="flex flex-wrap items-center gap-2 px-3 pt-3 print:hidden sm:px-4">
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

      <div className="flex flex-col gap-3 p-3 print:hidden sm:p-4">
        {days.map(([day, ms]) => (
          <section
            key={day}
            data-testid={`public-day-${day}`}
            className="overflow-hidden rounded-lg border border-border bg-card"
          >
            <h3 className="border-b border-border bg-muted px-4 py-2 text-sm font-semibold">
              {fmtDay(day)}
              <span className="ml-2 font-tabular text-xs font-normal text-muted-foreground">
                {ms.length} {ms.length === 1 ? t("match") : t("matches")}
              </span>
            </h3>
            <ul className="divide-y divide-border">
              {ms.map((m) => (
                <MatchCard
                  key={m.id}
                  match={m}
                  timeZone={timeZone}
                  labels="group"
                />
              ))}
            </ul>
          </section>
        ))}

        {unscheduled.length ? (
          <section
            data-testid="public-unscheduled"
            className="overflow-hidden rounded-lg border border-border bg-card"
          >
            <h3 className="border-b border-border bg-muted px-4 py-2 text-sm font-semibold">
              {t("Time to be announced")}
            </h3>
            <ul className="divide-y divide-border">
              {unscheduled.map((m) => (
                <MatchCard
                  key={m.id}
                  match={m}
                  timeZone={timeZone}
                  labels="group"
                />
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

/** The same day as ONE sheet in kick-off order, with the court in its own
 * column — for anyone who reads a day as a clock rather than as a set of
 * tables. Same columns as a court's sheet, so switching view never changes
 * what a row means. */
function TimeBoard({
  day,
  matches,
  timeZone,
  numbers,
}: {
  day: string;
  matches: PublicScheduleMatch[];
  timeZone: string;
  numbers: Map<string, number>;
}): React.ReactElement {
  const ordered = useMemo(
    () =>
      [...matches].sort((a, b) =>
        (a.scheduled_at ?? "~") < (b.scheduled_at ?? "~") ? -1 : 1,
      ),
    [matches],
  );

  if (ordered.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        {t("No matches on this day.")}
      </p>
    );
  }
  return (
    <div data-testid={`public-day-${day}`} className="p-3 sm:p-4">
      <div className="overflow-hidden rounded-lg border border-border">
        <MatchSheet
          matches={ordered}
          timeZone={timeZone}
          numbers={numbers}
          showCourt
          idScope="byTime"
        />
      </div>
    </div>
  );
}

interface ViewOption {
  key: string;
  label: string;
  testid: string;
  icon: typeof CalendarDays;
}

/** The panel's view switcher: full-width equal segments on a phone (a thumb
 * target, not a chip), inline on a desk. */
function ViewSwitch({
  options,
  value,
  onChange,
}: {
  options: ViewOption[];
  value: string;
  onChange: (key: string) => void;
}): React.ReactElement | null {
  if (options.length < 2) return null;
  return (
    <div
      role="tablist"
      aria-label={t("View")}
      className="inline-flex w-full rounded-lg bg-muted p-0.5 sm:w-auto"
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          data-testid={o.testid}
          onClick={() => onChange(o.key)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:flex-none",
            value === o.key
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <o.icon aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Public, login-free tournament MATCH CENTRE: one page for the whole
 * tournament. A persistent scope navigator (a match day, the knockout draw, or
 * one competition) drives a panel that switches between the views that scope
 * actually has — a day reads by COURT (the default: a tournament day is five
 * tables each with its own queue) or by clock; a competition reads as tables,
 * as an order of play, or as its bracket. Live matches lift into a single
 * "Now playing" band.
 *
 * The knockout draw used to be its own page. It is the same board, the same
 * FifaBracket trees, reached without leaving the matches (owner 2026-08-21).
 *
 * Live over the public SSE tick stream (control room spec §3.3) with a 60 s
 * poll fallback, full-width, in its own minimal chrome (no app shell).
 */
export function PublicSchedulePage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const { up } = useBreakpoint();
  const wideRail = up("lg");
  const [params, setParams] = useSearchParams();
  const [scopeOpen, setScopeOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const { scheduleQ: query, standingsQ, connected } = usePublicTournament(
    slug,
    id,
  );

  const tournamentName = query.data?.tournament.name;
  useEffect(() => {
    if (tournamentName) document.title = `${tournamentName} · ${t("Matches")}`;
  }, [tournamentName]);

  const tz = query.data?.tournament.time_zone ?? "UTC";
  const allMatches = useMemo(() => query.data?.matches ?? [], [query.data]);
  const koMatches = useMemo(
    () => allMatches.filter((m) => m.stage === "knockout"),
    [allMatches],
  );
  const hasKnockout = koMatches.length > 0;

  const [teamQ, setTeamQ] = useState("");
  const [printDay, setPrintDay] = useState("");

  /** Scope, view and day live in the URL: what a viewer is looking at is what
   * they share, and coming back to a bookmark lands on the same board. */
  const setParam = (next: Record<string, string | null>): void => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };

  /** Fixture match numbers come off the WHOLE tournament, never the filtered
   * day: "Winner of M12" may point at a match on another day or court. */
  const numbers = useMemo(() => matchNumbers(allMatches), [allMatches]);

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

  const compParam = params.get("comp") ?? "";
  const selected =
    compParam === "knockout"
      ? hasKnockout
        ? "knockout"
        : "today"
      : competitions.some((c) => c.key === compParam)
        ? compParam
        : "today";
  const selectedComp =
    selected === "today" || selected === "knockout"
      ? null
      : competitions.find((c) => c.key === selected);

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
      today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(
        new Date(),
      );
    } catch {
      today = "";
    }
    return allDays.find((d) => d >= today) ?? allDays[0];
  }, [allDays, tz]);

  const dayParam = params.get("day") ?? "";
  const day = allDays.includes(dayParam) ? dayParam : smartDefaultDay;
  const isPreTournament = useMemo(() => {
    try {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(
        new Date(),
      );
      return Boolean(day) && day > today;
    } catch {
      return false;
    }
  }, [day, tz]);

  const dayMatches = useMemo(
    () => allMatches.filter((m) => m.day === day),
    [allMatches, day],
  );

  /** The views this scope has, and which one it opens on. A day board defaults
   * to COURTS whenever the day actually runs on more than one court; a
   * competition opens on its tables, or straight on its bracket when it has no
   * group stage to table. */
  const views: ViewOption[] = selectedComp
    ? [
        ...(selectedComp.groups.some((g) => (g.standing?.rows.length ?? 0) > 0)
          ? [
              {
                key: "table",
                label: t("Standings"),
                testid: "panel-standings",
                icon: ListOrdered,
              },
            ]
          : []),
        {
          key: "days",
          label: t("Order of play"),
          testid: "view-day",
          icon: CalendarDays,
        },
        ...(selectedComp.matches.some((m) => m.stage === "knockout")
          ? [
              {
                key: "bracket",
                label: t("Knockout"),
                testid: "view-bracket",
                icon: GitMerge,
              },
            ]
          : []),
      ]
    : selected === "knockout"
      ? []
      : [
          {
            key: "courts",
            label: t("By court"),
            testid: "view-courts",
            icon: Columns3,
          },
          {
            key: "time",
            label: t("By time"),
            testid: "view-time",
            icon: Clock,
          },
        ];

  const has = (k: string): boolean => views.some((v) => v.key === k);
  const defaultView = selectedComp
    ? // Tables first when there are tables. A knockout-only competition has
      // none, and its bracket is the clearest thing it owns, so it opens there
      // rather than on a list of times.
      has("table")
      ? "table"
      : has("bracket")
        ? "bracket"
        : "days"
    : courtDefaultFits(dayMatches)
      ? "courts"
      : "time";
  const viewParam = params.get("view") ?? "";
  const view = views.some((v) => v.key === viewParam) ? viewParam : defaultView;

  /** Everything below the control bar obeys the selection (owner 2026-08-13).
   * Open a category and the bands are that category's — a "Now playing" tile
   * for another game, or a leader board pooling every sport, reads as part of
   * the category you opened and is simply wrong. A match day stays the whole
   * tournament. Both bands already render null when they have nothing. */
  const bandMatches = selectedComp?.matches ?? allMatches;
  const bandLive = useMemo(
    () => bandMatches.filter((m) => LIVE_STATUSES.has(m.status)),
    [bandMatches],
  );

  const q = teamQ.trim().toLowerCase();
  // Scope of the active view (for the count chip).
  const scopeMatches =
    selected === "knockout"
      ? koMatches
      : selectedComp
        ? selectedComp.matches
        : dayMatches;
  const visibleCount = q
    ? scopeMatches.filter((m) => teamHit(m, q)).length
    : scopeMatches.length;
  const dayShown = dayMatches.filter((m) => teamHit(m, q));

  const todayLabel = isPreTournament ? t("Next match day") : t("Today");
  const pickScope = (key: string): void => {
    setParam({ comp: key === "today" ? null : key, view: null });
    setScopeOpen(false);
  };

  const scopeList = (
    <ScopeList
      sports={railSports}
      selected={selected}
      onSelect={pickScope}
      todayLabel={todayLabel}
      todayLive={liveMatches.length}
      hasKnockout={hasKnockout}
      koCount={koMatches.length}
    />
  );

  /** What the control bar says you are looking at. */
  const scopeName =
    selected === "knockout"
      ? t("Knockout")
      : selectedComp
        ? splitLabel(selectedComp.label).join(" ")
        : todayLabel;

  const searchBox = (
    <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
      <div className="relative min-w-0 flex-1 sm:w-56">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          data-testid="filter-team"
          aria-label={t("Search teams")}
          placeholder={t("Search teams")}
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
  );

  return (
    <div className="flex min-h-screen flex-col">
      {/* Chrome, deliberately NOT sticky: the bar worth pinning on a long
          court board is the control bar below (scope, view, day), and two
          stacked sticky bars eat a phone screen. */}
      <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 print:hidden sm:px-6">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandLogo className="h-7 w-7 rounded-lg" />
          {t("Fixture")}
        </Link>
        <span className="ml-2 min-w-0 truncate text-sm text-muted-foreground">
          {tournamentName ?? t("Schedule")}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ShareButton title={tournamentName} />
          <ThemeToggle />
        </div>
      </header>
      <div className="border-b border-border bg-card px-4 print:hidden sm:px-6">
        <PublicViewerTabs slug={slug} id={id} active="schedule" />
      </div>

      {query.isLoading ? (
        <main
          className="flex w-full flex-1 flex-col p-0 sm:px-6 sm:py-4 lg:px-8"
          aria-busy="true"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-px overflow-hidden border-y border-border bg-card sm:rounded-xl sm:border sm:shadow-sm">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-28 animate-pulse border-b border-border bg-muted/40"
              />
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
              name, the scope navigator and the whole panel live on a single
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
              <div className="flex w-full flex-1 items-stretch">
                {wideRail ? (
                  <nav
                    aria-label={t("Competitions")}
                    // A solid surface: with only a right border the page
                    // background showed straight through and the rail read as
                    // transparent (owner 2026-07-26). The column is a solid
                    // full-height surface (`self-stretch`); the nav content
                    // inside it is what scrolls and sticks.
                    className="hidden w-72 shrink-0 self-stretch border-r border-border print:hidden lg:block"
                  >
                    <div className="sticky top-0 max-h-screen overflow-y-auto pb-4">
                      <div className="sticky top-0 z-10 border-b border-border bg-card px-4 py-2.5">
                        <span className="text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          {t("Competitions")}
                        </span>
                      </div>
                      {scopeList}
                    </div>
                  </nav>
                ) : null}

                {/* Panel */}
                <section className="flex min-w-0 flex-1 flex-col print:p-0">
                  {/* Control bar: what you are looking at, then how you want to
                      read it, then which day and who you are looking for. One
                      wrapping row on a desk; on a phone the scope becomes a
                      button that opens the whole map as a sheet — a horizontal
                      scroller of twenty categories is not a map. */}
                  <div className="sticky top-0 z-20 flex flex-col gap-2 border-b border-border bg-card px-3 py-2.5 print:hidden sm:px-4">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      {wideRail ? (
                        <span className="flex min-w-0 shrink-0 items-center gap-2 text-sm font-semibold">
                          {selected === "today" ? (
                            <Trophy
                              aria-hidden
                              className="h-4 w-4 shrink-0 text-primary"
                            />
                          ) : selected === "knockout" ? (
                            <GitMerge
                              aria-hidden
                              className="h-4 w-4 shrink-0 text-primary"
                            />
                          ) : null}
                          {selectedComp ? (
                            <LabelChips label={selectedComp.label} />
                          ) : (
                            scopeName
                          )}
                        </span>
                      ) : (
                        <button
                          type="button"
                          data-testid="scope-picker"
                          onClick={() => setScopeOpen(true)}
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm font-medium"
                        >
                          <Trophy
                            aria-hidden
                            className="h-4 w-4 shrink-0 text-primary"
                          />
                          <span className="min-w-0 truncate">{scopeName}</span>
                          <span className="ml-auto shrink-0 font-tabular text-xs text-muted-foreground">
                            {t("Change")}
                          </span>
                        </button>
                      )}

                      <ViewSwitch
                        options={views}
                        value={view}
                        onChange={(k) => setParam({ view: k })}
                      />

                      <span
                        data-testid="filter-count"
                        className="shrink-0 rounded-full bg-secondary px-2 py-0.5 font-tabular text-xs font-medium text-secondary-foreground"
                      >
                        {q
                          ? `${visibleCount} ${t("of")} ${scopeMatches.length}`
                          : `${scopeMatches.length}`}{" "}
                        {t("matches")}
                      </span>

                      <div className="ml-auto hidden shrink-0 sm:block">
                        {searchBox}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={t("Search teams")}
                        aria-expanded={searchOpen}
                        className="ml-auto shrink-0 sm:hidden"
                        onClick={() => setSearchOpen((v) => !v)}
                      >
                        <Search aria-hidden className="h-4 w-4" />
                      </Button>
                    </div>

                    {searchOpen ? (
                      <div className="sm:hidden">{searchBox}</div>
                    ) : null}

                    {/* Days as chips, not a dropdown: a tournament runs two or
                        three days and every one of them should be one tap. */}
                    {selected === "today" && allDays.length > 1 ? (
                      <div
                        role="tablist"
                        aria-label={t("Match day")}
                        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                      >
                        {allDays.map((d) => (
                          <button
                            key={d}
                            type="button"
                            role="tab"
                            aria-selected={d === day}
                            data-testid={`day-pick-${d}`}
                            onClick={() => setParam({ day: d })}
                            className={cn(
                              "shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                              d === day
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:bg-muted",
                            )}
                          >
                            {fmtDayShort(d)}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {/* The one earned card: live, pinned inside the selection,
                      then what follows it, then the tables it feeds. */}
                  {selected === "knockout" ? null : (
                    <>
                      <LiveBand matches={bandLive} timeZone={tz} />
                      {/* A match day carries no "Up next" band: every court's
                          sheet flags its OWN next match, which is the answer
                          the band was guessing at (owner 2026-08-21). */}
                      {selectedComp ? (
                        <UpNextBand matches={bandMatches} timeZone={tz} />
                      ) : null}
                      <FollowedBand matches={bandMatches} timeZone={tz} />
                    </>
                  )}
                  {selectedComp && view === "table" ? (
                    <CompetitionTables comp={selectedComp} />
                  ) : null}
                  {/* The leader board is leaving the match centre for a page
                      of its own (owner 2026-08-21); the match day is the first
                      scope it has come off. */}
                  {selected === "knockout" || !selectedComp ? null : (
                    <PublicLeaders
                      slug={slug}
                      id={id}
                      flat
                      leafKey={selectedComp.key}
                    />
                  )}

                  {/* Body */}
                  {selected === "knockout" ? (
                    <PublicBracketBoard matches={koMatches} timeZone={tz} />
                  ) : selectedComp ? (
                    view === "table" ? (
                      <CompetitionStandings
                        comp={selectedComp}
                        timeZone={tz}
                        q={q}
                      />
                    ) : view === "bracket" ? (
                      <CompetitionBracket
                        matches={selectedComp.matches}
                        timeZone={tz}
                        leafKey={selectedComp.key}
                      />
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
                  ) : (
                    <>
                      {isPreTournament && day ? (
                        <p className="border-b border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground sm:px-4">
                          {t("The tournament starts")} {fmtDay(day)}.
                        </p>
                      ) : null}
                      {view === "courts" ? (
                        <CourtBoard
                          day={day}
                          matches={dayShown}
                          timeZone={tz}
                          courts={query.data.courts}
                          numbers={numbers}
                        />
                      ) : (
                        <TimeBoard
                          day={day}
                          matches={dayShown}
                          timeZone={tz}
                          numbers={numbers}
                        />
                      )}
                      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-3 print:hidden sm:px-4">
                        <span className="text-xs text-muted-foreground">
                          {t("Print this day's order of play")}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="print-day-button"
                          onClick={() => window.print()}
                        >
                          <Printer aria-hidden className="h-3.5 w-3.5" />
                          {t("Print")}
                        </Button>
                      </div>
                      {day ? (
                        <PrintSheet
                          day={day}
                          matches={dayMatches}
                          tournamentName={query.data.tournament.name}
                          timeZone={tz}
                        />
                      ) : null}
                    </>
                  )}
                </section>
              </div>
            )}
          </div>
        </main>
      )}

      {/* The scope map on a phone: the same list the rail shows, in the house
          bottom drawer (focus trap, Escape and backdrop dismiss come with it). */}
      <Dialog
        open={scopeOpen && !wideRail}
        onOpenChange={setScopeOpen}
        ariaLabel={t("Competitions")}
        variant="sheet"
      >
        <div className="flex items-center justify-between pb-2">
          <h2 className="text-sm font-semibold">{t("Competitions")}</h2>
          <Button size="sm" variant="ghost" onClick={() => setScopeOpen(false)}>
            {t("Close")}
          </Button>
        </div>
        <div className="-mx-4 flex flex-col">{scopeList}</div>
      </Dialog>
    </div>
  );
}
