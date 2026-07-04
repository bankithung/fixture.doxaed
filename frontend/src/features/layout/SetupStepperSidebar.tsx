import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, Lock, Settings } from "lucide-react";
import type { StagePayload } from "@/api/tournaments";
import { BrandLogo } from "@/components/ui/BrandLogo";
import { Meter } from "@/features/dashboard/charts";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { STAGE_WORK_ROUTE, pathStageKey } from "./computeNavItems";
import "@/components/backdrop/effects.css";

/** One-line subtitle per stage — what you actually do there (the server owns
 * the labels; this is FE affordance copy, like STAGE_ICON in StageStepper). */
const STAGE_SUB: Record<string, string> = {
  setup: "Sports & categories",
  org_registration: "Register schools",
  team_registration: "Add teams",
  members: "Invite people & roles",
  fixtures: "Generate & schedule",
  ready: "Review & publish",
};

/**
 * Vertical stage stepper shown INSTEAD of the nav rail during tournament setup
 * (AppShell `setupMode`). The whole Setup -> Ready journey is one numbered
 * column under a progress meter: completed stages draw their check in, the
 * current stage carries an "In progress" chip, future stages sit dimmed with
 * a lock until reached. Each row is ONE full-width hit target. The step whose
 * PAGE you're viewing gets the "you are here" highlight (route-derived), so
 * on the Sports page the Setup step is active — never Fixtures (owner: the
 * highlight must match the page you're on). Solid design tokens only.
 *
 * Reached stages (<= the tournament's current stage) are clickable shortcuts
 * to their work page; future stages are inert until the flow reaches them.
 */
export function SetupStepperSidebar({
  tournamentId,
  stage,
}: {
  tournamentId: string;
  stage: StagePayload | null;
}): React.ReactElement {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const order = stage?.order ?? [];
  const curIdx = stage ? order.indexOf(stage.stage) : -1;
  // The stage whose page we're on drives the highlight; stage-agnostic pages
  // (Overview/Settings) fall back to the tournament's real current stage.
  const viewedKey = pathStageKey(pathname);
  const activeIdx = viewedKey ? order.indexOf(viewedKey) : curIdx;
  const settingsHref = routes.tournamentSettings(tournamentId);
  const doneCount = Math.max(0, curIdx);

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-card md:flex">
      <div className="flex h-14 shrink-0 items-center border-b border-border px-4">
        <Link
          to={routes.landing()}
          className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandLogo className="h-7 w-7 rounded-lg shadow-sm" alt={t("Fixture")} />
          {t("Fixture")}
        </Link>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto p-3">
        <Link
          to={routes.tournaments()}
          className="mb-3 flex w-fit items-center gap-1.5 rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {t("All tournaments")}
        </Link>

        {/* Journey summary: how far through setup this tournament is. */}
        <div className="mb-3 rounded-lg border border-border/60 bg-background px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {t("Setup progress")}
            </p>
            <p className="font-tabular text-xs font-semibold">
              {doneCount}/{order.length}
            </p>
          </div>
          <div className="mt-2">
            <Meter completed={doneCount} total={order.length || 1} />
          </div>
        </div>

        <nav aria-label={t("Setup progress")}>
          <ol className="flex flex-col">
            {order.map((key, i) => {
              const info = stage?.stages[i];
              const label = info?.label ?? key;
              const done = i < curIdx;
              const current = i === curIdx;
              const active = i === activeIdx;
              const reached = i <= curIdx;
              const isLast = i === order.length - 1;
              const dest = STAGE_WORK_ROUTE[key]?.(tournamentId);
              const clickable = reached && !!dest && pathname !== dest;
              return (
                <li key={key} className="relative">
                  {!isLast ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute bottom-0 left-[1.4rem] top-10 w-0.5 -translate-x-1/2 rounded-full transition-colors duration-300",
                        done ? "bg-primary" : "bg-border",
                      )}
                    />
                  ) : null}
                  {/* ONE full-row hit target: circle + copy + state hint. */}
                  <button
                    type="button"
                    disabled={!clickable}
                    aria-current={active ? "step" : undefined}
                    onClick={() => clickable && dest && navigate(dest)}
                    title={
                      reached ? undefined : t("Complete the earlier steps first")
                    }
                    className={cn(
                      "relative flex w-full items-start gap-3 rounded-lg p-2 pb-4 text-left transition-colors last:pb-2",
                      active
                        ? "bg-accent"
                        : clickable
                          ? "cursor-pointer hover:bg-accent/60"
                          : "cursor-default",
                      !reached && "opacity-60",
                    )}
                  >
                    <span
                      className={cn(
                        "relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors duration-300",
                        done || current
                          ? "bg-primary text-primary-foreground"
                          : "border-2 border-border bg-card text-muted-foreground",
                        active && "ring-4 ring-primary/20",
                      )}
                    >
                      {done ? (
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={3}
                          className="step-check h-3.5 w-3.5"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      ) : current ? (
                        <span className="h-2 w-2 rounded-full bg-primary-foreground" />
                      ) : (
                        <span className="font-tabular">{i + 1}</span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "truncate text-sm leading-tight",
                            active
                              ? "font-semibold text-foreground"
                              : reached
                                ? "font-medium text-foreground"
                                : "text-muted-foreground",
                          )}
                        >
                          {label}
                        </span>
                        {current ? (
                          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-medium text-primary">
                            {t("In progress")}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {t(STAGE_SUB[key] ?? "")}
                      </span>
                    </span>
                    {!reached ? (
                      <Lock
                        aria-hidden="true"
                        className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      </div>

      {/* Settings stays reachable through the whole setup flow. */}
      <div className="shrink-0 border-t border-border p-3">
        <Link
          to={settingsHref}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
            pathname === settingsHref
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <Settings aria-hidden="true" className="h-[18px] w-[18px] shrink-0" />
          {t("Settings")}
        </Link>
      </div>
    </aside>
  );
}
