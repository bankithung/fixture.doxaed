import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Maximize2, Minimize2 } from "lucide-react";
import type {
  PublicScheduleMatch,
  PublicScheduleSide,
} from "@/api/tournaments";
import { crestInitials } from "@/components/ui/TeamCrest";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import { routes } from "@/lib/routes";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
  shortGroup,
  spotlightNextUp,
  spotlightPick,
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
  clock: "text-[clamp(2.5rem,10vw,10rem)]",
  meta: "text-[clamp(0.875rem,1.9vw,2rem)]",
  // The sets-won line qualifies the score, so it stays the quiet one.
  sets: "text-[clamp(1rem,3vw,3.5rem)]",
  // The three that carry the board. Sized `min(vw, vh)` because WIDTH is not
  // the binding constraint here — HEIGHT is: a side column is the score
  // stacked on the crest, sharing the viewport's height with however many set
  // rows the match has run to.
  //
  // The vh term is a CEILING for short screens, not the everyday size, and
  // getting that wrong is easy: on 16:9 one vh is only 0.5625vw, so `24vh`
  // reads as 13.5vw and silently overrules a 19vw intent. (It did — the first
  // pass at "bigger" shrank the score from 288px to 259px on 1080p.) So each
  // vh term is set ABOVE its vw term at 16:9 and only takes over on something
  // wider, and the comments below carry the 1080p figure the numbers produce.
  //
  // Owner 2026-08-27: "make the logos a bit smaller and the scores bigger."
  score: "text-[clamp(3.5rem,min(20vw,38vh),24rem)]", // 384px on 1080p
  setRow: "text-[clamp(1.25rem,min(5vw,9vh),5.5rem)]", // 96px on 1080p
  // The crest identifies the side on its own, but it is the quieter half of
  // the pair now: the numbers are what the hall is actually watching. This is
  // a HEIGHT cap only — the width follows the logo's own aspect ratio, so
  // nothing is ever boxed or cut (see BoardCrest).
  crestH: "h-[clamp(3.5rem,min(13vw,26vh),18rem)]", // 250px tall on 1080p
  crestBox:
    "h-[clamp(3.5rem,min(13vw,26vh),18rem)] w-[clamp(3.5rem,min(13vw,26vh),18rem)] text-[clamp(1.25rem,min(4vw,7vh),4.5rem)]",
} as const;

function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? null;
}

/** The board's crest: the logo AS IT IS, at its own aspect ratio.
 *
 * Deliberately not `TeamCrest`. That component is a circular avatar for dense
 * rows — a fixed SQUARE box with `overflow-hidden`, a border, a card
 * background and `object-cover` — and every one of those is wrong for a badge
 * being read from the back of a hall, where the logo is the only thing naming
 * the side.
 *
 * It also could not be talked out of it from the outside: `TeamCrest` appends
 * its own `object-cover` AFTER the caller's `className`, so a passed
 * `object-contain` loses the tailwind-merge race and the crop stayed (owner
 * 2026-08-27: "some logos are cropped"). Overriding it from here would have
 * been luck; a school badge is usually wide, and a square avatar crop cuts
 * exactly the part being read.
 *
 * So: a height cap and `w-auto`. The width follows the image, nothing is
 * boxed, framed, padded or cut — "keep it as it is". Only the initials
 * fallback keeps a box, because letters need a shape to sit in.
 */
function BoardCrest({
  side,
}: {
  side: PublicScheduleSide | null;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const src = side?.crest;
  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        data-testid="team-crest-fallback"
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-2xl bg-muted font-semibold text-muted-foreground",
          BOARD.crestBox,
        )}
      >
        {crestInitials(side?.name ?? "")}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      decoding="async"
      data-testid="team-crest"
      onError={() => setFailed(true)}
      className={cn("w-auto max-w-full object-contain", BOARD.crestH)}
    />
  );
}

/** One side on the BOARD: its crest with its OWN score under it, in one column
 * (owner 2026-08-27: "the score and the logo in one column").
 *
 * The board carries no names at all — "we will keep only the team logo and the
 * scores" — so the crest does the whole job of saying who this is, and stacking
 * the number with it is what ties the two together: a single combined "11 - 7"
 * in the middle belonged to neither badge, and the eye had to work out which
 * end went with which side. The score sits ON TOP of the badge, so the numbers
 * share one eye line across the board and the badges read as a base.
 *
 * The badge itself is `BoardCrest` (above) — shown whole, at its own aspect
 * ratio, rather than through the shared circular avatar. And it is no longer
 * decorative, so the team name rides along in an `sr-only` span: a sighted
 * viewer reads the badge, a screen reader still gets the team, and neither is
 * left with nothing.
 */
function BoardSide({
  side,
  score,
}: {
  side: PublicScheduleSide | null;
  /** This side's own number, or null before a ball is played. */
  score: number | null;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col items-center gap-[0.1em]">
      {/* Score ABOVE the badge (owner 2026-08-27: "keep the logo down and the
          score up"). The numbers are what changes and what the hall is
          watching, so they sit on the eye line across the whole board, with
          the badges reading as a base underneath them. */}
      {score !== null ? (
        <span
          data-testid="spotlight-side-score"
          className={cn(
            "font-tabular font-semibold tabular-nums leading-none",
            BOARD.score,
          )}
        >
          {score}
        </span>
      ) : null}
      <BoardCrest side={side} />
      <span className="sr-only">{side?.name ?? t("TBD")}</span>
    </div>
  );
}
export function CompetitionSpotlight({
  matches,
  timeZone,
  title,
}: {
  /** Every match of ONE competition. The pick is made here, not by the page. */
  matches: PublicScheduleMatch[];
  timeZone: string;
  /** The competition's own name, so the board says what it is showing. */
  title?: string;
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

  /** EVERY set on its own row, the one in play included (owner 2026-08-27:
   * "all the set scores should be shown").
   *
   * Read straight off `set_scores` rather than from `liveSetView`, which is
   * built for the card and answers a different question: it drops the last row
   * because that is the set in play and the card shows it as the headline
   * score, and it returns null entirely once a match is not IN_PLAY — so a
   * COMPLETED match was reaching the board with no sets on it at all, which is
   * exactly when every set matters most.
   *
   * A board is read by running an eye down a column; the wrapped strip of
   * chips the card uses gives it nothing to follow and at board size would run
   * off the screen sideways. */
  const setRows = m.set_scores ?? [];
  /** While a set is still being played it is the LAST row, and nobody has won
   * it yet — so it is flagged rather than scored like a finished set. */
  const inPlayRow = sv ? setRows.length - 1 : -1;
  /** The CARD keeps its old, narrower reading: finished sets only, as chips.
   * It sits in a page you can scroll, beside a scoreline that already shows
   * the set in play — the board's "show me everything" is a board rule. */
  const cardSetChips = sv?.finished ?? [];

  /** THE BOARD (owner 2026-08-27). No names anywhere — "we will keep only the
   * team logo and the scores". Two rows, in reading order:
   *
   *   1. the live score alone at the top, with nothing beside it to compete
   *      for the eye from across a hall,
   *   2. the two crests wide apart with the finished sets stacked BETWEEN
   *      them, so a set score is read as "this side won that one".
   *
   * Every size is a `clamp`, so the same board is legible on a phone at the
   * court and on a projector at the back of a hall with no breakpoint jump.
   */
  const boardTop = (
    <Link
      to={routes.liveViewer(m.id)}
      aria-label={t("Open the match centre")}
      className="grid w-full max-w-[96vw] grid-cols-[1fr_auto_1fr] items-center gap-[clamp(0.5rem,2.5vw,3.5rem)] rounded-xl transition-colors hover:text-primary"
    >
      {/* Each side is ONE column: badge, then that side's own number. */}
      <BoardSide side={m.home} score={played ? score[0]! : null} />

      {/* Between them, what belongs to neither side on its own. */}
      <div className="flex flex-col items-center gap-[0.1em]">
        {!played ? (
          <span
            className={cn(
              "font-tabular font-semibold leading-none text-muted-foreground",
              BOARD.clock,
            )}
          >
            {kickoff}
          </span>
        ) : null}
        {sv ? (
          <p
            data-testid="spotlight-sets-won"
            className={cn("font-tabular text-muted-foreground", BOARD.sets)}
          >
            {t("Sets")} {sv.sets[0]}-{sv.sets[1]}
          </p>
        ) : null}
        {hasPens ? (
          <p className={cn("font-tabular text-muted-foreground", BOARD.sets)}>
            {t("Pens")} {m.home_pens}-{m.away_pens}
          </p>
        ) : null}
        {setRows.length > 0 ? (
          <div
            data-testid="spotlight-set-rows"
            className="flex flex-col items-center gap-[0.12em]"
          >
            {setRows.map((set, i) => {
              const live = i === inPlayRow;
              return (
                <p
                  key={i}
                  data-live={live ? "" : undefined}
                  className={cn(
                    "font-tabular font-semibold leading-none tabular-nums",
                    BOARD.setRow,
                  )}
                >
                  {/* The side that took the set is the one at full strength —
                      the only per-set cue left once the names are gone. On the
                      set still in play that reads as who is leading. */}
                  <span
                    className={cn(
                      set[0]! > set[1]!
                        ? live
                          ? "text-primary"
                          : "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {set[0]}
                  </span>
                  <span className="px-[0.25em] text-muted-foreground">-</span>
                  <span
                    className={cn(
                      set[1]! > set[0]!
                        ? live
                          ? "text-primary"
                          : "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {set[1]}
                  </span>
                </p>
              );
            })}
          </div>
        ) : null}
      </div>

      <BoardSide side={m.away} score={played ? score[1]! : null} />
    </Link>
  );

  const cardGrid = (
    <div className="mx-auto grid w-full max-w-xl grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr] sm:gap-6">
      <TeamName
        side={m.home}
        crestSize="lg"
        wrap
        className="mx-auto text-sm font-medium sm:mx-0 sm:ml-auto sm:text-base"
      />
      <div className="flex flex-col items-center gap-[0.35em]">
        {centre}
        {sv ? (
          <p className="font-tabular text-sm text-muted-foreground">
            {t("Set")} {sv.setNo} · {t("Sets")} {sv.sets[0]}-{sv.sets[1]}
          </p>
        ) : null}
        {hasPens ? (
          <p className="font-tabular text-xs text-muted-foreground">
            {t("Pens")} {m.home_pens}-{m.away_pens}
          </p>
        ) : null}
        {cardSetChips.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-[0.4em]">
            {cardSetChips.map((set, i) => (
              <span
                key={i}
                className="rounded-md bg-muted px-[0.5em] py-[0.15em] font-tabular text-xs text-muted-foreground"
              >
                {set[0]}-{set[1]}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <TeamName
        side={m.away}
        crestSize="lg"
        wrap
        className="mx-auto text-sm font-medium sm:mx-0 sm:mr-auto sm:text-base"
      />
    </div>
  );

  const body = (
    <>
      {board ? boardTop : cardGrid}

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
