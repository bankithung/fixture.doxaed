import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownUp,
  ChevronRight,
  ListChecks,
  Mail,
  Plus,
  Search,
  Trophy,
} from "lucide-react";
import { useAuthStore } from "@/features/auth/authStore";
import { tournamentsApi, type Tournament } from "@/api/tournaments";
import { invitationsApi } from "@/api/invitations";
import { overviewApi, type Overview } from "@/api/overview";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/input";
import {
  STATUS_FILTER,
  relativeTime,
  statusMeta,
} from "@/features/layout/OrgDashboardPage";
import { BentoCard, BentoGrid } from "@/features/dashboard/BentoCard";
import { StatTile } from "@/features/dashboard/StatTile";
import { RangePills } from "@/features/dashboard/RangePills";
import {
  ActivityChart,
  ActivityLegend,
  BreakdownTable,
  Meter,
  fillDays,
  type ActivityWindow,
} from "@/features/dashboard/charts";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { TodayRail } from "./TodayRail";

/**
 * The personal Dashboard — the individual WORKSPACE view, identical for every
 * account (owner decision 2026-06-11: root pages are individual-level; orgs
 * are a hidden implementation detail and never surface here). The complete
 * cross-tournament analytics overview: KPI band + charts (fed by
 * /api/me/overview/) on MagicBento cells, the Today rail, and the tournaments
 * table. With nothing to show, a single welcome CTA centered both ways.
 */
export function OrgChooserPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const { isMobile } = useBreakpoint();

  const tournamentsQuery = useQuery({
    queryKey: ["tournaments"],
    queryFn: () => tournamentsApi.list(),
  });
  const invitesQuery = useQuery({
    queryKey: ["my-invitations"],
    queryFn: invitationsApi.myInvitations,
  });
  const overviewQuery = useQuery({
    queryKey: ["me-overview"],
    queryFn: overviewApi.get,
    refetchInterval: 60_000,
  });

  const all: Tournament[] = useMemo(
    () => tournamentsQuery.data ?? [],
    [tournamentsQuery.data],
  );
  const pendingInvites = (invitesQuery.data ?? []).filter(
    (inv) => inv.status === "pending",
  );
  const ov: Overview | undefined = overviewQuery.data;
  const loading =
    tournamentsQuery.isLoading ||
    invitesQuery.isLoading ||
    overviewQuery.isLoading;

  const [window, setWindow] = useState<ActivityWindow>("all");

  // Last 12 days of match volume for the Matches tile sparkline.
  const spark = useMemo(() => {
    if (!ov) return undefined;
    return fillDays(ov.matches_per_day, "30d")
      .slice(-12)
      .map((d) => d.completed + d.live + d.scheduled);
  }, [ov]);

  // Client-side fallbacks so the page still stands if /overview/ errors.
  const liveTournaments = all.filter((x) => x.status.startsWith("live")).length;

  // Table filter + sort (client-side over list()).
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortAsc, setSortAsc] = useState(true);
  const rows = useMemo(() => {
    let r = all;
    if (statusFilter !== "all") {
      r = r.filter((x) =>
        statusFilter === "live" ? x.status.startsWith("live") : x.status === statusFilter,
      );
    }
    const q = search.trim().toLowerCase();
    if (q) r = r.filter((x) => x.name.toLowerCase().includes(q));
    return [...r].sort((a, b) =>
      sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name),
    );
  }, [all, statusFilter, search, sortAsc]);

  if (!user) return <div />;

  if (loading) {
    return (
      <div className="flex w-full flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <div
          className="h-56 animate-pulse rounded-xl border border-border bg-card"
          data-testid="dashboard-skeleton"
        />
      </div>
    );
  }

  // Nothing at all yet → one welcoming CTA, centered in the viewport.
  if (all.length === 0 && pendingInvites.length === 0) {
    return (
      <div className="flex w-full flex-1 items-center justify-center px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
            <Trophy aria-hidden="true" className="h-7 w-7 text-primary" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {t("Welcome to Fixture")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                "No tournaments yet. Create one to get started.",
              )}
            </p>
          </div>
          <Link
            to={routes.tournamentNew()}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("Start your first tournament")}
          </Link>
        </div>
      </div>
    );
  }

  const unavailable = (
    <p className="p-4 text-sm text-muted-foreground">
      {t("Analytics unavailable right now.")}
    </p>
  );

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {isMobile
              ? t("Welcome back")
              : `${t("Welcome back")}${user.name ? `, ${user.name}` : ""}`}
          </p>
          <h1 className="page-title mt-1 truncate">
            {t("Dashboard")}
          </h1>
        </div>
        <Link
          to={routes.tournamentNew()}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t("New tournament")}
        </Link>
      </div>

      {pendingInvites.length > 0 ? (
        <Link
          to={routes.invites()}
          data-testid="pending-invites-callout"
          className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-center gap-3">
            <Mail aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-medium">
                {t(
                  `${pendingInvites.length} pending ${
                    pendingInvites.length === 1 ? "invitation" : "invitations"
                  }`,
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("Accept to join these tournaments.")}
              </p>
            </div>
          </div>
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground/50"
          />
        </Link>
      ) : null}

      <BentoGrid className="flex flex-col gap-4">
        {/* KPI band */}
        <div
          className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
          data-testid="kpi-strip"
        >
          <BentoCard particles>
            <StatTile
              label={t("Tournaments")}
              value={ov?.totals.tournaments ?? all.length}
              sub={
                (ov?.totals.tournaments_live ?? liveTournaments) > 0
                  ? `${ov?.totals.tournaments_live ?? liveTournaments} ${t("live")}`
                  : t("you're part of")
              }
            />
          </BentoCard>
          <BentoCard particles>
            <StatTile
              label={t("Live now")}
              value={ov?.totals.matches_live ?? 0}
              live={(ov?.totals.matches_live ?? 0) > 0}
              sub={t("matches in progress")}
            />
          </BentoCard>
          <BentoCard particles>
            <StatTile
              label={t("Today")}
              value={ov?.totals.matches_today ?? 0}
              sub={`${ov?.totals.matches_next7 ?? 0} ${t("in the next 7 days")}`}
            />
          </BentoCard>
          <BentoCard particles>
            <StatTile
              label={t("Matches")}
              value={ov?.totals.matches ?? 0}
              sub={`${ov?.totals.matches_completed ?? 0} ${t("completed")}`}
              spark={spark}
            />
          </BentoCard>
          <BentoCard particles>
            <StatTile
              label={t("Teams")}
              value={ov?.totals.teams ?? 0}
              sub={`${ov?.totals.players ?? 0} ${t("players")}`}
            />
          </BentoCard>
          <BentoCard particles>
            <StatTile
              label={t("Goals")}
              value={ov?.totals.goals ?? 0}
              sub={t("in completed matches")}
            />
          </BentoCard>
        </div>

        {/* Charts + rails */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <BentoCard className="lg:col-span-2" testId="overview-activity">
            <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-1.5">
              <h2 className="panel-title">{t("Match activity")}</h2>
              <ActivityLegend />
              <div className="ml-auto">
                <RangePills
                  label={t("Chart window")}
                  value={window}
                  onChange={(v) => setWindow(v as ActivityWindow)}
                  options={[
                    { value: "all", label: t("All") },
                    { value: "30d", label: t("Past 30") },
                    { value: "7d", label: t("Past 7") },
                    { value: "next14", label: t("Next 14") },
                  ]}
                />
              </div>
            </div>
            {ov ? (
              <div className="p-3">
                <ActivityChart days={ov.matches_per_day} window={window} />
              </div>
            ) : (
              unavailable
            )}
          </BentoCard>

          <div className="flex flex-col gap-3 lg:row-span-2">
            <TodayRail />
            <BentoCard>
              <div className="panel-header">
                <h2 className="panel-title">{t("Quick actions")}</h2>
              </div>
              <div className="grid grid-cols-1 gap-2 p-3">
                <Link to={routes.tournaments()} className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-sm transition-colors hover:border-primary/40 hover:bg-accent">
                  <ListChecks aria-hidden="true" className="h-4 w-4 text-primary" />
                  {t("Browse tournaments")}
                </Link>
                <Link to={routes.tournamentNew()} className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-sm transition-colors hover:border-primary/40 hover:bg-accent">
                  <Plus aria-hidden="true" className="h-4 w-4 text-primary" />
                  {t("New tournament")}
                </Link>
                <Link to={routes.invites()} className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5 text-sm transition-colors hover:border-primary/40 hover:bg-accent">
                  <Mail aria-hidden="true" className="h-4 w-4 text-primary" />
                  {t("Invitations")}
                </Link>
              </div>
            </BentoCard>
          </div>

          <BentoCard testId="overview-status">
            <div className="panel-header">
              <h2 className="panel-title">{t("Tournaments by status")}</h2>
            </div>
            {ov && ov.tournament_status.length > 0 ? (
              <div className="pb-1">
                <p className="px-4 pb-2 pt-3 text-xs text-muted-foreground">
                  {t("Where every tournament stands, with its match and team volume.")}
                </p>
                <BreakdownTable
                  columns={[t("Total"), t("Matches"), t("Teams")]}
                  rows={ov.tournament_status.map((row) => ({
                    label: t(statusMeta(row.status).label),
                    values: [row.count, row.matches, row.teams],
                    isLive: row.status === "live",
                  }))}
                />
              </div>
            ) : (
              unavailable
            )}
          </BentoCard>

          <BentoCard testId="overview-sports">
            <div className="panel-header">
              <h2 className="panel-title">{t("Matches by sport")}</h2>
            </div>
            {ov && ov.sports.length > 0 ? (
              <div className="pb-1">
                <p className="px-4 pb-2 pt-3 text-xs text-muted-foreground">
                  {t("Match volume per sport, split by played, live and upcoming.")}
                </p>
                <BreakdownTable
                  columns={[t("Total"), t("Played"), t("Live"), t("Upcoming")]}
                  rows={ov.sports.slice(0, 6).map((s) => ({
                    label: s.name,
                    values: [s.matches, s.completed, s.live, s.scheduled],
                    isLive: s.live > 0,
                  }))}
                />
              </div>
            ) : (
              unavailable
            )}
          </BentoCard>

          <BentoCard className="lg:col-span-2" testId="overview-progress">
            <div className="panel-header">
              <h2 className="panel-title">{t("Tournament progress")}</h2>
            </div>
            {ov && ov.progress.length > 0 ? (
              <ul className="grid grid-cols-1 gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
                {ov.progress.slice(0, 6).map((p, i) => (
                  <li key={p.id}>
                    <div className="flex items-baseline justify-between gap-2 text-xs">
                      <Link
                        to={routes.tournamentDetail(p.id)}
                        className="min-w-0 truncate font-medium text-foreground hover:text-primary"
                      >
                        {p.name}
                      </Link>
                      <span className="shrink-0 font-tabular text-muted-foreground">
                        {p.live > 0 ? (
                          <span className="mr-1.5 font-semibold text-primary">
                            {p.live} {t("live")}
                          </span>
                        ) : null}
                        {p.completed}/{p.total}
                      </span>
                    </div>
                    <div className="mt-1.5">
                      <Meter completed={p.completed} total={p.total} delayMs={i * 60} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                {t("No fixtures generated yet.")}
              </p>
            )}
          </BentoCard>

          <BentoCard testId="overview-results">
            <div className="panel-header">
              <h2 className="panel-title">{t("Latest results")}</h2>
            </div>
            {ov && ov.recent_results.length > 0 ? (
              <ul className="divide-y divide-border">
                {ov.recent_results.slice(0, 6).map((r) => (
                  <li key={r.match_id}>
                    <Link
                      to={routes.matchConsole(r.tournament_id, r.match_id)}
                      className="flex flex-col gap-0.5 px-4 py-2 transition-colors hover:bg-accent"
                    >
                      <span className="truncate text-xs text-muted-foreground">
                        {r.tournament_name}
                      </span>
                      <span className="flex items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{r.home}</span>
                        <span className="shrink-0 font-tabular font-semibold">
                          {r.home_score ?? 0}-{r.away_score ?? 0}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-right">
                          {r.away}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                {t("No completed matches yet.")}
              </p>
            )}
          </BentoCard>
        </div>
      </BentoGrid>

      {/* Tournaments table (spine) */}
      <section aria-label={t("Tournaments")}>
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <h2 className="mr-auto text-sm font-semibold">{t("Tournaments")}</h2>
            <div className="relative">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t("Search tournaments")}
                placeholder={t("Search…")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 w-40 pl-8 sm:w-52"
              />
            </div>
            <Select
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_FILTER}
              aria-label={t("Filter by status")}
              className="w-40"
            />
          </div>

          {rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <Trophy aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                {all.length === 0 ? t("No tournaments yet.") : t("No tournaments match your filters.")}
              </p>
            </div>
          ) : isMobile ? (
            <div className="space-y-2 p-3">
              {rows.map((tn) => {
                const sm = statusMeta(tn.status);
                return (
                  <Link
                    key={tn.id}
                    to={routes.tournamentDetail(tn.id)}
                    data-testid={`dashboard-tournament-${tn.id}`}
                    className="block rounded-lg border border-border p-3 transition-colors hover:bg-accent/40"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{tn.name}</span>
                      <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", sm.badge)}>
                        <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} />
                        {t(sm.label)}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {tn.slug} · {relativeTime(tn.created_at)}
                    </div>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">
                      <button
                        type="button"
                        onClick={() => setSortAsc((v) => !v)}
                        className="inline-flex items-center gap-1 hover:text-foreground"
                      >
                        {t("Name")}
                        <ArrowDownUp aria-hidden="true" className="h-3.5 w-3.5 opacity-50" />
                      </button>
                    </th>
                    <th className="px-4 py-2.5 font-medium">{t("Status")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Created")}</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((tn) => {
                    const sm = statusMeta(tn.status);
                    return (
                      <tr
                        key={tn.id}
                        className="group border-t border-border transition-colors hover:bg-accent/40"
                      >
                        <td className="px-4 py-2.5">
                          <Link
                            to={routes.tournamentDetail(tn.id)}
                            data-testid={`dashboard-tournament-${tn.id}`}
                            className="flex flex-col"
                          >
                            <span className="font-medium text-foreground group-hover:text-primary">
                              {tn.name}
                            </span>
                            <span className="text-xs text-muted-foreground">{tn.slug}</span>
                          </Link>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium", sm.badge)}>
                            <span className={cn("h-1.5 w-1.5 rounded-full", sm.dot)} />
                            {t(sm.label)}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 font-tabular text-muted-foreground">
                          {relativeTime(tn.created_at)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Link to={routes.tournamentDetail(tn.id)} aria-label={t("Open")}>
                            <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 text-muted-foreground/40 group-hover:text-foreground" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
