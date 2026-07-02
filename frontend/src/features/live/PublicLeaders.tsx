import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Award, Shield, Target, Trophy } from "lucide-react";
import { api } from "@/api/client";
import { t } from "@/lib/t";

interface LeadersPayload {
  played: number;
  top_scorers: { player_id: string; name: string; team_name: string; goals: number }[];
  best_defence: { team_id: string; team_name: string; played: number; scored: number; conceded: number }[];
  best_attack: { team_id: string; team_name: string; played: number; scored: number; conceded: number }[];
  latest_badges: { id: string; name: string; subject: string }[];
}

/**
 * The public FIFA-style leader board: always present (day zero shows what
 * will appear), live off the page's SSE tick — the parent invalidates
 * ["public-leaders", id] on every tick so numbers move in real time.
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

      {empty ? (
        <div>
          <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {[
              { label: t("Top scorers"), Icon: Target },
              { label: t("Best defence"), Icon: Shield },
              { label: t("Latest badges"), Icon: Award },
            ].map(({ label, Icon }) => (
              <div key={label} className="flex flex-col gap-1.5 p-3">
                <p className="flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <Icon aria-hidden="true" className="h-3 w-3" />
                  {label}
                </p>
                {[1, 2, 3].map((rank) => (
                  <div key={rank} className="flex items-center gap-2">
                    <span className="w-4 shrink-0 font-tabular text-xs text-muted-foreground/60">
                      {rank}
                    </span>
                    <span className="h-2 flex-1 rounded-full bg-muted" />
                    <span className="h-2 w-6 rounded-full bg-muted" />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            {t("Fills automatically and updates live once play starts.")}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <div className="p-3">
            <p className="flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <Target aria-hidden="true" className="h-3 w-3" />
              {t("Top scorers")}
            </p>
            {d.top_scorers.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Ranked by points for set sports below.")}
              </p>
            ) : (
              <ol className="mt-1 flex flex-col gap-1">
                {d.top_scorers.slice(0, 3).map((s, i) => (
                  <li key={s.player_id} className="flex items-center gap-2 text-sm">
                    <span className="w-4 shrink-0 font-tabular text-xs text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="font-tabular font-semibold">{s.goals}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="p-3">
            <p className="flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <Shield aria-hidden="true" className="h-3 w-3" />
              {t("Best defence")}
            </p>
            <ol className="mt-1 flex flex-col gap-1">
              {d.best_defence.slice(0, 3).map((r) => (
                <li key={r.team_id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    <Link
                      to={`/t/${slug}/${id}/team/${r.team_id}`}
                      className="hover:text-primary hover:underline"
                    >
                      {r.team_name}
                    </Link>
                  </span>
                  <span className="font-tabular text-xs text-muted-foreground">
                    {r.conceded} {t("in")} {r.played}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          <div className="p-3">
            <p className="flex items-center gap-1.5 text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <Award aria-hidden="true" className="h-3 w-3" />
              {t("Latest badges")}
            </p>
            {d.latest_badges.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Awarded automatically for standout results.")}
              </p>
            ) : (
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
            )}
          </div>
        </div>
      )}
    </section>
  );
}
