import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Award, School, Trophy } from "lucide-react";
import {
  publicRecordsApi,
  type PublicSchoolRecord,
} from "@/api/publicRecords";
import { LeafLabel } from "@/features/fixtures/LeafLabel";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const FORM_CLS: Record<string, string> = {
  W: "bg-primary text-primary-foreground",
  D: "bg-muted text-muted-foreground",
  L: "bg-destructive/15 text-destructive",
};

function Stat({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-2">
      <span className="font-tabular text-xl font-semibold">{value}</span>
      <span className="text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function TeamCard({
  team,
  slug,
  id,
}: {
  team: PublicSchoolRecord["teams"][number];
  slug: string;
  id: string;
}): React.ReactElement {
  return (
    <Link
      to={routes.publicTeam(slug, id, team.team_id)}
      data-testid={`school-team-${team.team_id}`}
      className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-sm transition-colors hover:border-primary/40"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{team.team_name}</p>
        <LeafLabel label={team.leaf_key} className="mt-0.5" />
      </div>
      <div className="flex items-center gap-1" aria-label={t("Recent form")}>
        {team.form.map((r, i) => (
          <span
            key={i}
            className={cn(
              "grid h-5 w-5 place-items-center rounded-md text-[0.6875rem] font-semibold",
              FORM_CLS[r] ?? "bg-muted",
            )}
          >
            {r}
          </span>
        ))}
      </div>
      <span className="font-tabular text-sm text-muted-foreground">
        {team.wins}-{team.draws}-{team.losses}
      </span>
    </Link>
  );
}

/**
 * Public school profile (P6, the owner's "schools can see their data any
 * time"): this tournament's rollup + every team + the cross-year history.
 * The page a headmaster forwards to the school WhatsApp group.
 */
export function PublicSchoolPage(): React.ReactElement {
  const { slug = "", id = "", instId = "" } = useParams();
  const q = useQuery({
    queryKey: ["public-school", instId],
    queryFn: () => publicRecordsApi.school(slug, id, instId),
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
          {t("Could not load this school.")}
        </p>
        <Link
          to={routes.publicSchedule(slug, id)}
          className="text-sm text-primary hover:underline"
        >
          {t("Back to the schedule")}
        </Link>
      </div>
    );
  }
  const school = q.data;
  const totals = school.totals;

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

        <header className="flex items-center gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/10">
            <School aria-hidden="true" className="h-6 w-6 text-primary" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">
              {school.institution_name}
            </h1>
            <p className="text-xs text-muted-foreground">
              {school.teams.length}{" "}
              {school.teams.length === 1 ? t("team") : t("teams")}{" "}
              {t("in this tournament")}
            </p>
          </div>
        </header>

        {/* Tournament totals */}
        <section
          data-testid="school-totals"
          className="grid grid-cols-4 divide-x divide-border rounded-xl border border-border bg-card shadow-sm sm:grid-cols-7"
        >
          <Stat label={t("Played")} value={totals.played} />
          <Stat label={t("Won")} value={totals.wins} />
          <Stat label={t("Drawn")} value={totals.draws} />
          <Stat label={t("Lost")} value={totals.losses} />
          <div className="hidden sm:contents">
            <Stat label={t("Scored")} value={totals.scored} />
            <Stat label={t("Against")} value={totals.conceded} />
            <Stat label={t("Diff")} value={totals.difference} />
          </div>
        </section>

        {/* Teams */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t("Teams")}</h2>
          {school.teams.length === 0 ? (
            <p className="rounded-xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
              {t("No teams registered yet.")}
            </p>
          ) : (
            school.teams.map((team) => (
              <TeamCard key={team.team_id} team={team} slug={slug} id={id} />
            ))
          )}
        </section>

        {/* Badges */}
        {school.badges.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Award aria-hidden="true" className="h-4 w-4 text-primary" />
              {t("Achievements")}
            </h2>
            <ul className="flex flex-wrap gap-1.5">
              {school.badges.map((b) => (
                <li
                  key={b.id}
                  className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
                >
                  {b.name}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Cross-year history */}
        {school.history.length > 0 ? (
          <section className="flex flex-col gap-2" data-testid="school-history">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Trophy aria-hidden="true" className="h-4 w-4 text-primary" />
              {t("History")}
            </h2>
            {school.history.map((season) => (
              <div
                key={season.season}
                className="rounded-xl border border-border bg-card shadow-sm"
              >
                <p className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {season.season === "undated" ? t("Season unknown") : season.season}
                </p>
                <ul className="divide-y divide-border">
                  {season.tournaments.map((row) => (
                    <li key={row.tournament_id}>
                      <Link
                        to={routes.publicSchedule(
                          row.tournament_slug,
                          row.tournament_id,
                        )}
                        className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-accent"
                      >
                        <span className="min-w-0 truncate text-sm font-medium">
                          {row.tournament_name}
                        </span>
                        <span className="font-tabular shrink-0 text-xs text-muted-foreground">
                          {row.totals.played} {t("played")}, {row.totals.wins}{" "}
                          {t("won")}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}
