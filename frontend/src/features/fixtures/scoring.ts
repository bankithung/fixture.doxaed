import type { SportScoringConfig } from "@/api/tournaments";
import { t } from "@/lib/t";

/** A per-game scoring rule (sets/points or timed/goals). Same shape the backend
 * resolves and the scorer console enforces (deuce + cap). */
export type Scoring = SportScoringConfig;

/** A short, scannable summary for a chip/button: "Best of 3 · 15 pts · cap 17",
 * "Timed (goals)", or the inherited-default hint when there's no override. */
export function scoringSummary(s: Scoring | null | undefined): string {
  if (!s) return t("Sport default");
  if (s.type === "goals") return t("Timed (goals)");
  const parts = [`${t("Best of")} ${s.best_of ?? 3}`, `${s.points ?? 11} ${t("pts")}`];
  if (s.win_by && s.win_by !== 2) parts.push(`${t("win by")} ${s.win_by}`);
  if (s.cap) parts.push(`${t("cap")} ${s.cap}`);
  return parts.join(" · ");
}

/** A fresh set-based scoring seeded from the inherited baseline (or generic
 * defaults), used when a game first gets its own override. */
export function blankSets(base?: Scoring | null): Scoring {
  const out: Scoring = {
    type: "sets",
    best_of: base?.type === "sets" ? (base.best_of ?? 3) : 3,
    points: base?.type === "sets" ? (base.points ?? 11) : 11,
    win_by: base?.type === "sets" ? (base.win_by ?? 2) : 2,
    cap: base?.type === "sets" ? (base.cap ?? null) : null,
  };
  if (base?.type === "sets" && base.deciding) out.deciding = { ...base.deciding };
  return out;
}

/** Normalize a draft before staging: drop a null cap, clamp positives. */
export function cleanScoring(s: Scoring): Scoring {
  if (s.type === "goals") return { type: "goals" };
  const out: Scoring = {
    type: "sets",
    best_of: Math.max(1, Math.floor(Number(s.best_of) || 3)),
    points: Math.max(1, Math.floor(Number(s.points) || 11)),
    win_by: Math.max(1, Math.floor(Number(s.win_by) || 1)),
    cap: s.cap == null || Number(s.cap) < 1 ? null : Math.floor(Number(s.cap)),
  };
  if (s.deciding) {
    const d = s.deciding;
    out.deciding = {
      points: Math.max(1, Math.floor(Number(d.points) || out.points || 11)),
      win_by: Math.max(1, Math.floor(Number(d.win_by) || 1)),
      cap: d.cap == null || Number(d.cap) < 1 ? null : Math.floor(Number(d.cap)),
    };
  }
  return out;
}

/** Structural equality so the board can tell a real override from a no-op. */
export function scoringEqual(a: Scoring | null | undefined, b: Scoring | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
