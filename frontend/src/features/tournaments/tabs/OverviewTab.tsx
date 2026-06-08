import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CalendarClock,
  ChevronRight,
  Lock,
  UserRound,
  Users,
} from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { institutionsApi } from "@/api/institutions";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { StageStepper } from "../StageStepper";

/** Soft, dark-mode-aware tint per metric (icon tile color). */
const TINT: Record<string, string> = {
  blue: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  violet: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-500",
  emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
};

interface MetricDef {
  key: string;
  icon: typeof Building2;
  label: string;
  value: number;
  sub: string;
  color: keyof typeof TINT | string;
  to: string | null;
  stageKey: string | null;
}

/**
 * Tournament Overview: the setup hero/timeline (StageStepper) plus a single row
 * of colorful, clickable metric cards — one surface that doubles as at-a-glance
 * numbers AND navigation into each section (locked until its stage is reached).
 */
export function OverviewTab(): React.ReactElement {
  const { id = "" } = useParams();
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

  const order = stage.data?.order ?? [];
  const curIdx = stage.data ? order.indexOf(stage.data.stage) : -1;
  const locked = (key: string | null): boolean =>
    !!stage.data && key !== null && order.indexOf(key) > curIdx;
  const lockedLabel = (key: string | null): string =>
    key !== null ? (stage.data?.stages[order.indexOf(key)]?.label ?? "") : "";

  const metrics: MetricDef[] = [
    { key: "inst", icon: Building2, label: t("Institutions"), value: instCount, sub: t("registered"), color: "blue", to: routes.tournamentInstitutions(id), stageKey: "org_registration" },
    { key: "teams", icon: Users, label: t("Teams"), value: teamCount, sub: t("entered"), color: "violet", to: routes.tournamentTeams(id), stageKey: "team_registration" },
    { key: "players", icon: UserRound, label: t("Players"), value: playerCount, sub: t("across teams"), color: "amber", to: null, stageKey: null },
    { key: "fixtures", icon: CalendarClock, label: t("Fixtures"), value: matchCount, sub: t("generated"), color: "emerald", to: routes.tournamentFixtures(id), stageKey: "fixtures" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <StageStepper tournamentId={id} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {metrics.map((m) => (
          <MetricCard
            key={m.key}
            metric={m}
            locked={locked(m.stageKey)}
            lockedLabel={lockedLabel(m.stageKey)}
          />
        ))}
      </div>
    </div>
  );
}

function MetricCard({
  metric,
  locked,
  lockedLabel,
}: {
  metric: MetricDef;
  locked: boolean;
  lockedLabel: string;
}): React.ReactElement {
  const tile = TINT[metric.color] ?? TINT.blue;

  if (locked) {
    return (
      <div
        aria-disabled="true"
        title={`${t("Unlocks at")} ${lockedLabel}`}
        className="flex cursor-not-allowed items-center gap-3 rounded-xl border border-dashed border-border bg-card p-3 opacity-75"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-muted">
          <Lock aria-hidden="true" className="h-4 w-4 text-muted-foreground/50" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-muted-foreground">{metric.label}</div>
          <div className="truncate text-xs text-muted-foreground">
            {t("Unlocks at")} {lockedLabel}
          </div>
        </div>
      </div>
    );
  }

  const inner = (
    <>
      <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", tile)}>
        <metric.icon aria-hidden="true" className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span className="font-tabular text-lg font-semibold leading-none tracking-tight">
            {metric.value}
          </span>
          <span className="truncate text-sm font-medium">{metric.label}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{metric.sub}</div>
      </div>
      {metric.to ? (
        <ChevronRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground/40 transition-all group-hover:translate-x-0.5 group-hover:text-foreground"
        />
      ) : null}
    </>
  );

  if (!metric.to) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm">
        {inner}
      </div>
    );
  }

  return (
    <Link
      to={metric.to}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm transition-colors hover:border-primary/30 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {inner}
    </Link>
  );
}
