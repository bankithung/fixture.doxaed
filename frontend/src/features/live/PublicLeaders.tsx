import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Trophy } from "lucide-react";
import { api } from "@/api/client";
import {
  SportLeaderBoards,
  type SportLeaders,
} from "@/features/live/SportLeaderBoards";
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
}: {
  slug: string;
  id: string;
}): React.ReactElement {
  const q = useQuery({
    queryKey: ["public-leaders", id],
    queryFn: () =>
      api.get<LeadersPayload>(
        `/api/public/tournaments/${encodeURIComponent(slug)}/${id}/leaders/`,
      ),
    staleTime: 30_000,
  });
  const d = q.data;
  const empty = !d || d.played === 0;

  return (
    <section
      data-testid="public-leaders"
      aria-label={t("Leader board")}
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
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

      {d && d.latest_badges.length > 0 ? (
        <div className="border-t border-border p-3">
          <p className="flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <Award aria-hidden="true" className="h-3 w-3" />
            {t("Latest badges")}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {d.latest_badges.slice(0, 4).map((b) => (
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
