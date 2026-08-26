import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Maximize2, Minimize2 } from "lucide-react";
import type {
  PublicScheduleMatch,
  PublicScheduleSide,
} from "@/api/tournaments";
import { TeamCrest } from "@/components/ui/TeamCrest";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import { routes } from "@/lib/routes";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  shortGroup,
  spotlightNextUp,
  spotlightPick,
  type RosterIndex,
  type SpotlightKind,
} from "./publicTournament";
import { LivePulse, TeamName, fmtKickoff } from "./publicMatchCard";

/**
 * The ONE match a competition is about, above everything else on its page
 * (owner 2026-08-26: "one section above the groups that shows the current one
 * or the next or completed", "that section should have button to show in full
 * screen view").
 *
 * It replaces the live band on a competition page. The band was a list of
 * whatever happened to be live, which on a category page is either one match
 * or none — and with nothing live it rendered nothing at all, so the sepak
 * page opened on a wall of finished group tables with no answer to "what is
 * happening now". The spotlight always has an answer: live, else next, else
 * the last result (`spotlightPick`).
 *
 * **It advances by itself**, because it holds no state of its own: the pick is
 * derived from the payload on every render, and the page already refreshes
 * over live updates. A live match that finishes stops matching `live` and the
 * next one takes the board on the following tick, which is what "once done we
 * will show the next match" asks for, with no timer to drift.
 *
 * ## The board (owner 2026-08-26, second pass)
 *
 * Full screen is not a bigger card, it is a different surface: a projector or
 * a TV beside the court, read from the back of a hall by people who cannot
 * touch it. Four rules come out of that, each from something the first cut got
 * wrong:
 *
 * 1. **Three bands, not one centred stack.** The section used to centre ALL
 *    its children, so the state and the exit button floated in the middle of
 *    the screen ("the exit full screen and the latest result text should be at
 *    the very top"). The board is now a top bar, a body that takes the space
 *    that is left, and a bottom bar — the two bars pinned, the match centred
 *    between them.
 * 2. **It scales with the screen, not with a breakpoint** ("it need to be
 *    bigger and responsive"). Every size on the board is `clamp(min, vw, max)`,
 *    so one board fills a phone held up at the court and a 4K screen across a
 *    hall without a media query between them.
 * 3. **A school's name is never cut** ("the school names should show full").
 *    Names wrap here instead of truncating: "Holy Cross Higher Secondary
 *    School ST-1" is how a parent recognises their child's team, and
 *    "Holy Cross Higher Secon…" is not. The sides stack the crest above the
 *    name so the full name has the whole column to wrap into.
 * 4. **Nothing is said twice.** The competition is named in the top bar, so
 *    the meta line drops it and keeps only what the group label ADDS
 *    ("3rd Place") via `shortGroup`; a kickoff shown as the centrepiece of an
 *    unplayed match is not repeated underneath itself.
 *
 * 5. **It names the people when the people ARE the competitors** (owner
 *    2026-08-26: "for sepak we dont have to show the names here but for tt we
 *    can"). Not a sport check: a side of one or two IS a person or a pair, and
 *    that is who the hall is watching. A regu of five, or a football eleven,
 *    is a team you name by its school, and five names a side would be clutter
 *    on a board read from 20m away. So the rule is the squad size, which makes
 *    badminton and any future 1v1 or 2v2 behave correctly with no new branch.
 *    The school stays the headline and the players sit under it, a little
 *    smaller ("the team names can be a bit smaller and then we can show the
 *    players names").
 *
 * The button asks the browser for real fullscreen (`requestFullscreen`, which
 * hides the browser's own chrome) AND lays the section out as a fixed
 * full-viewport board. Both, because the two fail differently: the API is
 * refused without a user gesture, is absent on older iOS Safari, and does
 * nothing inside an iframe, while the CSS alone would leave the address bar
 * and tab strip on the projector. State drives the CSS layer, so the board is
 * always full-viewport even when the API declines.
 */

const KIND_LABEL: Record<SpotlightKind, string> = {
  live: "Now playing",
  next: "Up next",
  done: "Latest result",
};

/** Every size on the board, in one place. `clamp` rather than breakpoints:
 * this surface is read from 1m away on a phone and from 20m away on a hall
 * screen, and the middle term is what carries it between the two. */
const BOARD = {
  bar: "text-[clamp(0.875rem,1.7vw,2rem)]",
  // Smaller than the first cut, to leave room under it for the people.
  name: "text-[clamp(1rem,2.7vw,3.25rem)]",
  player: "text-[clamp(0.875rem,2.1vw,2.5rem)]",
  score: "text-[clamp(3.5rem,15vw,16rem)]",
  clock: "text-[clamp(2.5rem,10vw,10rem)]",
  meta: "text-[clamp(0.875rem,1.9vw,2rem)]",
  sets: "text-[clamp(0.875rem,1.6vw,1.75rem)]",
  crest:
    "h-[clamp(3rem,8vw,9rem)] w-[clamp(3rem,8vw,9rem)] text-[clamp(0.875rem,2.2vw,2.5rem)]",
} as const;

function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? null;
}

/** One side on the BOARD: crest above the name, name in full. Deliberately not
 * `TeamName` — that is a row component, it truncates and it links, and a
 * screen nobody can tap has no use for either. */
function BoardSide({
  side,
  players,
}: {
  side: PublicScheduleSide | null;
  /** Who is actually on court. Empty = a squad too big to name here. */
  players: string[];
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col items-center gap-[clamp(0.5rem,1.5vw,1.5rem)] text-center">
      <TeamCrest
        src={side?.crest}
        name={side?.name ?? ""}
        className={BOARD.crest}
      />
      <div className="flex min-w-0 max-w-full flex-col gap-[0.25em]">
        <span
          className={cn(
            "max-w-full font-semibold leading-tight [overflow-wrap:anywhere]",
            BOARD.name,
          )}
        >
          {side?.name ?? t("TBD")}
        </span>
        {players.map((n) => (
          <span
            key={n}
            className={cn(
              "max-w-full font-medium leading-tight text-muted-foreground [overflow-wrap:anywhere]",
              BOARD.player,
            )}
          >
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The names to print under each side, or none.
 *
 * Both sides or neither: a board that named one pair and not the other would
 * read as missing data rather than as a rule. The cap is what makes it a rule
 * — at most two on a side means the competitors ARE these people, which is
 * true of singles and doubles in any sport and false of every squad game.
 */
const NAMEABLE_SQUAD = 2;

function boardSheets(
  m: PublicScheduleMatch,
  rosters: RosterIndex | undefined,
): { home: string[]; away: string[] } {
  const none = { home: [], away: [] };
  if (!rosters) return none;
  const home = m.home ? (rosters.get(m.home.id) ?? []) : [];
  const away = m.away ? (rosters.get(m.away.id) ?? []) : [];
  const biggest = Math.max(home.length, away.length);
  if (biggest === 0 || biggest > NAMEABLE_SQUAD) return none;
  return { home: home.map((p) => p.name), away: away.map((p) => p.name) };
}

export function CompetitionSpotlight({
  matches,
  timeZone,
  title,
  rosters,
}: {
  /** Every match of ONE competition. The pick is made here, not by the page. */
  matches: PublicScheduleMatch[];
  timeZone: string;
  /** The competition's own name, so the board says what it is showing. */
  title?: string;
  /** Team sheets, so a singles or doubles board can name the players. */
  rosters?: RosterIndex;
}): React.ReactElement | null {
  const [board, setBoard] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // Escape, the browser's own exit button and a lost fullscreen all have to
  // put the section back; watching the event is the only reading that covers
  // every one of them.
  useEffect(() => {
    const onChange = (): void => {
      if (!fullscreenElement()) setBoard(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      // The CSS board can be open without the API ever engaging, and then no
      // fullscreenchange is coming.
      if (e.key === "Escape") setBoard(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const pick = spotlightPick(matches);
  if (!pick) return null;
  const { match: m, kind } = pick;
  const next = board ? spotlightNextUp(matches, m) : null;
  const comp = title || m.leaf_label;

  const toggle = (): void => {
    const goingIn = !board;
    setBoard(goingIn);
    // Best effort in both directions: a refused request still leaves the CSS
    // board up, and a browser already out of fullscreen rejects the exit.
    try {
      if (goingIn) void ref.current?.requestFullscreen?.().catch(() => {});
      else if (fullscreenElement())
        void document.exitFullscreen?.().catch(() => {});
    } catch {
      /* unsupported: the CSS board carries it */
    }
  };

  const sv = liveSetView(m);
  const score: [number, number] = sv
    ? sv.points
    : [m.home_score ?? 0, m.away_score ?? 0];
  const played = kind !== "next";
  const hasPens = m.home_pens != null && m.away_pens != null;
  const kickoff = fmtKickoff(m.scheduled_at, timeZone);
  // What the group label ADDS beyond the competition — "3rd Place", "Group A".
  // A knockout's group_label IS its competition label, so unfiltered it
  // reprinted the heading one line below itself.
  const stageBit = shortGroup(m.group_label, m.leaf_label);
  const sheets = boardSheets(m, rosters);
  // An unplayed match wears its kickoff as the centrepiece; repeating it in the
  // meta line under itself is the same fact twice.
  const meta = [stageBit, played ? kickoff : "", m.venue].filter(Boolean);

  const heading = (
    <>
      {kind === "live" ? <LivePulse /> : null}
      <h2
        className={cn(
          "font-semibold",
          board ? BOARD.bar : "text-sm",
          kind === "live" && "text-primary",
        )}
      >
        {t(KIND_LABEL[kind])}
      </h2>
      {board ? (
        <span className={cn("min-w-0 truncate text-muted-foreground", BOARD.bar)}>
          {comp}
        </span>
      ) : null}
      <button
        type="button"
        data-testid="spotlight-fullscreen"
        aria-pressed={board}
        onClick={toggle}
        className={cn(
          "ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          board
            ? "h-[clamp(2.25rem,4vw,4rem)] px-[clamp(0.75rem,1.5vw,1.5rem)] text-[clamp(0.75rem,1.5vw,1.5rem)]"
            : "h-9 px-2.5 text-xs",
        )}
      >
        {board ? (
          <Minimize2 aria-hidden="true" className="h-[1em] w-[1em]" />
        ) : (
          <Maximize2 aria-hidden="true" className="h-[1em] w-[1em]" />
        )}
        {board ? t("Exit full screen") : t("Full screen")}
      </button>
    </>
  );

  const centre = played ? (
    <Link
      to={routes.liveViewer(m.id)}
      aria-label={t("Open the match centre")}
      className={cn(
        "block rounded-md px-1 font-tabular font-semibold tabular-nums leading-none transition-colors hover:text-primary",
        board ? BOARD.score : "text-4xl sm:text-6xl",
      )}
    >
      {score[0]}
      <span className="px-[0.15em] text-muted-foreground">-</span>
      {score[1]}
    </Link>
  ) : (
    <Link
      to={routes.liveViewer(m.id)}
      aria-label={t("Open the match centre")}
      className={cn(
        "block rounded-md px-1 font-tabular font-semibold leading-none text-muted-foreground transition-colors hover:text-primary",
        board ? BOARD.clock : "text-3xl sm:text-4xl",
      )}
    >
      {kickoff}
    </Link>
  );

  const body = (
    <>
      <div
        className={cn(
          "mx-auto grid w-full grid-cols-1 items-center sm:grid-cols-[1fr_auto_1fr]",
          board
            ? "max-w-[95vw] gap-[clamp(0.75rem,3vw,4rem)]"
            : "max-w-xl gap-3 sm:gap-6",
        )}
      >
        {board ? (
          <BoardSide side={m.home} players={sheets.home} />
        ) : (
          <TeamName
            side={m.home}
            crestSize="lg"
            wrap
            className="mx-auto text-sm font-medium sm:mx-0 sm:ml-auto sm:text-base"
          />
        )}
        <div className="flex flex-col items-center gap-[0.35em]">
          {centre}
          {sv ? (
            <p
              className={cn(
                "font-tabular text-muted-foreground",
                board ? BOARD.sets : "text-sm",
              )}
            >
              {t("Set")} {sv.setNo} · {t("Sets")} {sv.sets[0]}-{sv.sets[1]}
            </p>
          ) : null}
          {hasPens ? (
            <p
              className={cn(
                "font-tabular text-muted-foreground",
                board ? BOARD.sets : "text-xs",
              )}
            >
              {t("Pens")} {m.home_pens}-{m.away_pens}
            </p>
          ) : null}
          {sv && sv.finished.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-[0.4em]">
              {sv.finished.map((s, i) => (
                <span
                  key={i}
                  className={cn(
                    "rounded-md bg-muted px-[0.5em] py-[0.15em] font-tabular text-muted-foreground",
                    board ? BOARD.sets : "text-xs",
                  )}
                >
                  {s[0]}-{s[1]}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {board ? (
          <BoardSide side={m.away} players={sheets.away} />
        ) : (
          <TeamName
            side={m.away}
            crestSize="lg"
            wrap
            className="mx-auto text-sm font-medium sm:mx-0 sm:mr-auto sm:text-base"
          />
        )}
      </div>

      {meta.length ? (
        <p
          data-testid="spotlight-meta"
          className={cn(
            "flex flex-wrap items-center justify-center gap-x-[0.6em] gap-y-1 text-muted-foreground",
            board ? BOARD.meta : "text-xs",
          )}
        >
          {meta.map((bit, i) => (
            <span key={bit} className={cn(i === 1 && "font-tabular")}>
              {bit}
            </span>
          ))}
        </p>
      ) : null}

      {kind === "live" ? (
        <div className="flex justify-center">
          <WatchLiveLink
            url={m.watch_url}
            testid={`watch-spotlight-${m.id}`}
            label={t("Watch this match live on YouTube")}
          />
        </div>
      ) : null}
    </>
  );

  if (!board) {
    return (
      <section
        ref={ref}
        data-testid="competition-spotlight"
        data-kind={kind}
        data-board="off"
        className="flex flex-col gap-3 border-b border-border bg-card p-3 sm:p-4"
      >
        <div className="flex items-center gap-2">{heading}</div>
        {body}
      </section>
    );
  }

  return (
    <section
      ref={ref}
      data-testid="competition-spotlight"
      data-kind={kind}
      data-board="on"
      className="fixed inset-0 z-50 flex flex-col bg-card"
    >
      {/* Pinned to the very top, where the owner asked for it: on a screen
          across a hall the state of play is the first thing read, and the way
          out must not be hunted for. */}
      <div className="flex shrink-0 items-center gap-[clamp(0.5rem,1.2vw,1.5rem)] border-b border-border px-[clamp(0.75rem,2.5vw,3rem)] py-[clamp(0.5rem,1.2vw,1.25rem)]">
        {heading}
      </div>
      {/* The match takes every pixel the two bars leave. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-[clamp(0.75rem,2.5vw,3rem)] overflow-y-auto px-[clamp(0.75rem,2.5vw,3rem)] py-[clamp(0.75rem,2vw,2rem)]">
        {body}
      </div>
      {/* Only on the board: a screen cannot be scrolled by the people reading
          it, so what follows is named for them. */}
      {next ? (
        <p
          data-testid="spotlight-next"
          className={cn(
            "flex shrink-0 flex-wrap items-center justify-center gap-x-[0.6em] gap-y-1 border-t border-border px-[clamp(0.75rem,2.5vw,3rem)] py-[clamp(0.5rem,1.2vw,1.25rem)] text-muted-foreground",
            BOARD.meta,
          )}
        >
          <span className="font-semibold text-foreground">{t("Up next")}</span>
          <span className="font-tabular">
            {fmtKickoff(next.scheduled_at, timeZone)}
          </span>
          <span className="[overflow-wrap:anywhere]">
            {next.home?.name ?? t("TBD")} {t("vs")} {next.away?.name ?? t("TBD")}
          </span>
        </p>
      ) : null}
    </section>
  );
}
