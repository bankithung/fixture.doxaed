import { Minus } from "lucide-react";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { statusMeta, type SetProgress } from "./shared";

/** Shared visual core of the set-sport consoles: the tappable score zones,
 * the best-of game track and the status chip. Pure presentation — taps,
 * rules and persistence stay in the owning console module. */

export function StatusChip({ status }: { status: string }): React.ReactElement {
  const sm = statusMeta(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        sm.badge,
      )}
    >
      {sm.live ? (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
        </span>
      ) : (
        <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} />
      )}
      {t(sm.label)}
    </span>
  );
}

export interface TapZonesProps {
  homeName: string;
  awayName: string;
  /** The big numerals: current-game points in play, games won once final. */
  homeValue: number;
  awayValue: number;
  /** Side whose panel carries the serve dot (null hides it). */
  server: 0 | 1 | null;
  /** Taps score points. Off while final or once the match is decided. */
  canScore: boolean;
  /** The per-side minus row (mis-tap undo). Off once final. */
  canEdit: boolean;
  /** What one tap adds (the generic console taps by its chosen step). */
  step?: number;
  onPoint: (side: 0 | 1) => void;
  onMinus: (side: 0 | 1) => void;
}

/** Two giant tap zones: the scoreboard IS the point button. A tap on a
 * team's half scores for that team; the small minus row below undoes a
 * mis-tap without opening the corrections editor. */
export function TapZones({
  homeName,
  awayName,
  homeValue,
  awayValue,
  server,
  canScore,
  canEdit,
  step = 1,
  onPoint,
  onMinus,
}: TapZonesProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5 sm:gap-3">
        {([0, 1] as const).map((side) => {
          const name = side === 0 ? homeName : awayName;
          const value = side === 0 ? homeValue : awayValue;
          const serving = server === side;
          return (
            <button
              key={side}
              type="button"
              data-testid={side === 0 ? "point-home" : "point-away"}
              disabled={!canScore}
              onClick={() => onPoint(side)}
              aria-label={
                canScore ? `${t("Point")} ${name}` : `${name} ${value}`
              }
              className={cn(
                "group relative flex min-h-[8.5rem] select-none flex-col items-center justify-center gap-1 rounded-lg border bg-background px-2 py-4 transition-[transform,border-color,background-color] [touch-action:manipulation] sm:min-h-[10rem]",
                serving ? "border-primary/50" : "border-border",
                canScore &&
                  "cursor-pointer hover:bg-accent/40 active:scale-[0.98] active:bg-accent/60",
              )}
            >
              {canScore ? (
                <span
                  aria-hidden="true"
                  className="absolute right-2 top-2 rounded-md bg-primary/10 px-1.5 py-0.5 font-tabular text-[0.6875rem] font-medium text-primary opacity-70 transition-opacity group-active:opacity-100"
                >
                  +{step}
                </span>
              ) : null}
              <span className="flex w-full min-w-0 items-center justify-center gap-1.5">
                {serving ? (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full bg-primary"
                  />
                ) : null}
                <span className="truncate text-xs font-medium sm:text-sm">
                  {name}
                </span>
              </span>
              <span
                data-testid={side === 0 ? "points-home" : "points-away"}
                className="font-tabular text-6xl font-semibold leading-none tabular-nums sm:text-7xl"
              >
                {value}
              </span>
              <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                {side === 0 ? t("Home") : t("Away")}
              </span>
            </button>
          );
        })}
      </div>
      {canEdit ? (
        <div className="grid grid-cols-2 gap-1.5 sm:gap-3">
          {([0, 1] as const).map((side) => (
            <button
              key={side}
              type="button"
              data-testid={side === 0 ? "minus-home" : "minus-away"}
              aria-label={`${side === 0 ? homeName : awayName} ${t("minus")} ${step}`}
              disabled={(side === 0 ? homeValue : awayValue) <= 0}
              onClick={() => onMinus(side)}
              className="inline-flex h-9 items-center justify-center gap-1 rounded-lg border border-border text-xs font-medium text-muted-foreground transition-colors [touch-action:manipulation] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
            >
              <Minus aria-hidden="true" className="h-3.5 w-3.5" />
              {step === 1 ? t("Point") : step}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface GameTrackProps {
  progress: SetProgress;
  /** Sport's own word for a period ("Game", "Set"). */
  periodLabel: string;
  /** Finished periods as score pairs, in order. */
  finished: (number | string)[][];
  /** Name of the clinching side (caption), when decided. */
  winnerName: string | null;
  isFinal: boolean;
}

/** The best-of strip: every game the rule allows, as done chips, the game in
 * play, and the games still ahead — so the scorer always sees how many
 * stages are left. The caption carries the rule ("first to 2 · best of 3")
 * or the clinched result. */
export function GameTrack({
  progress,
  periodLabel,
  finished,
  winnerName,
  isFinal,
}: GameTrackProps): React.ReactElement {
  const { bestOf, need, setNo, homeSets, awaySets, decided } = progress;
  const over = decided || isFinal;
  const slots: React.ReactElement[] = [];
  finished.forEach((pair, i) => {
    slots.push(
      <span
        key={`done-${i}`}
        className="rounded-md bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground"
      >
        {pair[0]}-{pair[1]}
      </span>,
    );
  });
  if (!over) {
    slots.push(
      <span
        key="current"
        className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-primary" />
        {periodLabel} {setNo}
      </span>,
    );
    for (let i = setNo + 1; i <= bestOf; i += 1) {
      slots.push(
        <span
          key={`ahead-${i}`}
          className="rounded-md border border-border/70 px-2 py-0.5 text-xs text-muted-foreground/60"
        >
          {periodLabel} {i}
        </span>,
      );
    }
  }
  return (
    <div
      data-testid="game-track"
      className="flex flex-col items-center gap-1.5"
      aria-label={`${periodLabel}s ${homeSets}-${awaySets}, ${t("best of")} ${bestOf}`}
    >
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {slots}
      </div>
      <p className="font-tabular text-xs text-muted-foreground">
        {over && winnerName
          ? `${winnerName} ${t("wins")} ${Math.max(homeSets, awaySets)}-${Math.min(homeSets, awaySets)}`
          : `${t("First to")} ${need} · ${t("best of")} ${bestOf}`}
      </p>
    </div>
  );
}
