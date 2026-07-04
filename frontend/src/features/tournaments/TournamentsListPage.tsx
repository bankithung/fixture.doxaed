import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ChevronRight, Plus, Search, Trophy, Users } from "lucide-react";
import { tournamentsApi, type Tournament } from "@/api/tournaments";
import { overviewApi, type OverviewProgressRow } from "@/api/overview";
import { Input } from "@/components/ui/input";
import { RoleBadge } from "@/components/ui/RoleBadge";
import { BentoCard, BentoGrid } from "@/features/dashboard/BentoCard";
import { StatTile } from "@/features/dashboard/StatTile";
import { RangePills } from "@/features/dashboard/RangePills";
import { Meter } from "@/features/dashboard/charts";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { RenameTournamentButton } from "./RenameTournamentButton";
import { canManageTournament } from "./tournamentPermissions";

/**
 * Color-coded tournament status (soft tint + accessible text, dark-mode aware).
 * Mirrors the named-palette pill convention already used for institution
 * statuses — a richer signal than the flat brand tokens.
 */
// Tokens only (owner rule): semantic status colors, no Tailwind palette.
const STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
  published: { label: "Published", cls: "bg-info-muted text-info-foreground" },
  registration_open: {
    label: "Registration open",
    cls: "bg-success-muted text-success-foreground",
  },
  scheduled: { label: "Scheduled", cls: "bg-secondary text-secondary-foreground" },
  completed: { label: "Completed", cls: "bg-accent text-accent-foreground" },
  archived: { label: "Archived", cls: "bg-muted text-muted-foreground" },
};

function statusStyle(status: string): { label: string; cls: string; pulse: boolean } {
  if (status.startsWith("live"))
    return { label: "Live", cls: "bg-primary/15 text-primary", pulse: true };
  const s = STATUS_STYLES[status];
  return {
    label: s?.label ?? status.replace(/_/g, " "),
    cls: s?.cls ?? "bg-muted text-muted-foreground",
    pulse: false,
  };
}

/** Soft, distinct monogram tint per tournament (deterministic by name) —
 * token opacity steps, not palette colors. */
const TINTS = [
  "bg-primary/15 text-primary",
  "bg-success-muted text-success-foreground",
  "bg-info-muted text-info-foreground",
  "bg-warning-muted text-warning-foreground",
  "bg-secondary text-secondary-foreground",
  "bg-accent text-accent-foreground",
];

function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

function formatCreated(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return "·";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function sportLabel(code: string | null): string {
  return code ? code.replace(/_/g, " ") : "";
}

/** Square monogram tile anchoring each card, softly tinted per tournament. */
export function Monogram({ name }: { name: string }): React.ReactElement {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-lg text-sm font-semibold",
        tintFor(name),
      )}
    >
      {initial}
    </span>
  );
}

export function StatusPill({ status }: { status: string }): React.ReactElement {
  const s = statusStyle(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        s.cls,
      )}
    >
      <span aria-hidden="true" className="relative flex h-1.5 w-1.5">
        {s.pulse ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        ) : null}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {t(s.label)}
    </span>
  );
}

/** How the user got this tournament: gold Owner chip (created it / owns the
 * workspace) vs the tournament-scoped role(s) they were invited with. */
function AccessBadge({ tn }: { tn: Tournament }): React.ReactElement | null {
  if (tn.origin === "owner") return <RoleBadge role="owner" />;
  const roles = tn.my_roles ?? [];
  if (tn.origin !== "invited" || roles.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {roles.map((role) => (
        <RoleBadge key={role} role={role} />
      ))}
    </span>
  );
}

/** The sports a tournament runs, as quiet chips (falls back to the legacy
 * single sport code). */
function SportChips({ tn }: { tn: Tournament }): React.ReactElement | null {
  const names =
    tn.sports.length > 0
      ? tn.sports.map((s) => s.name || s.key)
      : tn.sport_code
        ? [sportLabel(tn.sport_code)]
        : [];
  if (names.length === 0) return null;
  const shown = names.slice(0, 3);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((name) => (
        <span
          key={name}
          className="rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium capitalize text-secondary-foreground"
        >
          {name}
        </span>
      ))}
      {names.length > shown.length ? (
        <span className="text-[11px] font-medium text-muted-foreground">
          +{names.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "registration_open", label: "Open" },
  { value: "scheduled", label: "Scheduled" },
  { value: "draft", label: "Draft" },
  { value: "completed", label: "Completed" },
];

/** Live first, then the busiest; ties break on newest. */
function rank(tn: Tournament, stats?: OverviewProgressRow): number {
  const live = tn.status.startsWith("live") ? 1 : 0;
  return live * 1_000_000 + (stats?.total ?? 0);
}

/**
 * The primary post-login surface: tournaments the user runs OR was invited
 * into (server isolation-scoped), as full-width MagicBento cards carrying
 * each tournament's volume (teams, played/total meter, live count) from
 * /api/me/overview/. (Member invites live inside each tournament's Members
 * area, not here.)
 */
export function TournamentsListPage(): React.ReactElement {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const query = useQuery({
    queryKey: ["tournaments"],
    queryFn: () => tournamentsApi.list(),
  });
  const overviewQuery = useQuery({
    queryKey: ["me-overview"],
    queryFn: overviewApi.get,
    staleTime: 30_000,
  });
  const all = useMemo(() => query.data ?? [], [query.data]);
  const statsById = useMemo(() => {
    const map = new Map<string, OverviewProgressRow>();
    for (const row of overviewQuery.data?.progress ?? []) map.set(row.id, row);
    return map;
  }, [overviewQuery.data]);

  const counts = useMemo(
    () => ({
      total: all.length,
      live: all.filter((tn) => tn.status.startsWith("live")).length,
      open: all.filter((tn) => tn.status === "registration_open").length,
      completed: all.filter((tn) => tn.status === "completed").length,
    }),
    [all],
  );

  const q = search.trim().toLowerCase();
  const tournaments = useMemo(() => {
    let r = all;
    if (statusFilter !== "all") {
      r = r.filter((tn) =>
        statusFilter === "live"
          ? tn.status.startsWith("live")
          : tn.status === statusFilter,
      );
    }
    if (q) {
      r = r.filter(
        (tn) =>
          tn.name.toLowerCase().includes(q) || tn.slug.toLowerCase().includes(q),
      );
    }
    return [...r].sort((a, b) => {
      const d = rank(b, statsById.get(b.id)) - rank(a, statsById.get(a.id));
      if (d !== 0) return d;
      return b.created_at.localeCompare(a.created_at);
    });
  }, [all, statusFilter, q, statsById]);

  const startCta = (
    <Link
      to={routes.tournamentNew()}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Plus aria-hidden="true" className="h-4 w-4" />
      {t("Start a tournament")}
    </Link>
  );

  return (
    <div className="flex w-full flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="page-title">{t("Your tournaments")}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("Tournaments you run or were invited into.")}
          </p>
        </div>
        {startCta}
      </div>

      {query.isLoading ? (
        <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not load tournaments.")}
        </p>
      ) : all.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <Trophy aria-hidden="true" className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {t("You haven't started any tournaments yet.")}
          </p>
          {startCta}
        </div>
      ) : (
        <BentoGrid className="flex flex-col gap-4">
          {/* Pulse band — compact tiles (owner: the md tiles read big here). */}
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <BentoCard>
              <StatTile
                size="sm"
                label={t("Tournaments")}
                value={counts.total}
                sub={
                  overviewQuery.data
                    ? `${overviewQuery.data.totals.matches.toLocaleString()} ${t("matches")}`
                    : undefined
                }
              />
            </BentoCard>
            <BentoCard particles>
              <StatTile
                size="sm"
                label={t("Live now")}
                value={counts.live}
                live={counts.live > 0}
                sub={t("tournaments underway")}
              />
            </BentoCard>
            <BentoCard>
              <StatTile
                size="sm"
                label={t("Open registrations")}
                value={counts.open}
                sub={t("accepting teams")}
              />
            </BentoCard>
            <BentoCard>
              <StatTile
                size="sm"
                label={t("Completed")}
                value={counts.completed}
                sub={t("finished seasons")}
              />
            </BentoCard>
          </div>

          {/* One panel: full-width toolbar + the tournament grid. */}
          <BentoCard className="flex flex-col" testId="tournaments-panel">
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
              <label className="relative min-w-[14rem] flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("Search tournaments…")}
                  className="h-9 w-full pl-9"
                  aria-label={t("Search tournaments")}
                />
              </label>
              <RangePills
                label={t("Filter by status")}
                value={statusFilter}
                onChange={setStatusFilter}
                options={STATUS_FILTERS.map((f) => ({
                  value: f.value,
                  label: t(f.label),
                }))}
              />
              <span className="shrink-0 font-tabular text-xs text-muted-foreground">
                {tournaments.length === all.length
                  ? all.length
                  : `${tournaments.length}/${all.length}`}
              </span>
            </div>

            {tournaments.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {t("No tournaments match your filters.")}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {tournaments.map((tn, i) => (
                  <TournamentCard
                    key={tn.id}
                    tn={tn}
                    stats={statsById.get(tn.id)}
                    delayMs={Math.min(i, 11) * 45}
                  />
                ))}
              </div>
            )}
          </BentoCard>
        </BentoGrid>
      )}
    </div>
  );
}

function TournamentCard({
  tn,
  stats,
  delayMs,
}: {
  tn: Tournament;
  stats?: OverviewProgressRow;
  delayMs: number;
}): React.ReactElement {
  const canManage = canManageTournament(tn.origin, tn.my_roles);
  const played = stats?.completed ?? 0;
  const total = stats?.total ?? 0;
  return (
    <BentoCard
      className="group flex animate-fade-up flex-col"
      style={{ animationDelay: `${delayMs}ms` }}
      testId={`tournament-card-${tn.id}`}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <Monogram name={tn.name} />
        <div className="min-w-0 flex-1">
          <Link
            to={routes.tournamentDetail(tn.id)}
            className="block truncate font-medium tracking-tight hover:text-primary focus-visible:text-primary focus-visible:underline focus-visible:outline-none"
          >
            {tn.name}
          </Link>
          <div className="truncate font-tabular text-xs text-muted-foreground">
            {tn.slug}
          </div>
        </div>
        <StatusPill status={tn.status} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
        <SportChips tn={tn} />
        <AccessBadge tn={tn} />
      </div>

      {total > 0 ? (
        <div className="px-4 pb-3">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              {stats && stats.live > 0 ? (
                <span className="mr-1.5 font-semibold text-primary">
                  {stats.live} {t("live")}
                </span>
              ) : null}
              {t("Matches played")}
            </span>
            <span className="font-tabular font-semibold">
              {played}/{total}
            </span>
          </div>
          <div className="mt-1.5">
            <Meter completed={played} total={total} delayMs={delayMs} />
          </div>
        </div>
      ) : null}

      <div className="mt-auto flex items-center gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        {stats && stats.teams > 0 ? (
          <span className="flex items-center gap-1">
            <Users aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="font-tabular">{stats.teams}</span> {t("teams")}
          </span>
        ) : null}
        <span className="font-tabular">{formatCreated(tn.created_at)}</span>
        <span className="ml-auto flex items-center gap-1">
          {canManage ? (
            <RenameTournamentButton tournamentId={tn.id} currentName={tn.name} />
          ) : null}
          <Link
            to={routes.tournamentDetail(tn.id)}
            aria-label={t("Open")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden="true"
              className="h-4 w-4 text-muted-foreground/50 transition-all group-hover:translate-x-0.5 group-hover:text-foreground"
            />
          </Link>
        </span>
      </div>
    </BentoCard>
  );
}
