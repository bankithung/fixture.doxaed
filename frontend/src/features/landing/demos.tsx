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

const SCRIPT: readonly ("home" | "away")[] = ["home", "away", "home"];
const TICK_MS = 1900;

/** Interactive scorer-console sample: auto-plays goals, visitors can tap. */
export function ScorerDemo(): React.ReactElement {
  // Static environments start at the script's final score so the demo still
  // reads like a real match.
  const animate = !motionOff();
  const [scores, setScores] = useState(() =>
    animate ? { home: 0, away: 0 } : { home: 2, away: 1 },
  );
  const [flash, setFlash] = useState<"home" | "away" | null>(null);
  const stepRef = useRef(0);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const score = useCallback((side: "home" | "away"): void => {
    setScores((s) => ({ ...s, [side]: Math.min(s[side] + 1, 9) }));
    setFlash(side);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 600);
  }, []);

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => {
      const step = stepRef.current;
      if (step < SCRIPT.length) {
        score(SCRIPT[step] ?? "home");
        stepRef.current = step + 1;
      } else if (step >= SCRIPT.length + 2) {
        // Two quiet ticks after full time, then the demo restarts.
        setScores({ home: 0, away: 0 });
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

  return (
    <div className="panel glass flex h-full flex-col p-5" data-testid="scorer-demo">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2 font-medium text-destructive">
          <span className="live-dot" />
          {t("LIVE")}
        </span>
        <span>{t("Match console · sample")}</span>
      </div>
      <div className="mt-4 flex flex-1 flex-col justify-center gap-3">
        <ScorerRow
          team={t("Kohima United")}
          value={scores.home}
          flashing={flash === "home"}
          onScore={() => score("home")}
        />
        <ScorerRow
          team={t("Dimapur FC")}
          value={scores.away}
          flashing={flash === "away"}
          onScore={() => score("away")}
        />
      </div>
      <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        {t("Tap +1 to score. This is how matchday feels for a scorer.")}
      </p>
    </div>
  );
}

function ScorerRow({
  team,
  value,
  flashing,
  onScore,
}: {
  team: string;
  value: number;
  flashing: boolean;
  onScore: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-3">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{team}</span>
      <span
        className={cn(
          "font-tabular w-9 text-center text-3xl font-semibold tracking-tight transition-colors",
          flashing ? "demo-score-flash text-primary" : "text-foreground",
        )}
      >
        {value}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="gap-1"
        onClick={onScore}
        aria-label={t("Add a goal for") + " " + team}
      >
        <Plus aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Goal")}
      </Button>
    </div>
  );
}

/** Knockout bracket sample: semifinals into a final into a champion. */
export function BracketDemo(): React.ReactElement {
  return (
    <div className="panel glass flex h-full flex-col p-5" data-testid="bracket-demo">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium uppercase tracking-[0.12em]">
          {t("Knockout · sample")}
        </span>
        <span>{t("Boys U17")}</span>
      </div>
      <div className="mt-4 grid flex-1 items-center gap-4 sm:grid-cols-3">
        <div className="space-y-3">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            {t("Semifinals")}
          </p>
          <BracketMatch a={t("Kohima United")} as="2" b={t("Wokha FC")} bs="1" winner="a" />
          <BracketMatch a={t("Dimapur FC")} as="0" b={t("Mokokchung Town")} bs="3" winner="b" />
        </div>
        <div className="space-y-3">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            {t("Final")}
          </p>
          <BracketMatch
            a={t("Kohima United")}
            as="3"
            b={t("Mokokchung Town")}
            bs="2"
            winner="a"
          />
        </div>
        <div className="space-y-3">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            {t("Champion")}
          </p>
          <div className="flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-3">
            <Trophy aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate text-sm font-semibold">
              {t("Kohima United")}
            </span>
          </div>
        </div>
      </div>
      <p className="mt-4 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        {t("Winners advance automatically the moment a result lands.")}
      </p>
    </div>
  );
}

function BracketMatch({
  a,
  as: aScore,
  b,
  bs,
  winner,
}: {
  a: string;
  as: string;
  b: string;
  bs: string;
  winner: "a" | "b";
}): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/60 text-xs">
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
        "flex items-center justify-between gap-2 px-3 py-1.5",
        won ? "font-semibold text-foreground" : "text-muted-foreground",
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
