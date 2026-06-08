import { NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Trophy } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

const STATUS_CLS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  published: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  registration_open: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  scheduled: "bg-primary/15 text-primary",
  live: "bg-red-500/15 text-red-600 dark:text-red-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  archived: "bg-muted text-muted-foreground",
};

const TABS = (id: string) => [
  { to: routes.tournamentDetail(id), label: "Overview", end: true },
  { to: routes.tournamentInstitutions(id), label: "Institutions" },
  { to: routes.tournamentTeams(id), label: "Teams" },
  { to: routes.tournamentMembers(id), label: "Members" },
  { to: routes.tournamentFixtures(id), label: "Fixtures" },
  { to: routes.tournamentSettings(id), label: "Settings" },
];

export function TournamentWorkspace(): React.ReactElement {
  const { id = "" } = useParams();
  const tournament = useQuery({
    queryKey: ["tournament", id],
    queryFn: () => tournamentsApi.get(id),
  });
  const stageQ = useQuery({
    queryKey: ["tournament-stage", id],
    queryFn: () => tournamentsApi.stage(id),
  });

  const name = tournament.data?.name ?? t("Tournament");
  const status = tournament.data?.status ?? "draft";
  const stage = stageQ.data;
  const curIdx = stage ? stage.order.indexOf(stage.stage) : -1;
  const nextLabel =
    stage && curIdx >= 0 && curIdx < stage.order.length - 1
      ? stage.stages[curIdx + 1]?.label
      : null;

  return (
    <div className="flex w-full flex-col px-4 py-6 sm:px-6 lg:px-8">
      <NavLink
        to={routes.tournaments()}
        className="mb-4 inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("All tournaments")}
      </NavLink>

      {/* Identity + slim stage progress */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10">
            <Trophy aria-hidden="true" className="h-5 w-5 text-primary" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
            <span
              className={cn(
                "mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                STATUS_CLS[status] ?? "bg-muted text-muted-foreground",
              )}
            >
              {t(status.replace(/_/g, " "))}
            </span>
          </div>
        </div>

        {stage ? (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1" aria-label={t("Setup progress")}>
              {stage.order.map((s, i) => (
                <span
                  key={s}
                  title={stage.stages[i]?.label}
                  className={cn(
                    "h-2 w-2 rounded-full",
                    i < curIdx
                      ? "bg-primary"
                      : i === curIdx
                        ? "bg-primary ring-2 ring-primary/30"
                        : "bg-muted",
                  )}
                />
              ))}
            </div>
            <span className="font-tabular text-xs text-muted-foreground">
              {curIdx + 1}/{stage.order.length}
              {nextLabel ? ` · ${t("Next")}: ${nextLabel}` : ` · ${t("Ready")}`}
            </span>
          </div>
        ) : null}
      </div>

      {/* Tabs */}
      <nav className="mt-5 flex gap-1 overflow-x-auto border-b border-border">
        {TABS(id).map((tab) => (
          <NavLink
            key={tab.label}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
              )
            }
          >
            {t(tab.label)}
          </NavLink>
        ))}
      </nav>

      <div className="pt-6">
        <Outlet />
      </div>
    </div>
  );
}
