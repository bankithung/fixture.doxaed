import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronRight, Lock, Trophy } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { StageContinue } from "./StageContinue";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/** Each setup stage → its work page, for the clickable top stepper. */
const STAGE_ROUTE: Record<string, (id: string) => string> = {
  setup: routes.tournamentSports,
  org_registration: routes.tournamentInstitutions,
  team_registration: routes.tournamentTeams,
  members: routes.tournamentMembers,
  fixtures: routes.tournamentFixtures,
};

const STATUS_CLS: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  published: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  registration_open: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  scheduled: "bg-primary/15 text-primary",
  live: "bg-red-500/15 text-red-600 dark:text-red-400",
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  archived: "bg-muted text-muted-foreground",
};

// `stageKey` = the stage a tab belongs to (null = always available). A tab
// unlocks once the tournament reaches its stage — progressive disclosure so we
// don't surface team/fixture work during institution registration.
const TAB_DEFS = (id: string) => [
  { to: routes.tournamentOverview(id), label: "Overview", end: true, stageKey: null },
  // Sports — the first setup step; always available.
  { to: routes.tournamentSports(id), label: "Sports", stageKey: null },
  // Forms is the registration-builder; it unlocks with the first registration
  // stage (keep in sync with computeTournamentNav).
  { to: routes.tournamentForms(id), label: "Forms", stageKey: "org_registration" },
  { to: routes.tournamentInstitutions(id), label: "Institutions", stageKey: "org_registration" },
  { to: routes.tournamentTeams(id), label: "Teams", stageKey: "team_registration" },
  // Members (invite people / assign roles) is always available — like Overview &
  // Settings — not a stage-gated work section. Keep in sync with computeNavItems.
  { to: routes.tournamentMembers(id), label: "Members", stageKey: null },
  { to: routes.tournamentFixtures(id), label: "Fixtures", stageKey: "fixtures" },
  { to: routes.tournamentSettings(id), label: "Settings", stageKey: null },
];

export function TournamentWorkspace(): React.ReactElement {
  const { id = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
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

  // A tab is locked until the tournament reaches its stage. Until the stage
  // payload loads, nothing is locked (avoids a flash of all-locked tabs).
  const stageRank = (key: string | null): number =>
    key === null || !stage ? -1 : stage.order.indexOf(key);
  const isLocked = (key: string | null): boolean =>
    !!stage && key !== null && stageRank(key) > curIdx;
  const lockLabel = (key: string | null): string | null => {
    const r = stageRank(key);
    return r >= 0 && stage ? (stage.stages[r]?.label ?? null) : null;
  };

  const tabs = TAB_DEFS(id);
  // Guard deep-links to a not-yet-reached tab.
  const activeTab = tabs
    .filter((tb) => location.pathname === tb.to || (!tb.end && location.pathname.startsWith(tb.to)))
    .sort((a, b) => b.to.length - a.to.length)[0];
  const activeLocked = activeTab ? isLocked(activeTab.stageKey) : false;
  // The flow's "Continue" rides under stage WORK pages — Overview has the full
  // stepper, and Settings/Forms aren't stages.
  const flowPage =
    !!activeTab && !["Overview", "Settings", "Forms"].includes(activeTab.label);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col px-4 py-6 sm:px-6 lg:px-8">
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
            <h1 className="truncate text-xl font-semibold tracking-tight">{name}</h1>
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
          <nav
            aria-label={t("Setup progress")}
            className="flex flex-wrap items-center gap-x-1 gap-y-2"
          >
            {stage.order.map((s, i) => {
              const info = stage.stages[i];
              const reached = i <= curIdx;
              const isCurrent = i === curIdx;
              const dest = STAGE_ROUTE[s]?.(id);
              const clickable = reached && !isCurrent && !!dest;
              const chip = (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-2.5 text-xs font-medium transition-colors",
                    isCurrent
                      ? "bg-primary text-primary-foreground"
                      : reached
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground",
                    clickable && "hover:bg-primary/20",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-4 w-4 shrink-0 place-items-center rounded-full text-[0.625rem] font-semibold",
                      isCurrent
                        ? "bg-primary-foreground/20"
                        : reached
                          ? "bg-primary/20"
                          : "bg-muted-foreground/15",
                    )}
                  >
                    {i < curIdx ? (
                      <Check aria-hidden="true" className="h-3 w-3" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  {info?.label}
                </span>
              );
              return (
                <span key={s} className="flex items-center">
                  {clickable ? (
                    <button
                      type="button"
                      onClick={() => navigate(dest)}
                      title={t(`Go to ${info?.label ?? ""}`)}
                      className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {chip}
                    </button>
                  ) : (
                    chip
                  )}
                  {i < stage.order.length - 1 ? (
                    <ChevronRight
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40"
                    />
                  ) : null}
                </span>
              );
            })}
          </nav>
        ) : null}
      </div>

      {/* Navigation lives in the contextual left sidebar now (no horizontal tabs). */}
      <div className="mt-6">
        {activeLocked ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card py-16 text-center">
            <Lock aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm font-medium">
              {t("This stage isn't active yet")}
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("It unlocks when the tournament reaches")}{" "}
              <span className="font-medium">{lockLabel(activeTab?.stageKey ?? null)}</span>.{" "}
              {t("Advance from Overview when you're ready.")}
            </p>
          </div>
        ) : (
          <Outlet />
        )}
      </div>

      {!activeLocked && flowPage ? <StageContinue tournamentId={id} /> : null}
    </div>
  );
}
