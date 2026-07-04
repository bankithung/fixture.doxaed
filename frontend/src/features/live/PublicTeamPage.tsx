import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Award, Shield, Users } from "lucide-react";
import { publicRecordsApi } from "@/api/publicRecords";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const FORM_CLS: Record<string, string> = {
  W: "bg-primary text-primary-foreground",
  D: "bg-muted text-muted-foreground",
  L: "bg-destructive/15 text-destructive",
};

function Stat({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-2">
      <span className="font-tabular text-xl font-semibold">{value}</span>
      <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/**
 * Public team profile — the page a school bookmarks: record, form, every
 * fixture and result, roster, badges. FotMob-grade consumer surface, no login.
 */
export function PublicTeamPage(): React.ReactElement {
  const { slug = "", id = "", teamId = "" } = useParams();
  const q = useQuery({
    queryKey: ["public-team", teamId],
    queryFn: () => publicRecordsApi.team(slug, id, teamId),
    staleTime: 30_000,
  });

  if (q.isLoading) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <div className="h-32 animate-pulse rounded-xl border border-border bg-card" />
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6">
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load this team.")}
        </p>
        <Link to={routes.publicSchedule(slug, id)} className="text-sm text-primary hover:underline">
          {t("Back to the schedule")}
        </Link>
      </div>
    );
  }
  const team = q.data;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <Link
          to={routes.publicSchedule(slug, id)}
          className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t("Back to the schedule")}
        </Link>

        {/* Identity + record strip */}
        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center gap-3 px-5 py-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/10">
              <Shield aria-hidden="true" className="h-6 w-6 text-primary" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {team.team_name}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {team.institution ? (
                  <Link
                    to={routes.publicSchool(slug, id, team.institution.id)}
                    className="hover:text-primary hover:underline"
                  >
                    {team.institution.name}
                  </Link>
                ) : null}
                <LeafLabel label={team.leaf_key} />
              </div>
            </div>
            {team.form.length > 0 ? (
              <div className="ml-auto flex items-center gap-1" aria-label={t("Recent form")}>
                {team.form.map((r, i) => (
                  <span
                    key={i}
                    className={cn(
                      "grid h-6 w-6 place-items-center rounded-md text-xs font-semibold",
                      FORM_CLS[r],
                    )}
                  >
                    {r}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-4 divide-x divide-border border-t border-border sm:grid-cols-7">
            <Stat label={t("Played")} value={team.played} />
            <Stat label={t("Won")} value={team.wins} />
            <Stat label={t("Drawn")} value={team.draws} />
            <Stat label={t("Lost")} value={team.losses} />
            <div className="hidden sm:contents">
              <Stat label={t("For")} value={team.scored} />
              <Stat label={t("Against")} value={team.conceded} />
              <Stat label={t("Diff")} value={team.difference} />
            </div>
          </div>
        </section>

        {/* Badges */}
        {team.badges.length > 0 ? (
          <section className="rounded-xl border border-border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
              <Award aria-hidden="true" className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">{t("Honours")}</h2>
            </div>
            <ul className="flex flex-wrap gap-2 p-4">
              {team.badges.map((b) => (
                <li key={b.id} className="flex items-center gap-1">
                  <Link
                    to={`/cert/${b.id}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/10"
                    title={t("Open the certificate")}
                  >
                    <Award aria-hidden="true" className="h-3.5 w-3.5" />
                    {b.name}
                  </Link>
                  <a
                    href={`/api/public/badges/${b.id}/card.png`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full border border-border px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground hover:bg-accent"
                    title={t("Share card image")}
                  >
                    {t("Card")}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Fixtures & results */}
        <section className="rounded-xl border border-border bg-card shadow-sm">
          <div className="border-b border-border px-5 py-2.5">
            <h2 className="text-sm font-semibold">{t("Fixtures and results")}</h2>
          </div>
          {team.matches.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">
              {t("No matches scheduled yet.")}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {team.matches.map((m) => (
                <li key={m.match_id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                  <span
                    className={cn(
                      "grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs font-semibold",
                      m.status === "completed" || m.status === "walkover"
                        ? FORM_CLS[m.result]
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {m.status === "completed" || m.status === "walkover" ? m.result : "·"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {m.home ? t("vs") : t("at")} {m.opponent}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {m.scheduled_at
                        ? new Date(m.scheduled_at).toLocaleString([], {
                            day: "2-digit", month: "short",
                            hour: "2-digit", minute: "2-digit",
                          })
                        : t("Unscheduled")}
                      {m.venue ? ` · ${m.venue}` : ""}
                    </p>
                  </div>
                  <span className="font-tabular text-sm font-semibold">
                    {m.score ?? ""}
                  </span>
                  {m.set_scores.length > 0 ? (
                    <span className="hidden font-tabular text-xs text-muted-foreground sm:inline">
                      {m.set_scores.map(([h, a]) => `${h}-${a}`).join(" · ")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Roster */}
        {team.roster.length > 0 ? (
          <section className="rounded-xl border border-border bg-card shadow-sm">
            <div className="flex items-center gap-2 border-b border-border px-5 py-2.5">
              <Users aria-hidden="true" className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">{t("Squad")}</h2>
            </div>
            <ul className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-y-0">
              {team.roster.map((p) => (
                <li key={p.player_id} className="flex items-center gap-2 px-5 py-2 text-sm">
                  <span className="w-8 shrink-0 font-tabular text-xs text-muted-foreground">
                    {p.jersey_no ? `#${p.jersey_no}` : ""}
                  </span>
                  <span className="truncate">{p.name}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
