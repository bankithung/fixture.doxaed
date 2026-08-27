import { Link, useParams } from "react-router-dom";
import { type PublicScheduleMatch } from "@/api/tournaments";
import { TeamCrest, type CrestSize } from "@/components/ui/TeamCrest";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import { routes } from "@/lib/routes";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { FINAL_STATUSES, LIVE_STATUSES, shortGroup } from "./publicTournament";
import { LabelChips } from "./publicTournamentViews";

/** The public match row and the small pieces every public list shares. Split
 * out of PublicSchedulePage so the court board, the day list and the bands
 * render the SAME row (one row design, one set of testids). */

export function statusMeta(status: string): {
  label: string;
  cls: string;
  live: boolean;
} {
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
    return { label: status, cls: "bg-warning-muted text-warning", live: false };
  }
  return {
    label: status.replace(/_/g, " "),
    cls: "bg-secondary text-secondary-foreground",
    live: false,
  };
}

/** Day heading in the tournament's own wall clock (invariant 14). */
export function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** The same day, short enough to sit on a chip ("Mon 17 Aug"). */
export function fmtDayShort(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Kick-off in the TOURNAMENT's wall clock (invariant 14 — the schedule of a
 * physical event reads in event-local time, matching the `day` grouping). */
export function fmtKickoff(iso: string | null, timeZone: string): string {
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

export function teamHit(m: PublicScheduleMatch, q: string): boolean {
  if (!q) return true;
  const h = m.home?.name?.toLowerCase() ?? "";
  const a = m.away?.name?.toLowerCase() ?? "";
  return h.includes(q) || a.includes(q);
}

export function LivePulse(): React.ReactElement {
  return (
    <span className="relative flex h-2 w-2">
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
export function TeamName({
  side,
  className,
  crestSize = "xs",
  wrap = false,
}: {
  side: { id: string; name: string; crest?: string } | null | undefined;
  className?: string;
  /** Scales with the surface: rows stay "xs", the live hero goes large. */
  crestSize?: CrestSize;
  /** Let a long school name WRAP instead of truncating (owner 2026-08-26:
   * "the school names should show full"). A row cannot afford this — its
   * columns would jump height — but a hero can, and "Holy Cross Higher
   * Secon…" is not how a parent recognises their child's team. */
  wrap?: boolean;
}): React.ReactElement {
  const { slug = "", id = "" } = useParams();
  if (!side) return <span className={className}>{t("TBD")}</span>;
  return (
    <Link
      to={routes.publicTeam(slug, id, side.id)}
      title={side.name}
      // Sits above the row's stretched match link (which covers the row), so
      // a team name still opens that team's page. `w-fit` keeps the link only
      // as wide as its content, leaving the rest of the row to that link.
      className={cn(
        className,
        "group pointer-events-auto relative z-10 flex w-fit max-w-full items-center gap-1.5 hover:text-primary",
      )}
    >
      <TeamCrest src={side.crest} name={side.name} size={crestSize} />
      {/* Truncation lives on the name, not the row: the crest never shrinks.
          The hero shows the name in FULL (owner 2026-08-26), and it fits on
          one line whenever it can — but `whitespace-nowrap` forced one line
          with no way to END, so "St. Thomas Higher Secondary School,
          Nagagaon ST-1" ran out of its grid cell and over the scoreline
          beside it (owner 2026-08-27). Dropping nowrap keeps every short name
          on a single line and lets only the long ones fall to a second,
          which is the one way to be both complete and inside the box. */}
      <span
        className={cn(
          "group-hover:underline",
          wrap ? "min-w-0 [overflow-wrap:anywhere]" : "truncate",
        )}
      >
        {side.name}
      </span>
    </Link>
  );
}

/** What the row's meta line is allowed to name. The surface around the row
 * already says some of it, and repeating it is what made the old rows
 * unreadable in a narrow column. */
export type MatchLabels =
  /** everything: time, court, competition chips, group chip */
  | "full"
  /** a time-slot header above already carries the kick-off */
  | "slot"
  /** a court lane above already carries the court */
  | "court"
  /** the section header already names the competition */
  | "group"
  /** panel groups: nothing but the status */
  | "none";

/** One side of the stacked row: name on the left, numbers hard right.
 *
 * Two lines, not a centred `Home 2 - 1 Away`: real school names run to
 * "Dimapur Government Higher Secondary School", and a three-column row split
 * them into ellipses on a phone and inside a court lane. Stacked, each name
 * gets the row's full width at every width there is.
 */
function SideRow({
  matchId,
  which,
  side,
  score,
  sets,
  winner,
  pending,
}: {
  matchId: string;
  which: "home" | "away";
  side: PublicScheduleMatch["home"];
  /** The number that IS the score right now: goals, the running set's points
   * while a set match is live, sets won once it is over. */
  score: number;
  /** Sets won, shown small beside the running points while a set match is
   * live; null on every other row. */
  sets: number | null;
  winner: boolean;
  pending: boolean;
}): React.ReactElement {
  return (
    <div
      data-testid={`side-${matchId}-${which}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
    >
      <TeamName
        side={side}
        className={cn(
          "truncate text-sm",
          winner ? "font-semibold text-foreground" : "font-medium",
        )}
      />
      {pending ? null : (
        <span className="flex items-center gap-2 font-tabular">
          {sets != null ? (
            <span
              data-testid={`sets-${matchId}-${which}`}
              className="min-w-[1.25rem] text-right text-xs text-muted-foreground"
            >
              {sets}
            </span>
          ) : null}
          <span
            data-testid={`score-${matchId}-${which}`}
            className={cn(
              "min-w-[1.25rem] text-right text-sm",
              winner ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {score}
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * The public match row: a meta line (kick-off, court, competition chips,
 * status) over the two sides stacked one per line with their numbers hard
 * right. The whole row is a stretched link to the match centre; the team
 * names stay their own links.
 */
export function MatchCard({
  match,
  timeZone,
  labels = "full",
  flag,
}: {
  match: PublicScheduleMatch;
  timeZone: string;
  labels?: MatchLabels;
  /** A "Next up" flag the court lane sets on the first unplayed match. */
  flag?: string;
}): React.ReactElement {
  const live = LIVE_STATUSES.has(match.status);
  const final = FINAL_STATUSES.has(match.status);
  const setView = liveSetView(match);
  // Chips show completed sets; the running set rides the side rows.
  const sets = setView ? setView.finished : (match.set_scores ?? []);
  const hasPens = match.home_pens != null && match.away_pens != null;
  const showTime = labels === "full" || labels === "court" || labels === "group";
  const showVenue = labels === "full" || labels === "slot" || labels === "group";
  const showLeaf = labels === "full" || labels === "slot" || labels === "court";
  const group =
    labels !== "none" ? shortGroup(match.group_label, match.leaf_label) : "";

  // The rightmost number is always "the score right now": the running set's
  // points while a set match is on (the number a parent is actually watching),
  // goals for a goal sport, sets won once the match is over. Sets ride beside
  // it in small type while the set is still running.
  const pending = !live && !final;
  const home = setView ? setView.points[0] : (match.home_score ?? 0);
  const away = setView ? setView.points[1] : (match.away_score ?? 0);
  const setsHome = setView ? setView.sets[0] : null;
  const setsAway = setView ? setView.sets[1] : null;
  const decided = final && home !== away;

  return (
    <li
      data-testid={`public-match-${match.id}`}
      className={cn(
        "relative flex flex-col gap-1.5 px-3 py-2.5 transition-colors hover:bg-accent focus-within:bg-accent sm:px-4",
        live && "border-l-2 border-primary bg-primary/[0.03]",
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
        {showVenue && match.venue ? <span>{match.venue}</span> : null}
        {showLeaf ? <LabelChips label={match.leaf_label} /> : null}
        {group ? (
          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[0.6875rem] font-medium text-secondary-foreground">
            {group}
          </span>
        ) : null}
        {flag ? (
          <span
            data-testid={`flag-${match.id}`}
            className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] font-medium text-primary"
          >
            {flag}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {/* Above the row's stretched match link (which covers the row), so
              this opens YouTube instead of the match centre. */}
          <WatchLiveLink
            url={match.watch_url}
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
      <div className="pointer-events-none relative z-10 flex flex-col gap-1">
        <SideRow
          matchId={match.id}
          which="home"
          side={match.home}
          score={home}
          sets={setsHome}
          winner={decided && home > away}
          pending={pending}
        />
        <SideRow
          matchId={match.id}
          which="away"
          side={match.away}
          score={away}
          sets={setsAway}
          winner={decided && away > home}
          pending={pending}
        />
      </div>
      {(live || final) && (sets.length > 0 || hasPens) ? (
        <p
          data-testid={`points-${match.id}`}
          className="pointer-events-none relative z-10 font-tabular text-xs text-muted-foreground"
        >
          {setView ? `${t("Sets")} ${setView.sets[0]}-${setView.sets[1]}` : ""}
          {setView && sets.length > 0 ? " · " : ""}
          {sets.map(([h, a]) => `${h}-${a}`).join(" · ")}
          {(setView || sets.length > 0) && hasPens ? " · " : ""}
          {hasPens ? `(${match.home_pens}-${match.away_pens} ${t("pens")})` : ""}
        </p>
      ) : null}
    </li>
  );
}
