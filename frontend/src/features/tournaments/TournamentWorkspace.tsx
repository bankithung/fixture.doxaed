import {
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  ExternalLink,
  Lock,
  Trophy,
} from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import { StageContinue } from "./StageContinue";
import { pathStageKey } from "@/features/layout/computeNavItems";
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
  ready: routes.tournamentOverview,
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
  const slug = tournament.data?.slug ?? "";
  const stage = stageQ.data;
  const curIdx = stage ? stage.order.indexOf(stage.stage) : -1;
  // Highlight the stage whose PAGE we're on, not the tournament's server stage
  // (so Setup is highlighted on the Sports page, not Fixtures). Stage-agnostic
  // pages (Overview/Settings) fall back to the tournament's current stage.
  const viewedKey = pathStageKey(location.pathname);
  const activeIdx = stage && viewedKey ? stage.order.indexOf(viewedKey) : curIdx;

  // Once fixtures are generated (`ready`) the workspace is live-operations
  // software, not a setup wizard: full-width, the setup stepper gives way to a
  // compact ops status ribbon, and the sidebar's Operations group leads
  // (computeTournamentNav). Applies to every role at `ready` (ops 2026-06-26).
  const opsMode = !!stage && stage.stage === "ready";

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
  // The flow's "Continue" rides under stage WORK pages — Overview has the
  // full stepper, Settings/Forms aren't stages, and Sports carries its OWN
  // staged continue (pick → categories → review → generate), so a second
  // stage button there competed with the flow (owner 2026-06-10).
  const flowPage =
    !!activeTab &&
    !["Overview", "Settings", "Forms", "Sports"].includes(activeTab.label);

  // The Sports setup page (its Review org-chart especially) needs the full width
  // so wide category trees fit without a horizontal scrollbar; every other setup
  // stage keeps the readable, centred max-w-5xl column.
  const fullWidth = opsMode || viewedKey === "setup";

  return (
    <div
      className={cn(
        "flex w-full flex-col px-4 py-6 sm:px-6 lg:px-8",
        fullWidth ? "" : "mx-auto max-w-5xl",
      )}
    >
      {/* "All tournaments" is in the stepper sidebar on desktop; only the mobile
          view (no sidebar during setup) needs this back link. */}
      <div className="mb-4 flex items-center justify-between gap-2 md:hidden">
        <NavLink
          to={routes.tournaments()}
          className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t("All tournaments")}
        </NavLink>
      </div>

      {opsMode ? (
        // Operations ribbon — replaces the setup stepper once fixtures exist.
        <div
          data-testid="ops-ribbon"
          className="flex flex-wrap items-center gap-3"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10">
            <Trophy aria-hidden="true" className="h-5 w-5 text-primary" />
          </span>
          <div className="min-w-0">
            <p className="text-[0.625rem] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t("Live operations")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {name}
              </h1>
              <span
                className={cn(
                  "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                  STATUS_CLS[status] ?? "bg-muted text-muted-foreground",
                )}
              >
                {t(status.replace(/_/g, " "))}
              </span>
            </div>
          </div>
          {slug ? (
            <a
              href={routes.publicSchedule(slug, id)}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ExternalLink aria-hidden="true" className="h-4 w-4" />
              <span className="hidden sm:inline">{t("Public page")}</span>
            </a>
          ) : null}
        </div>
      ) : (
        /* The full Setup -> Ready journey now lives in the left stepper sidebar
           (desktop) and the mobile strip below, so this header just carries the
           tournament's identity. */
        <div className="flex flex-col gap-4">
          <section className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground sm:h-14 sm:w-14">
              <Trophy aria-hidden="true" className="h-6 w-6 sm:h-7 sm:w-7" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-bold tracking-tight sm:text-2xl">
                {name}
              </h1>
              <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-2 w-2 rounded-full",
                    status === "draft" ? "bg-muted-foreground/50" : "bg-success",
                  )}
                />
                <span className="capitalize">{t(status.replace(/_/g, " "))}</span>
              </div>
            </div>
          </section>

          {/* Mobile stage strip — the desktop sidebar owns this on md+. The chip
              for the page you're on is highlighted (route-aware). */}
          {stage ? (
            <nav
              aria-label={t("Setup progress")}
              className="flex flex-wrap items-center gap-x-1 gap-y-2 md:hidden"
            >
              {stage.order.map((s, i) => {
              const info = stage.stages[i];
              const reached = i <= curIdx;
              const isCurrent = i === activeIdx;
              const dest = STAGE_ROUTE[s]?.(id);
              // Every reached stage (the CURRENT one included) navigates to
              // its work page — from a sub-page like Forms, the current chip
              // is the way back to the stage's main page. Only a chip whose
              // page you're already on is inert.
              const clickable =
                reached && !!dest && location.pathname !== dest;
              const chip = (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-2.5 text-xs font-medium transition-colors",
                    isCurrent
                      ? "bg-primary text-primary-foreground"
                      : reached
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground",
                    clickable && (isCurrent ? "hover:bg-primary/85" : "hover:bg-primary/20"),
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
      )}

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
