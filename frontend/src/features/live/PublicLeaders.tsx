import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Trophy } from "lucide-react";
import { api } from "@/api/client";
import {
  SportLeaderBoards,
  type SportLeaders,
} from "@/features/live/SportLeaderBoards";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

interface LeadersPayload {
  played: number;
  sports: SportLeaders[];
  latest_badges: { id: string; name: string; subject: string }[];
}

/**
 * The public FIFA-style leader board: always present (day zero shows what
 * will appear), live off the page's SSE tick — the parent invalidates
 * ["public-leaders", id] on every tick so numbers move in real time.
 * P1.b: each sport renders ITS OWN boards (sepak by wins/set ratio,
 * football by goals) — never one pooled football-shaped table.
 */
export function PublicLeaders({
  slug,
  id,
  flat = false,
  leafKey,
}: {
  slug: string;
  id: string;
  /** Render as a band on an existing surface (no card chrome) — the public
   * schedule panel is one combined section, not a stack of cards. */
  flat?: boolean;
  /** Scope to ONE competition leaf (owner 2026-08-13): while a viewer has a
   * category open, a tournament-wide board answers a question they didn't
   * ask. Nothing played in that leaf yet renders nothing at all. */
  leafKey?: string;
}): React.ReactElement | null {
  const q = useQuery({
    queryKey: ["public-leaders", id],
    queryFn: () =>
      api.get<LeadersPayload>(
        `/api/public/tournaments/${encodeURIComponent(slug)}/${id}/leaders/`,
      ),
    staleTime: 30_000,
  });
  const raw = q.data;

  // The payload already carries per-leaf boards (services/leaders.py) — the
  // scoped view is a projection of it, so no extra request.
  const scoped = useMemo((): LeadersPayload | undefined => {
    if (!raw || !leafKey) return raw;
    for (const s of raw.sports) {
      const cat = (s.categories ?? []).find(
        // "_" is the schedule page's stand-in for a match with no leaf key.
        (c) => c.leaf_key === leafKey || (leafKey === "_" && !c.leaf_key),
      );
      if (!cat) continue;
      return {
        played: cat.played,
        // One sport, one category: SportLeaderBoards collapses its sport
        // chrome at length 1, which is exactly right here.
        sports: [{ ...s, played: cat.played, boards: cat.boards, categories: [] }],
        latest_badges: [],
      };
    }
    return { played: 0, sports: [], latest_badges: [] };
  }, [raw, leafKey]);

  const d = scoped;
  const empty = !d || d.played === 0;
  // Scoped and nothing played: show nothing rather than an empty promise on
  // top of the category the viewer actually opened.
  if (leafKey && empty) return null;
  // The payload is untrusted at runtime: a response without `latest_badges`
  // (an older backend, a cached body) used to crash the whole public page on
  // `.length`, not just hide the strip.
  const badges = d?.latest_badges ?? [];

  return (
    <section
      data-testid="public-leaders"
      aria-label={t("Leader board")}
      className={cn(
        "overflow-hidden bg-card",
        flat ? "border-b border-border" : "rounded-xl border border-border shadow-sm",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Trophy aria-hidden="true" className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">{t("Leader board")}</h2>
        {!empty ? (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 font-tabular text-xs text-muted-foreground">
            {d.played} {t("matches played")}
          </span>
        ) : null}
      </div>

      {d && d.sports.length > 0 ? (
        <SportLeaderBoards
          sports={d.sports}
          rows={3}
          teamLink={(teamId) => `/t/${slug}/${id}/team/${teamId}`}
        />
      ) : null}

      {empty ? (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {t("Fills automatically and updates live once play starts.")}
        </p>
      ) : null}

      {badges.length > 0 ? (
        <div className="border-t border-border p-3">
          <p className="flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <Award aria-hidden="true" className="h-3 w-3" />
            {t("Latest badges")}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {badges.slice(0, 4).map((b) => (
              <Link
                key={b.id}
                to={`/cert/${b.id}`}
                className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-primary/30 bg-primary/5 px-2 py-0.5 text-[0.6875rem] font-medium text-primary hover:bg-primary/10"
              >
                <Award aria-hidden="true" className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {b.name} · {b.subject}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
