import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { statusMeta, type SetProgress } from "./shared";

/** Shared visual core of the set-sport consoles: the score pad (score plus
 * an explicit Point button per side), the best-of game track, the
 * next-game prompt and the status chip. Pure presentation — taps, rules
 * and persistence stay in the owning console module. */

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

export interface ScorePadProps {
  homeName: string;
  awayName: string;
  /** The big numerals: current-game points in play, games won once final. */
  homeValue: number;
  awayValue: number;
  /** Side whose name carries the serve dot (null hides it). */
  server: 0 | 1 | null;
  /** The Point buttons work. Off while final, decided, or between games. */
  canScore: boolean;
  /** The per-side Undo button (mis-tap fix). Off once final. */
  canEdit: boolean;
  /** What one press adds (the generic console scores by its step). */
  step?: number;
  onPoint: (side: 0 | 1) => void;
  onMinus: (side: 0 | 1) => void;
}

/** Two columns, one per side: name, big score, an unmissable Point button
 * and a small Undo. The button is the interaction — the score is display. */
export function ScorePad({
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
}: ScorePadProps): React.ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3">
      {([0, 1] as const).map((side) => {
        const name = side === 0 ? homeName : awayName;
        const value = side === 0 ? homeValue : awayValue;
        return (
          <div key={side} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 items-center justify-center gap-1.5">
              {server === side ? (
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full bg-primary"
                />
              ) : null}
              <span className="truncate text-sm font-medium">{name}</span>
            </div>
            <div
              data-testid={side === 0 ? "points-home" : "points-away"}
              className="rounded-lg bg-muted/50 py-2.5 text-center font-tabular text-6xl font-semibold leading-none tabular-nums sm:text-7xl"
            >
              {value}
            </div>
            <Button
              data-testid={side === 0 ? "point-home" : "point-away"}
              disabled={!canScore}
              onClick={() => onPoint(side)}
              aria-label={`${t("Point")} ${name}`}
              className="h-14 w-full select-none text-base font-semibold [touch-action:manipulation]"
            >
              <Plus aria-hidden="true" className="h-5 w-5" />
              {step === 1 ? t("Point") : `${step} ${t("points")}`}
            </Button>
            {canEdit ? (
              <button
                type="button"
                data-testid={side === 0 ? "minus-home" : "minus-away"}
                aria-label={`${t("Undo point")} ${name}`}
                disabled={value <= 0}
                onClick={() => onMinus(side)}
                className="inline-flex h-9 select-none items-center justify-center gap-1 rounded-lg border border-border text-xs font-medium text-muted-foreground transition-colors [touch-action:manipulation] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
              >
                <Minus aria-hidden="true" className="h-3.5 w-3.5" />
                {t("Undo")}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The explicit step between games: says what just happened and offers ONE
 * clear action. Point buttons stay locked until it is taken. */
export function NextGamePrompt({
  summary,
  startLabel,
  onStart,
}: {
  summary: string;
  startLabel: string;
  onStart: () => void;
}): React.ReactElement {
  return (
    <div
      data-testid="next-game"
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3"
    >
      <p className="text-center text-sm font-medium">{summary}</p>
      <Button
        data-testid="start-next"
        className="h-12 w-full text-base"
        onClick={onStart}
      >
        {startLabel}
      </Button>
    </div>
  );
}

export interface GameTrackProps {
  progress: SetProgress;
  /** Sport's own word for a period ("Game", "Set"). */
  periodLabel: string;
  /** Finished periods as score pairs, in order. */
  finished: (number | string)[][];
  /** A game just ended and the next has not started: no live chip. */
  awaitingNext?: boolean;
  /** Name of the clinching side (caption), when decided. */
  winnerName: string | null;
  isFinal: boolean;
}

/** The best-of strip: every game the rule allows, as done chips, the game
 * in play, and the games still ahead — so the scorer always sees how many
 * stages are left. The caption carries the rule ("First to 2 · best of 3")
 * or the clinched result. */
export function GameTrack({
  progress,
  periodLabel,
  finished,
  awaitingNext = false,
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
    if (!awaitingNext) {
      slots.push(
        <span
          key="current"
          className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-primary" />
          {periodLabel} {setNo}
        </span>,
      );
    }
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
      className="flex flex-col items-center gap-1"
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
