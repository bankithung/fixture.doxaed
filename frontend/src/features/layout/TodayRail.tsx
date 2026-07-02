import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CircleAlert, Radio } from "lucide-react";
import { api } from "@/api/client";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

interface TodayMatch {
  match_id: string;
  tournament_id: string;
  tournament_name: string;
  home: string;
  away: string;
  status: string;
  home_score: number | null;
  away_score: number | null;
  scheduled_at: string | null;
  venue: string;
  live: boolean;
}

interface NeedsRow {
  kind: string;
  tournament_id: string;
  match_id?: string;
  label: string;
}

/**
 * The dashboard's cross-tournament Today feed (replaces the arbitrary
 * "featured match" widget): everything live or coming up across every
 * tournament the user belongs to, plus the needs-you strip.
 */
export function TodayRail(): React.ReactElement {
  const q = useQuery({
    queryKey: ["me-today"],
    queryFn: () =>
      api.get<{ matches: TodayMatch[]; needs: NeedsRow[] }>("/api/me/today/"),
    refetchInterval: 60_000,
  });
  const matches = (q.data?.matches ?? []).slice(0, 6);
  const needs = (q.data?.needs ?? []).slice(0, 5);

  return (
    <>
      <div className="rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Radio aria-hidden="true" className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">{t("Today")}</h2>
        </div>
        {q.isLoading ? (
          <div className="h-24 animate-pulse" />
        ) : matches.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground">
            {t("Nothing live or scheduled today.")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {matches.map((m) => (
              <li key={m.match_id}>
                <Link
                  to={routes.matchConsole(m.tournament_id, m.match_id)}
                  className="flex flex-col gap-0.5 px-4 py-2 transition-colors hover:bg-accent"
                >
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {m.live ? (
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                      </span>
                    ) : null}
                    <span className="truncate">{m.tournament_name}</span>
                    {m.scheduled_at && !m.live ? (
                      <span className="ml-auto font-tabular">
                        {new Date(m.scheduled_at).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {m.home} {t("vs")} {m.away}
                    </span>
                    <span
                      className={cn(
                        "font-tabular font-semibold",
                        m.live ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {m.live ? `${m.home_score ?? 0}-${m.away_score ?? 0}` : ""}
                    </span>
                    <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {needs.length > 0 ? (
        <div className="rounded-xl border border-border bg-card shadow-sm">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <CircleAlert aria-hidden="true" className="h-4 w-4 text-warning-foreground" />
            <h2 className="text-sm font-semibold">{t("Needs you")}</h2>
          </div>
          <ul className="divide-y divide-border">
            {needs.map((n, i) => (
              <li key={i}>
                <Link
                  to={
                    n.kind === "open_dispute"
                      ? routes.tournamentSettings(n.tournament_id)
                      : routes.tournamentMatches(n.tournament_id)
                  }
                  className="flex items-center gap-2 px-4 py-2 text-sm transition-colors hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 truncate">{n.label}</span>
                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
