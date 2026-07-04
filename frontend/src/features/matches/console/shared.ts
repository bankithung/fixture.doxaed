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
