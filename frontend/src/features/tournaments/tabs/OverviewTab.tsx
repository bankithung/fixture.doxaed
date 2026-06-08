import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, CalendarClock, ChevronRight, Lock, Users } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { institutionsApi } from "@/api/institutions";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { StageStepper } from "../StageStepper";
import { Stat, statusBadge } from "./shared";

export function OverviewTab(): React.ReactElement {
  const { id = "" } = useParams();
  const tournament = useQuery({
    queryKey: ["tournament", id],
    queryFn: () => tournamentsApi.get(id),
  });
  const teams = useQuery({ queryKey: ["t-teams", id], queryFn: () => tournamentsApi.teams(id) });
  const matches = useQuery({ queryKey: ["t-matches", id], queryFn: () => tournamentsApi.matches(id) });
  const institutions = useQuery({
    queryKey: ["t-institutions", id],
    queryFn: () => institutionsApi.list(id),
  });
  const stage = useQuery({ queryKey: ["tournament-stage", id], queryFn: () => tournamentsApi.stage(id) });

  const teamCount = teams.data?.length ?? 0;
  const matchCount = matches.data?.length ?? 0;
  const instCount = institutions.data?.length ?? 0;
  const playerCount = (teams.data ?? []).reduce((n, tm) => n + (tm.player_count ?? 0), 0);
  const status = tournament.data?.status ?? "draft";
  const badge = statusBadge(status);

  const order = stage.data?.order ?? [];
  const curIdx = stage.data ? order.indexOf(stage.data.stage) : -1;
  const locked = (key: string): boolean =>
    !!stage.data && order.indexOf(key) > curIdx;
  const lockedLabel = (key: string): string =>
    stage.data?.stages[order.indexOf(key)]?.label ?? "";

  const jumps = [
    { to: routes.tournamentInstitutions(id), icon: Building2, label: t("Institutions"), value: instCount, sub: t("registered"), stageKey: "org_registration" },
    { to: routes.tournamentTeams(id), icon: Users, label: t("Teams"), value: teamCount, sub: t("entered"), stageKey: "team_registration" },
    { to: routes.tournamentFixtures(id), icon: CalendarClock, label: t("Fixtures"), value: matchCount, sub: t("generated"), stageKey: "fixtures" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <StageStepper tournamentId={id} />

      {/* KPI row */}
      <div className="grid grid-cols-2 divide-x divide-y divide-border rounded-xl border border-border bg-card shadow-sm md:grid-cols-4 md:divide-y-0">
        <Stat label={t("Institutions")} value={instCount} sub={t("registered")} />
        <Stat label={t("Teams")} value={teamCount} sub={t("entered")} />
        <Stat label={t("Players")} value={playerCount} sub={t("across teams")} />
        <Stat label={t("Status")} value={t(badge.label)} live={status.startsWith("live")} />
      </div>

      {/* Jump-to cards — locked until the tournament reaches that stage. */}
      <div className="grid gap-3 sm:grid-cols-3">
        {jumps.map((j) => {
          const isLocked = locked(j.stageKey);
          const body = (
            <>
              <span
                className={cn(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-lg",
                  isLocked ? "bg-muted" : "bg-primary/10",
                )}
              >
                {isLocked ? (
                  <Lock aria-hidden="true" className="h-5 w-5 text-muted-foreground/50" />
                ) : (
                  <j.icon aria-hidden="true" className="h-5 w-5 text-primary" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cn("text-sm font-medium", isLocked && "text-muted-foreground")}>
                  {j.label}
                </div>
                <div className="font-tabular text-xs text-muted-foreground">
                  {isLocked ? `${t("Unlocks at")} ${lockedLabel(j.stageKey)}` : `${j.value} ${j.sub}`}
                </div>
              </div>
              {!isLocked ? (
                <ChevronRight
                  aria-hidden="true"
                  className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                />
              ) : null}
            </>
          );
          return isLocked ? (
            <div
              key={j.label}
              aria-disabled="true"
              title={`${t("Unlocks at")} ${lockedLabel(j.stageKey)}`}
              className="flex cursor-not-allowed items-center gap-3 rounded-xl border border-dashed border-border bg-card p-4 opacity-70"
            >
              {body}
            </div>
          ) : (
            <Link
              key={j.label}
              to={j.to}
              className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/30"
            >
              {body}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
