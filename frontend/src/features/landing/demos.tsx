import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import "./landing.css";

/**
 * Landing-page demos. Everything here is SAMPLE DATA and clearly labeled as
 * such — no live queries, no real tournaments. The scorer demo auto-plays a
 * short scripted match and lets visitors tap +1 themselves; under reduced
 * motion (and in jsdom) it renders the final score statically.
 */

function motionOff(): boolean {
  return (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type DemoEvent = { minute: number; team: string };

const SCRIPT: readonly ("home" | "away")[] = ["home", "away", "home"];
const TICK_MS = 1900;
const START_MINUTE = 41;
const MINUTES_PER_TICK = 9;

const HOME = "Kohima United";
const AWAY = "Dimapur FC";

/** The score the demo settles on in static environments (reduced motion). */
const STATIC_EVENTS: readonly DemoEvent[] = [
  { minute: 12, team: HOME },
  { minute: 58, team: AWAY },
  { minute: 76, team: HOME },
];

/** Interactive scorer-console sample: auto-plays goals, visitors can tap. */
export function ScorerDemo(): React.ReactElement {
  // Static environments start at the script's final score so the demo still
  // reads like a real match.
  const animate = !motionOff();
  const [scores, setScores] = useState(() =>
    animate ? { home: 0, away: 0 } : { home: 2, away: 1 },
  );
  const [minute, setMinute] = useState(() => (animate ? START_MINUTE : 90));
  const [events, setEvents] = useState<DemoEvent[]>(() =>
    animate ? [] : [...STATIC_EVENTS],
  );
  const [flash, setFlash] = useState<"home" | "away" | null>(null);
  const stepRef = useRef(0);
  const minuteRef = useRef(animate ? START_MINUTE : 90);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const score = useCallback((side: "home" | "away"): void => {
    setScores((s) => ({ ...s, [side]: Math.min(s[side] + 1, 9) }));
    setEvents((list) =>
      [...list, { minute: minuteRef.current, team: side === "home" ? HOME : AWAY }].slice(-6),
    );
    setFlash(side);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 600);
  }, []);

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => {
      const step = stepRef.current;
      minuteRef.current = Math.min(90, minuteRef.current + MINUTES_PER_TICK);
      setMinute(minuteRef.current);
      if (step < SCRIPT.length) {
        score(SCRIPT[step] ?? "home");
        stepRef.current = step + 1;
      } else if (step >= SCRIPT.length + 2) {
        // Two quiet ticks after full time, then the demo restarts.
        setScores({ home: 0, away: 0 });
        setEvents([]);
        minuteRef.current = START_MINUTE;
        setMinute(START_MINUTE);
        stepRef.current = 0;
      } else {
        stepRef.current = step + 1;
      }
    }, TICK_MS);
    return () => {
      clearInterval(id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, [animate, score]);

  const recent = [...events].reverse().slice(0, 3);

  return (
    <div className="panel glass flex h-full flex-col p-5" data-testid="scorer-demo">
      <div className="flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-2 font-medium text-destructive">
          <span className="live-dot" />
          {t("LIVE")}
        </span>
        <span className="text-muted-foreground">{t("Match console · sample")}</span>
      </div>

      {/* Scoreboard: crests either side, big tabular score + clock center */}
      <div className="mt-5 grid grid-cols-[1fr,auto,1fr] items-start gap-2">
        <TeamSide
          name={HOME}
          initials="KU"
          onScore={() => score("home")}
        />
        <div className="flex flex-col items-center gap-1.5 pt-1">
          <div className="font-tabular flex items-baseline text-4xl font-semibold tracking-tight">
            <span className={cn(flash === "home" && "demo-score-flash text-primary")}>
              {scores.home}
            </span>
            <span className="mx-2 text-xl text-muted-foreground/50">:</span>
            <span className={cn(flash === "away" && "demo-score-flash text-primary")}>
              {scores.away}
            </span>
          </div>
          <span className="font-tabular rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
            {minute}&#8242;
          </span>
        </div>
        <TeamSide
          name={AWAY}
          initials="DF"
          onScore={() => score("away")}
        />
      </div>

      {/* Event feed: the last few goals, newest first */}
      <ul className="mt-5 min-h-[4.5rem] space-y-1.5 border-t border-border/60 pt-3 text-xs">
        {recent.length === 0 ? (
          <li className="text-muted-foreground">
            {t("Kickoff. Waiting on the first goal.")}
          </li>
        ) : (
          recent.map((e, i) => (
            <li key={`${e.minute}-${e.team}-${i}`} className="flex items-center gap-2">
              <span className="font-tabular w-7 shrink-0 text-muted-foreground">
                {e.minute}&#8242;
              </span>
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span className="text-muted-foreground">{t("Goal")}</span>
              <span className="truncate font-medium text-foreground">{e.team}</span>
            </li>
          ))
        )}
      </ul>

      <p className="mt-auto border-t border-border/60 pt-3 text-xs text-muted-foreground">
        {t("Tap +1 to score. This is how matchday feels for a scorer.")}
      </p>
    </div>
  );
}

function TeamSide({
  name,
  initials,
  onScore,
}: {
  name: string;
  initials: string;
  onScore: () => void;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 text-center">
      <span
        aria-hidden="true"
        className="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-secondary text-xs font-semibold text-foreground"
      >
        {initials}
      </span>
      <span className="w-full truncate text-sm font-medium">{name}</span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1"
        onClick={onScore}
        aria-label={t("Add a goal for") + " " + name}
      >
        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Goal")}
      </Button>
    </div>
  );
}

/** Knockout bracket sample: semifinals into a final into a champion, with
 * real connector lines between rounds (hidden on mobile, where the rounds
 * stack vertically). */
export function BracketDemo(): React.ReactElement {
  return (
    <div className="panel glass flex h-full flex-col p-5" data-testid="bracket-demo">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium uppercase tracking-[0.12em]">
          {t("Knockout · sample")}
        </span>
        <span>{t("Boys U17")}</span>
      </div>

      <div className="mt-4 flex flex-1 flex-col justify-center gap-4 sm:flex-row sm:items-stretch sm:gap-0">
        {/* Semifinals */}
        <div className="flex flex-col justify-center gap-3 sm:w-[38%]">
          <RoundLabel>{t("Semifinals")}</RoundLabel>
          <div className="grid flex-1 grid-rows-2 items-center gap-3">
            <BracketMatch a={HOME} as="2" b={t("Wokha FC")} bs="1" winner="a" />
            <BracketMatch a={AWAY} as="0" b={t("Mokokchung Town")} bs="3" winner="b" />
          </div>
        </div>

        {/* Elbow connector: both semis join, one line feeds the final */}
        <BracketElbow />

        {/* Final */}
        <div className="flex flex-col justify-center gap-3 sm:w-[30%]">
          <RoundLabel>{t("Final")}</RoundLabel>
          <div className="flex flex-1 items-center">
            <BracketMatch
              a={HOME}
              as="3"
              b={t("Mokokchung Town")}
              bs="2"
              winner="a"
              className="w-full"
            />
          </div>
        </div>

        {/* Straight connector into the champion */}
        <div aria-hidden="true" className="relative hidden w-6 shrink-0 sm:block">
          <div className="absolute inset-x-0 top-1/2 border-t border-primary/40" />
        </div>

        {/* Champion */}
        <div className="flex flex-col justify-center gap-3 sm:flex-1">
          <RoundLabel>{t("Champion")}</RoundLabel>
          <div className="flex flex-1 items-center">
            <div className="flex w-full items-center gap-2.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-3 shadow-[0_0_28px_hsl(var(--primary)/0.22)]">
              <Trophy aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate text-sm font-semibold">{HOME}</span>
            </div>
          </div>
        </div>
      </div>

      <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        {t("Winners advance automatically the moment a result lands.")}
      </p>
    </div>
  );
}

function RoundLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
      {children}
    </p>
  );
}

/** The classic bracket elbow: arms out of each semifinal at 25% and 75%
 * height, a vertical join, and a stub into the final at 50%. Pure borders,
 * desktop only. The rows it connects sit in an equal-height 2-row grid, so
 * their centers land on the same 25%/75% lines. */
function BracketElbow(): React.ReactElement {
  return (
    <div aria-hidden="true" className="relative hidden w-6 shrink-0 sm:block">
      {/* Offset by the round label above the matches */}
      <div className="absolute inset-x-0 bottom-0 top-7">
        <div className="absolute left-0 right-1/2 top-1/4 border-t border-border" />
        <div className="absolute bottom-1/4 left-0 right-1/2 border-t border-border" />
        <div className="absolute bottom-1/4 left-1/2 top-1/4 border-l border-border" />
        <div className="absolute left-1/2 right-0 top-1/2 border-t border-border" />
      </div>
    </div>
  );
}

function BracketMatch({
  a,
  as: aScore,
  b,
  bs,
  winner,
  className,
}: {
  a: string;
  as: string;
  b: string;
  bs: string;
  winner: "a" | "b";
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card/60 text-xs",
        className,
      )}
    >
      <BracketTeam name={a} score={aScore} won={winner === "a"} />
      <div className="border-t border-border/60" />
      <BracketTeam name={b} score={bs} won={winner === "b"} />
    </div>
  );
}

function BracketTeam({
  name,
  score,
  won,
}: {
  name: string;
  score: string;
  won: boolean;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 border-l-2 px-3 py-1.5",
        won
          ? "border-l-primary bg-primary/[0.07] font-semibold text-foreground"
          : "border-l-transparent text-muted-foreground",
      )}
    >
      <span className="truncate">{name}</span>
      <span className={cn("font-tabular", won && "text-primary")}>{score}</span>
    </div>
  );
}

/** One FAQ entry: native details/summary, styled, fully keyboard accessible. */
export function FaqItem({
  q,
  children,
}: {
  q: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <details className="faq-item group border-b border-border/50">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-4 text-base font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {q}
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <p className="pb-5 text-sm leading-relaxed text-muted-foreground">
        {children}
      </p>
    </details>
  );
}
