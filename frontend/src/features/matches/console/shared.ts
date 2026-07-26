// Building blocks shared by the console chassis (MatchConsolePage) and the
// per-sport console modules (registry.ts).

// Status -> badge presentation (tokens only).
export function statusMeta(s: string): { label: string; badge: string; dot: string; live: boolean } {
  const live = s === "live" || s === "half_time";
  const map: Record<string, { label: string; badge: string; dot: string }> = {
    scheduled: { label: "Scheduled", badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    live: { label: "Live", badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    half_time: { label: "Half time", badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    completed: { label: "Completed", badge: "bg-accent text-accent-foreground", dot: "bg-muted-foreground" },
  };
  const m = map[s] ?? { label: s.replace(/_/g, " "), badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" };
  return { ...m, live };
}

export type SetRow = [string, string];

/** One segment of a competition leaf key, humanized ("u_14" -> "U14",
 * "boys" -> "Boys", "1v1" stays "1v1"). */
function humanizeSegment(seg: string): string {
  const u = seg.match(/^u[ _-]?(\d+)$/i);
  if (u) return `U${u[1]}`;
  return seg
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** "table_tennis.u19.boys.1v1" -> "U19 · Boys · 1v1" (the sport prefix is
 * dropped because the header names the sport separately). */
export function competitionLabel(
  leafKey: string | null | undefined,
  sportKey: string | null | undefined,
): string {
  if (!leafKey) return "";
  let segs = leafKey.split(".").filter(Boolean);
  if (sportKey && segs[0] === sportKey) segs = segs.slice(1);
  return segs.map(humanizeSegment).join(" · ");
}

/** Tiny tap feedback on phones that support it; silently does nothing
 * elsewhere (jsdom, desktop). */
export function buzz(ms = 12): void {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(ms);
    }
  } catch {
    // vibration blocked: the tap still lands
  }
}

export type SetScoring = {
  best_of?: number;
  points?: number;
  win_by?: number;
  cap?: number | null;
  deciding?: Record<string, unknown> | null;
} | null;

/** Sets won per side from the entered rows (client display only — the server
 * revalidates on completion). Mirrors the backend's lenient live counter: a
 * set counts only once it is legally WON (target reached with the margin, or
 * the cap hit); the running set counts for nobody, so 4-1 mid-set reads
 * "Sets 0-0", not 1-0. Without known rules any decided pair counts. */
export function setsWon(rows: SetRow[], scoring: SetScoring): [number, number] {
  const needMinusOne = Math.floor((scoring?.best_of ?? 3) / 2);
  let h = 0;
  let a = 0;
  for (const [hs, as] of rows) {
    if (hs === "" || as === "") continue;
    const hn = Number(hs);
    const an = Number(as);
    if (!Number.isFinite(hn) || !Number.isFinite(an) || hn === an) continue;
    const deciding = h === a && h === needMinusOne;
    const d = (deciding ? scoring?.deciding : null) as {
      points?: number;
      win_by?: number;
      cap?: number | null;
    } | null;
    const target = d?.points ?? scoring?.points ?? 0;
    const winBy = d?.win_by ?? scoring?.win_by ?? 2;
    const cap = d?.cap ?? scoring?.cap ?? null;
    const hi = Math.max(hn, an);
    const lo = Math.min(hn, an);
    const won =
      target <= 0 ||
      (hi >= target && (hi - lo >= winBy || (cap != null && hi >= cap)));
    if (!won) continue;
    if (hn > an) h += 1;
    else a += 1;
  }
  return [h, a];
}

/** Where the match stands against its best-of rule — drives the game track,
 * the "first to N" hint and the completion gate (the server rejects a
 * recorded result until the match is decided, so the console must too). */
export interface SetProgress {
  homeSets: number;
  awaySets: number;
  bestOf: number;
  /** Sets/games a side must win to take the match. */
  need: number;
  /** 1-based number of the set in play (the last editor row). */
  setNo: number;
  /** A side has clinched: the result is recordable, extra points are not. */
  decided: boolean;
  /** 0 home, 1 away once decided. */
  leader: 0 | 1 | null;
}

export function setProgress(
  rows: SetRow[],
  scoring: SetScoring,
  fallbackBestOf = 3,
): SetProgress {
  const [homeSets, awaySets] = setsWon(rows, scoring);
  const bestOf = scoring?.best_of ?? fallbackBestOf;
  const need = Math.floor(bestOf / 2) + 1;
  const decided = homeSets >= need || awaySets >= need;
  return {
    homeSets,
    awaySets,
    bestOf,
    need,
    setNo: Math.max(rows.length, 1),
    decided,
    leader: decided ? (homeSets > awaySets ? 0 : 1) : null,
  };
}
