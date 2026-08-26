import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Clock, Maximize2, MapPin, Minimize2 } from "lucide-react";
import type { PublicScheduleMatch } from "@/api/tournaments";
import { WatchLiveLink } from "@/features/live/WatchLiveLink";
import { routes } from "@/lib/routes";
import { liveSetView } from "@/lib/setDisplay";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import {
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
 * or none — and on a category with nothing live it was simply absent, so the
 * sepak page opened on a wall of finished group tables with no answer to "what
 * is happening now". The spotlight always has an answer: live, else next, else
 * the last result (`spotlightPick`).
 *
 * **Full screen is the point, not a flourish.** This is what goes on the hall's
 * projector or a TV beside the court, so the button asks the browser for real
 * fullscreen (`requestFullscreen`, which hides the browser's own chrome) AND
 * lays the section out as a fixed full-viewport board. Both, because the two
 * fail in different ways: the API is refused without a user gesture, is absent
 * on older iOS Safari, and does nothing inside an iframe, while the CSS alone
 * would leave the address bar and tab strip on the projector. The CSS layer is
 * what the state drives, so the board is always full-viewport even when the
 * API declines.
 *
 * **It advances by itself**, because it holds no state of its own: the pick is
 * derived from the payload on every render, and the page already refreshes
 * over live updates. A live match that finishes stops matching `live` and the
 * next one takes the board on the following tick, which is what "once done we
 * will show the next match" asks for, with no timer to drift.
 *
 * On the board, and only there, the match after this one is named underneath.
 * A spectator watching a screen cannot scroll it, so the one thing they would
 * have gone looking for is put in front of them.
 */

const KIND_LABEL: Record<SpotlightKind, string> = {
  live: "Now playing",
  next: "Up next",
  done: "Latest result",
};

/** Does this browser offer real fullscreen, and are we in it? Kept in one
 * place so the component never branches on the vendor-prefix zoo inline. */
function fullscreenElement(): Element | null {
  return document.fullscreenElement ?? null;
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

  const toggle = (): void => {
    const goingIn = !board;
    setBoard(goingIn);
    // Best effort in both directions: a refused request still leaves the CSS
    // board up, and a browser already out of fullscreen rejects the exit.
    try {
      if (goingIn) void ref.current?.requestFullscreen?.().catch(() => {});
      else if (fullscreenElement()) void document.exitFullscreen?.().catch(() => {});
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

  return (
    <section
      ref={ref}
      data-testid="competition-spotlight"
      data-kind={kind}
      data-board={board ? "on" : "off"}
      className={cn(
        "flex flex-col gap-3 border-b border-border bg-card p-3 sm:p-4",
        board &&
          "fixed inset-0 z-50 justify-center overflow-y-auto border-0 p-6 sm:p-10",
      )}
    >
      <div className="flex items-center gap-2">
        {kind === "live" ? <LivePulse /> : null}
        <h2
          className={cn(
            "text-sm font-semibold",
            board && "text-lg sm:text-2xl",
            kind === "live" && "text-primary",
          )}
        >
          {t(KIND_LABEL[kind])}
        </h2>
        {board && title ? (
          <span className="truncate text-sm text-muted-foreground sm:text-lg">
            {title}
          </span>
        ) : null}
        <button
          type="button"
          data-testid="spotlight-fullscreen"
          aria-pressed={board}
          onClick={toggle}
          className="ml-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {board ? (
            <Minimize2 aria-hidden="true" className="h-4 w-4" />
          ) : (
            <Maximize2 aria-hidden="true" className="h-4 w-4" />
          )}
          {board ? t("Exit full screen") : t("Full screen")}
        </button>
      </div>

      {/* The matchup. One column on a phone, three from `sm` up, and on the
          board it grows into the space instead of sitting in a small card. */}
      <div
        className={cn(
          "mx-auto grid w-full grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr] sm:gap-6",
          board ? "max-w-6xl gap-6 sm:gap-12" : "max-w-xl",
        )}
      >
        <div className="min-w-0 text-center sm:text-right">
          <TeamName
            side={m.home}
            crestSize={board ? "xl" : "lg"}
            className={cn(
              "mx-auto justify-center text-sm font-medium sm:mx-0 sm:ml-auto sm:justify-end sm:text-base",
              board && "text-xl sm:text-3xl",
            )}
          />
        </div>
        <div className="text-center">
          {played ? (
            <Link
              to={routes.liveViewer(m.id)}
              aria-label={t("Open the match centre")}
              className={cn(
                "block rounded-md px-1 font-tabular font-semibold tabular-nums transition-colors hover:text-primary",
                board ? "text-6xl sm:text-[8rem]" : "text-4xl sm:text-6xl",
              )}
            >
              {score[0]}
              <span className="px-2 text-muted-foreground">-</span>
              {score[1]}
            </Link>
          ) : (
            <Link
              to={routes.liveViewer(m.id)}
              aria-label={t("Open the match centre")}
              className={cn(
                "block rounded-md px-1 font-tabular font-semibold text-muted-foreground transition-colors hover:text-primary",
                board ? "text-5xl sm:text-7xl" : "text-3xl sm:text-4xl",
              )}
            >
              {fmtKickoff(m.scheduled_at, timeZone)}
            </Link>
          )}
          {sv ? (
            <p
              className={cn(
                "mt-1 font-tabular text-sm text-muted-foreground",
                board && "text-base sm:text-2xl",
              )}
            >
              {t("Set")} {sv.setNo} · {t("Sets")} {sv.sets[0]}-{sv.sets[1]}
            </p>
          ) : null}
          {hasPens ? (
            <p className="mt-1 font-tabular text-xs text-muted-foreground">
              {t("Pens")} {m.home_pens}-{m.away_pens}
            </p>
          ) : null}
        </div>
        <div className="min-w-0 text-center sm:text-left">
          <TeamName
            side={m.away}
            crestSize={board ? "xl" : "lg"}
            className={cn(
              "mx-auto justify-center text-sm font-medium sm:mx-0 sm:mr-auto sm:justify-start sm:text-base",
              board && "text-xl sm:text-3xl",
            )}
          />
        </div>
      </div>

      {sv && sv.finished.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-1.5">
          {sv.finished.map((s, i) => (
            <span
              key={i}
              className={cn(
                "rounded-md bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground",
                board && "px-3 py-1 text-base sm:text-xl",
              )}
            >
              {s[0]}-{s[1]}
            </span>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          "flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
          board && "text-sm sm:text-lg",
        )}
      >
        {m.scheduled_at ? (
          <span className="inline-flex items-center gap-1.5">
            <Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="font-tabular">
              {fmtKickoff(m.scheduled_at, timeZone)}
            </span>
          </span>
        ) : null}
        {m.venue ? (
          <span className="inline-flex items-center gap-1.5">
            <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            {m.venue}
          </span>
        ) : null}
        {m.group_label ? <span>{m.group_label}</span> : null}
      </div>

      {kind === "live" ? (
        <div className="flex justify-center">
          <WatchLiveLink
            url={m.watch_url}
            testid={`watch-spotlight-${m.id}`}
            label={t("Watch this match live on YouTube")}
          />
        </div>
      ) : null}

      {/* Only on the board: a screen cannot be scrolled by the people reading
          it, so what follows is named for them. */}
      {next ? (
        <p
          data-testid="spotlight-next"
          className="mx-auto flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground sm:text-lg"
        >
          <span className="font-medium text-foreground">{t("Up next")}</span>
          <span className="font-tabular">
            {fmtKickoff(next.scheduled_at, timeZone)}
          </span>
          <span>
            {next.home?.name ?? t("TBD")} {t("vs")} {next.away?.name ?? t("TBD")}
          </span>
        </p>
      ) : null}
    </section>
  );
}
