import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  CalendarDays,
  Clock,
  Columns3,
  GitMerge,
  Printer,
  Search,
  Star,
  Trophy,
  X,
} from "lucide-react";
import { useFollows } from "@/lib/follows";
import { type PublicScheduleMatch } from "@/api/tournaments";
import { Button } from "@/components/ui/button";
import { ActionMenu, ActionMenuItem } from "@/components/ui/menu";
import { Dialog } from "@/components/ui/dialog";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { PublicViewerTabs } from "@/features/live/PublicViewerHeader";
import { AlbumPanel } from "@/features/lens/PublicAlbumPage";
import { lensApi } from "@/api/lens";
import { useQuery } from "@tanstack/react-query";
import { ShareButton } from "@/features/live/ShareButton";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { BrandLogo } from "@/components/ui/BrandLogo";
import {
  FINAL_STATUSES,
  LIVE_STATUSES,
  buildCompetitions,
  matchNumbers,
  splitLabel,
  usePublicRosters,
  usePublicTournament,
  type Competition,
} from "./publicTournament";
import { LabelChips } from "./publicTournamentViews";
import {
  LivePulse,
  MatchCard,
  fmtDay,
  fmtDayShort,
  teamHit,
} from "./publicMatchCard";
import { CompetitionSpotlight, MatchSpotlight } from "./CompetitionSpotlight";
import { CourtBoard, courtDefaultFits } from "./CourtBoard";
import { MatchSheet } from "./MatchSheet";
import { MatchDrawer } from "./MatchDrawer";
import {
  PublicBracketBoard,
  CompetitionBracket,
  NamesToggle,
} from "./PublicBracketBoard";
import { buildBrackets, pickBracket } from "./bracketModel";
import {
  FixturePrintDoc,
  printTitleFor,
  type PrintScope,
} from "./FixturePrintDoc";
import {
  passLabel,
  printLandscape,
  type PrintPasses,
} from "./printFixture";

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
      {/* ONE tile per row (owner 2026-08-27). Side by side, two long school
          names, a set strip and a scoreline had no room left and ran into
          each other; a live match is read across, not down.

          Each tile IS the competition page's spotlight (owner 2026-08-28:
          "in the today's page all the ongoing matches don't have the full
          screen button, we need that too"), so every court's match can go on
          its own projector from here, and Today can never drift from what a
          competition page shows for the same match. The band names the state
          once above the list; each tile's heading names its competition,
          which Today, unlike a competition page, cannot take as read. */}
      <div className="grid gap-3">
        {matches.map((m) => (
          <MatchSpotlight
            key={m.id}
            match={m}
            kind="live"
            matches={matches}
            timeZone={timeZone}
            title={m.leaf_label}
            label={<LabelChips label={m.leaf_label} />}
            testid={`live-tile-${m.id}`}
            frame="tile"
          />
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
}: {
  sports: { sport: string; comps: Competition[] }[];
  selected: string;
  onSelect: (key: string) => void;
  todayLabel: string;
  todayLive: number;
}): React.ReactElement {
  // No Knockout entry (owner 2026-08-21): every competition already carries
  // its own draw below its page, so a pinned scope holding all of them was a
  // second door to the same trees. `?comp=knockout` still resolves, so old
  // links and the /bracket redirect keep landing on the board.
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

/**
 * ONE competition, ONE page (owner 2026-08-21): its group stage as a proper
 * sheet, then its knockout as the bracket BELOW — never a second tab, and
 * never knockout rows inside the fixture list, where every side reads "TBD"
 * because no team has reached them yet.
 *
 * A knockout-only competition (every table-tennis category here) has no group
 * stage to table, so it is the bracket alone: the tree already says who plays
 * whom, when, and what each empty slot is waiting on.
 */
function GroupStageSheets({
  comp,
  timeZone,
  numbers,
  q,
  days,
  linkFor,
}: {
  comp: Competition;
  timeZone: string;
  numbers: Map<string, number>;
  q: string;
  /** Show the Day column only when the competition actually spans days. */
  days: number;
  linkFor?: (m: PublicScheduleMatch) => string;
}): React.ReactElement | null {
  const groups = comp.groups
    .map((g) => ({
      ...g,
      shown: (q ? g.matches.filter((m) => teamHit(m, q)) : g.matches)
        .filter((m) => m.stage !== "knockout")
        .sort((a, b) =>
          (a.scheduled_at ?? "~") < (b.scheduled_at ?? "~") ? -1 : 1,
        ),
    }))
    .filter((g) => g.shown.length > 0);
  if (groups.length === 0) return null;
  // The competition's OWN next match, flagged in the Status column of whichever
  // group holds it. One flag for the competition, not one per group: three
  // "Next up" chips would each be answering a question nobody asked.
  const nextId = comp.matches
    .filter(
      (m) =>
        m.scheduled_at &&
        !FINAL_STATUSES.has(m.status) &&
        !LIVE_STATUSES.has(m.status),
    )
    .sort((a, b) => ((a.scheduled_at ?? "") < (b.scheduled_at ?? "") ? -1 : 1))[0]
    ?.id;
  return (
    <section
      data-testid={`public-competition-${comp.key}`}
      className="flex flex-col gap-4 border-t border-border p-3 sm:p-4"
    >
      <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {t("Group stage")}
      </h2>
      {groups.map((g) => (
        <div
          key={g.key}
          data-testid={`public-group-${comp.key}-${g.key}`}
          className="flex flex-col overflow-hidden rounded-lg border border-border bg-card"
        >
          <h3 className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-semibold sm:px-4">
            {g.label}
            <span className="font-tabular text-xs font-normal text-muted-foreground">
              {g.shown.length}
            </span>
          </h3>
          <MatchSheet
            matches={g.shown}
            timeZone={timeZone}
            numbers={numbers}
            showCourt
            showDay={days > 1}
            showCompetition={false}
            idScope={`comp-${comp.key}`}
            nextId={nextId}
            linkFor={linkFor}
          />
        </div>
      ))}
    </section>
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
  linkFor,
}: {
  day: string;
  matches: PublicScheduleMatch[];
  timeZone: string;
  numbers: Map<string, number>;
  linkFor?: (m: PublicScheduleMatch) => string;
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
          linkFor={linkFor}
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
/**
 * THE UNIFIED PUBLIC PAGE (owner 2026-08-23): the photo album is a VIEW of
 * the match centre (`?view=album`) - one URL to share, one tab strip. The
 * view switch happens here, OUTSIDE the hooks-heavy inner component, so both
 * surfaces keep a stable hook order.
 */
export function PublicSchedulePage(): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  const [params] = useSearchParams();
  if (params.get("view") === "album") {
    return <AlbumView slug={slug} id={id} campaignId={params.get("campaign") ?? ""} />;
  }
  return <PublicScheduleInner />;
}

/** The album as a first-class citizen of the public chrome. */
function AlbumView({
  slug,
  id,
  campaignId,
}: {
  slug: string;
  id: string;
  campaignId: string;
}): React.ReactElement {
  const q = useQuery({
    queryKey: ["public-tournament-name", slug, id],
    queryFn: () => lensApi.publicAlbum(slug, id, campaignId || undefined),
    retry: false,
  });
  const tournamentName = q.data?.campaign?.title;
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-card px-4 sm:px-6">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandLogo className="h-7 w-7 rounded-lg" />
          {t("Fixture")}
        </Link>
        <span className="ml-2 min-w-0 truncate text-sm text-muted-foreground">
          {tournamentName ?? t("Photos")}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ShareButton title={tournamentName} />
          <ThemeToggle />
        </div>
      </header>
      <div className="border-b border-border bg-card px-4 sm:px-6">
        <PublicViewerTabs slug={slug} id={id} active="album" />
      </div>
      <main className="flex w-full flex-1 flex-col px-0 py-0 sm:px-6 sm:py-6">
        <AlbumPanel slug={slug} id={id} campaignId={campaignId} />
      </main>
    </div>
  );
}

function PublicScheduleInner(): React.ReactElement {
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

  /** Printing pulls a SECOND read (every team's line-up) that the screen never
   * needs, so it is fetched on the first Print and kept from then on. The
   * print document then already exists when the dialog opens. */
  const [wantRosters, setWantRosters] = useState(false);
  const [printQueued, setPrintQueued] = useState(false);
  /** Which passes the pending export prints (owner 2026-08-22). Both is what
   * Print always did, and stays the default. */
  const [printPasses, setPrintPasses] = useState<PrintPasses>("both");
  /** The bracket's Player names switch, in the URL like every other choice on
   * this page, so a draw showing who is playing is a shareable link.
   * Names are the DEFAULT (owner 2026-08-24 — who is playing is the first
   * question a parent asks, it should not need a toggle); `names=0` is the
   * explicit opt-out and its only value. */
  const namesOn = params.get("names") !== "0";
  const { rosters, settled: rostersSettled } = usePublicRosters(
    slug,
    id,
    wantRosters || namesOn,
  );

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
  /** Only a match day has views to switch between. A competition is ONE page
   * now — tables, then its group stage, then its bracket — and the knockout
   * scope is the board itself. */
  const views: ViewOption[] =
    selectedComp || selected === "knockout"
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

  const defaultView = courtDefaultFits(dayMatches) ? "courts" : "time";
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
  // Memoised because the printed fixture is built from exactly this list, and
  // the paper must not be rebuilt on every live tick.
  const dayShown = useMemo(
    () => dayMatches.filter((m) => teamHit(m, q)),
    [dayMatches, q],
  );

  /** The open match is a URL param, so a row is a real link (middle-click
   * opens the sheet with that match already open), Back closes the drawer and
   * a pasted link lands on the same match. */
  const openId = params.get("match") ?? "";
  const openMatch = openId
    ? allMatches.find((m) => m.id === openId)
    : undefined;
  const matchHrefById = (mid: string): string => {
    const p = new URLSearchParams(params);
    p.set("match", mid);
    p.delete("tab");
    return `?${p.toString()}`;
  };
  const matchHref = (m: PublicScheduleMatch): string => matchHrefById(m.id);

  /** ONE resolver for the knockout scope, shared with the board itself, so
   * Print gives back the draw on screen and not a different competition. */
  const koBrackets = useMemo(() => buildBrackets(koMatches), [koMatches]);

  /** Print exports EXACTLY what is on screen: this scope, this view, this day,
   * this search. Anything else and the paper stops matching the board. */
  const koSport = params.get("kosport") ?? "";
  const koComp = params.get("kocomp") ?? "";
  const courts = query.data?.courts;
  const printScope: PrintScope = useMemo(
    () =>
      selected === "knockout"
        ? { kind: "knockout", bracket: pickBracket(koBrackets, koSport, koComp) }
        : selectedComp
          ? { kind: "competition", comp: selectedComp, days: allDays.length }
          : { kind: "day", day, view, matches: dayShown, courts },
    [
      selected,
      selectedComp,
      koBrackets,
      koSport,
      koComp,
      allDays.length,
      day,
      view,
      dayShown,
      courts,
    ],
  );

  useEffect(() => {
    if (!printQueued) return;
    const go = (): void => {
      setPrintQueued(false);
      printLandscape(printTitleFor(printScope, tournamentName ?? "", printPasses));
    };
    // Rosters are a bonus, never a blocker: a read that fails or never lands
    // prints the fixture anyway, with "No team sheet" where the names would
    // be. The wait is long because printing a whole tournament's detailed
    // pass as "No team sheet" is worse than waiting — and the prefetch below
    // means the answer is usually already here by the time it is clicked.
    // A team-names export never waits: it has no names to be missing.
    const needsRosters = printPasses !== "teams";
    const h = window.setTimeout(
      go,
      !needsRosters || rostersSettled ? 60 : 15000,
    );
    return () => window.clearTimeout(h);
  }, [printQueued, rostersSettled, printScope, tournamentName, printPasses]);

  const queuePrint = (passes: PrintPasses): void => {
    setPrintPasses(passes);
    setPrintQueued(true);
  };

  /**
   * Print is a MENU, not a button (owner 2026-08-22): every export used to be
   * the whole fixture twice over, by team and then again with every player
   * named, so an organiser after an order of play for the wall binned half of
   * what came out of the printer. The three items are the two passes and the
   * pair of them; both stays the default, and the wording matches the line
   * each pass prints under on the page itself.
   */
  const printButton = (
    <div
      className="shrink-0"
      // Reaching for the control is the signal to go and get the line-ups, so
      // the dialog opens on a document that already has the names in it.
      onPointerEnter={() => setWantRosters(true)}
      onFocus={() => setWantRosters(true)}
    >
      <ActionMenu
        size="sm"
        icon={Printer}
        disabled={printQueued}
        data-testid="print-menu"
        label={printQueued ? t("Preparing") : t("Print / PDF")}
      >
        <ActionMenuItem
          data-testid="print-teams"
          onSelect={() => queuePrint("teams")}
        >
          {passLabel(false)}
        </ActionMenuItem>
        <ActionMenuItem
          data-testid="print-detailed"
          onSelect={() => queuePrint("detailed")}
        >
          {passLabel(true)}
        </ActionMenuItem>
        <ActionMenuItem
          data-testid="print-both"
          onSelect={() => queuePrint("both")}
        >
          {t("Both")}
        </ActionMenuItem>
      </ActionMenu>
    </div>
  );

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
        {/* No tournament name here: the band under the tabs is its title
            (owner 2026-08-28: "we are already writing it in the other
            section as title"). */}
        <div className="ml-auto flex items-center gap-1">
          <ShareButton title={tournamentName} />
          <ThemeToggle />
        </div>
      </header>
      <div className="border-b border-border bg-card px-4 print:hidden sm:px-6">
        <PublicViewerTabs
          slug={slug}
          id={id}
          active={params.get("view") === "album" ? "album" : "schedule"}
        />
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
        <main className="flex w-full flex-1 flex-col p-0 print:hidden sm:px-6 sm:py-4 lg:px-8">
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
                      {/* On a phone there is no rail: the current scope lives
                          on the floating filter button at the bottom of the
                          screen instead of a control that scrolled away (owner
                          2026-08-24). */}
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
                      ) : null}

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

                      {/* The board's own actions, top right: search, then
                          Print. Printing used to sit at the very BOTTOM of a
                          court board, a screen and a half below the fixture it
                          prints (owner 2026-08-21). */}
                      <div className="ml-auto flex shrink-0 items-center gap-2">
                        <div className="hidden sm:block">{searchBox}</div>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("Search teams")}
                          aria-expanded={searchOpen}
                          className="shrink-0 sm:hidden"
                          onClick={() => setSearchOpen((v) => !v)}
                        >
                          <Search aria-hidden className="h-4 w-4" />
                        </Button>
                        {printButton}
                      </div>
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

                  {/* A competition page leads with ONE match — live, else
                      next, else the last result — and that section is what
                      goes full screen on the hall's projector (owner
                      2026-08-26). The live band stays on Today, where several
                      courts really are playing at once and the answer is a
                      list. "Up next" as a band is still gone: a sheet flags
                      its OWN next match in the Status column, and standings
                      have their own tab (owner 2026-08-21). */}
                  {selected === "knockout" ? null : (
                    <>
                      {selectedComp ? (
                        <CompetitionSpotlight
                          matches={selectedComp.matches}
                          timeZone={tz}
                          title={selectedComp.label}
                        />
                      ) : (
                        <LiveBand matches={bandLive} timeZone={tz} />
                      )}
                      <FollowedBand matches={bandMatches} timeZone={tz} />
                    </>
                  )}

                  {/* Body */}
                  {selected === "knockout" ? (
                    <PublicBracketBoard
                      matches={koMatches}
                      timeZone={tz}
                      numbers={numbers}
                      linkFor={matchHrefById}
                      rosters={namesOn ? rosters : undefined}
                      namesOn={namesOn}
                      onNames={(next) =>
                        setParam({ names: next ? null : "0" })
                      }
                    />
                  ) : selectedComp ? (
                    /* ONE page per category: its tables, then its group stage
                       as a sheet, then its knockout as the bracket BELOW. */
                    <>
                      <GroupStageSheets
                        comp={selectedComp}
                        timeZone={tz}
                        numbers={numbers}
                        q={q}
                        days={allDays.length}
                        linkFor={matchHref}
                      />
                      {selectedComp.matches.some(
                        (m) => m.stage === "knockout",
                      ) ? (
                        <section className="flex flex-col border-t border-border">
                          <div className="flex flex-wrap items-center gap-2 px-3 pt-3 sm:px-4">
                            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                              {t("Knockout")}
                            </h2>
                            <span className="ml-auto">
                              <NamesToggle
                                on={namesOn}
                                onChange={(next) =>
                                  setParam({ names: next ? null : "0" })
                                }
                                testid="comp-names-toggle"
                              />
                            </span>
                          </div>
                          <CompetitionBracket
                            matches={selectedComp.matches}
                            timeZone={tz}
                            leafKey={selectedComp.key}
                            numbers={numbers}
                            linkFor={matchHrefById}
                            rosters={namesOn ? rosters : undefined}
                          />
                        </section>
                      ) : null}
                    </>
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
                          linkFor={matchHref}
                        />
                      ) : (
                        <TimeBoard
                          day={day}
                          matches={dayShown}
                          timeZone={tz}
                          numbers={numbers}
                          linkFor={matchHref}
                        />
                      )}
                    </>
                  )}
                </section>
              </div>
            )}
          </div>
        </main>
      )}

      {/* Paper. Hidden on screen, and the ONLY thing that prints: the same
          boards, in landscape, first by team and then again with every player
          named. */}
      {query.data ? (
        <FixturePrintDoc
          tournamentName={query.data.tournament.name}
          timeZone={tz}
          numbers={numbers}
          rosters={rosters}
          scope={printScope}
          passes={printPasses}
        />
      ) : null}

      {/* The phone's floating FILTER button: the way into the competition map
          from anywhere on the page. It carries the current scope as its label,
          so it answers "what am I looking at" as well as opening the picker —
          the job the old top-bar button did before it scrolled away (owner
          2026-08-24). Same fixed-bottom pattern as the album's Scan & upload.
          Desktop keeps the rail, so the button exists only below lg. */}
      {!wideRail ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4 print:hidden">
          <button
            type="button"
            data-testid="scope-fab"
            onClick={() => setScopeOpen(true)}
            className="pointer-events-auto inline-flex h-11 max-w-full items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground shadow-lg hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {selected === "knockout" ? (
              <GitMerge aria-hidden className="h-4 w-4 shrink-0" />
            ) : (
              <Trophy aria-hidden className="h-4 w-4 shrink-0" />
            )}
            <span className="min-w-0 truncate">{scopeName}</span>
            <span className="shrink-0 rounded-full bg-primary-foreground/20 px-2 py-0.5 font-tabular text-[0.6875rem]">
              {t("Filter")}
            </span>
          </button>
        </div>
      ) : null}

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

      {/* One match, over the sheet that lists it. Closing REPLACES the entry
          rather than pushing another, so Back from a closed drawer leaves the
          page instead of re-opening it. */}
      {openId ? (
        <MatchDrawer
          matchId={openId}
          matchNo={numbers.get(openId)}
          // A finished match has nothing left to watch live (owner 2026-08-26).
          watchUrl={
            openMatch && LIVE_STATUSES.has(openMatch.status)
              ? openMatch.watch_url
              : null
          }
          tab={params.get("tab") ?? "overview"}
          onTab={(key) => setParam({ tab: key === "overview" ? null : key })}
          onClose={() => setParam({ match: null, tab: null })}
        />
      ) : null}
    </div>
  );
}
