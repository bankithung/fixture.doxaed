import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  Users,
  Zap,
} from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import type { AuditEvent } from "@/api/audit";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { BentoGrid } from "@/features/dashboard/BentoCard";
import { StarBorder } from "@/components/ui/StarBorder";
import "@/components/ui/star-border.css";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Tournament-scoped audit log (Increment 11). Mirrors `OrgAuditLogPage` but
 * reads `GET /api/tournaments/:id/audit/`, which is MANAGER-ONLY on the server
 * (403 for non-managers, 404 if the tournament isn't accessible). The page is
 * reachable in tournament nav by anyone in tournament context; access is
 * enforced here — a 403 renders a friendly "managers only" empty state.
 *
 * The endpoint returns the newest-first feed in one shot (no cursor paging),
 * so there's no pager.
 */

function formatTimestamp(iso: string): { date: string; time: string } {
  try {
    const d = new Date(iso);
    return {
      date: d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
      }),
      time: d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    };
  } catch {
    return { date: iso, time: "" };
  }
}

// Map the leading namespace of an event_type to a token-based chip.
function namespaceMeta(ns: string): { badge: string; dot: string } {
  const map: Record<string, { badge: string; dot: string }> = {
    tournament: { badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    match: { badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    org: { badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    membership: {
      badge: "bg-secondary text-secondary-foreground",
      dot: "bg-primary",
    },
    user: { badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    grant: {
      badge: "bg-accent text-accent-foreground",
      dot: "bg-muted-foreground",
    },
    permission: {
      badge: "bg-accent text-accent-foreground",
      dot: "bg-muted-foreground",
    },
    dispute: {
      badge: "bg-destructive/15 text-destructive",
      dot: "bg-destructive",
    },
  };
  return (
    map[ns] ?? {
      badge: "bg-muted text-muted-foreground",
      dot: "bg-muted-foreground/40",
    }
  );
}

function EventTypeBadge({
  event_type,
}: {
  event_type: string;
}): React.ReactElement {
  const [namespace] = event_type.split(".");
  const action = event_type.slice(namespace.length + 1);
  const meta = namespaceMeta(namespace);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        meta.badge,
      )}
      title={event_type}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
      <span className="font-medium">{namespace}</span>
      {action ? (
        <>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span className="font-normal">{action}</span>
        </>
      ) : null}
    </span>
  );
}

function ActorLabel({ ev }: { ev: AuditEvent }): React.ReactElement {
  if (ev.actor_email_at_time) {
    return (
      <span className="truncate text-foreground">{ev.actor_email_at_time}</span>
    );
  }
  return <span className="text-muted-foreground">{t("System")}</span>;
}

const PAGE_SIZE = 25;

export function TournamentAuditPage(): React.ReactElement {
  const { id = "" } = useParams<{ id: string }>();
  const { isMobile } = useBreakpoint();
  const [namespaceFilter, setNamespaceFilter] = React.useState("all");
  const [page, setPage] = React.useState(0);

  const query = useQuery<
    Awaited<ReturnType<typeof tournamentsApi.audit>>,
    ApiError
  >({
    queryKey: ["tournament", id, "audit"],
    queryFn: () => tournamentsApi.audit(id),
    enabled: Boolean(id),
    retry: false,
  });

  // Non-manager access → friendly "managers only" empty state.
  const isForbidden = query.error instanceof ApiError && query.error.status === 403;

  const allRows: AuditEvent[] = React.useMemo(
    () => query.data?.results ?? [],
    [query.data],
  );

  const namespaceOptions = React.useMemo(() => {
    const set = new Set<string>();
    for (const ev of allRows) set.add(ev.event_type.split(".")[0]);
    return [
      { value: "all", label: t("All event types") },
      ...Array.from(set)
        .sort()
        .map((ns) => ({ value: ns, label: ns })),
    ];
  }, [allRows]);

  const rows = React.useMemo(
    () =>
      namespaceFilter === "all"
        ? allRows
        : allRows.filter(
            (ev) => ev.event_type.split(".")[0] === namespaceFilter,
          ),
    [allRows, namespaceFilter],
  );

  // Informative KPIs from the full feed (filters don't move them).
  const kpis = React.useMemo(() => {
    const today = new Date().toDateString();
    let todayCount = 0;
    const actors = new Set<string>();
    const types = new Map<string, number>();
    for (const ev of allRows) {
      if (new Date(ev.created_at).toDateString() === today) todayCount += 1;
      actors.add(ev.actor_email_at_time || "system");
      types.set(ev.event_type, (types.get(ev.event_type) ?? 0) + 1);
    }
    const top = [...types.entries()].sort((a, b) => b[1] - a[1])[0];
    return { todayCount, actors: actors.size, top };
  }, [allRows]);

  // 25 per page (owner 2026-07-05) with Prev/Next.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const paged = rows.slice(
    clampedPage * PAGE_SIZE,
    clampedPage * PAGE_SIZE + PAGE_SIZE,
  );
  const rangeStart = rows.length === 0 ? 0 : clampedPage * PAGE_SIZE + 1;
  const rangeEnd = Math.min(rows.length, (clampedPage + 1) * PAGE_SIZE);

  const showFilter = !query.isLoading && !query.isError && allRows.length > 0;

  if (isForbidden) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div
          className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-12 text-center shadow-sm"
          data-testid="audit-forbidden"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <ShieldAlert
              aria-hidden="true"
              className="h-6 w-6 text-muted-foreground"
            />
          </span>
          <h1 className="text-lg font-semibold">{t("Managers only")}</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("Only managers can view the audit log.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <BentoGrid className="flex w-full flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to={routes.tournamentSettings(id)}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Back to settings")}
      </Link>

      {/* ONE panel: toolbar, KPI strip, table, pager. */}
      <StarBorder>
      <section className="bento-card panel" aria-label={t("Audit log")}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <ScrollText aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />
          <h1 className="text-sm font-semibold">{t("Audit log")}</h1>
          <span className="flex items-baseline gap-1 pl-1" data-testid="audit-count">
            <span className="font-tabular text-base font-semibold leading-none">
              {query.isLoading ? "…" : allRows.length}
            </span>
            <span className="text-xs text-muted-foreground">
              {allRows.length === 1 ? t("event") : t("events")}
            </span>
          </span>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {t("Append-only record of state-changing actions.")}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {showFilter ? (
              <Select
                value={namespaceFilter}
                onChange={(v) => {
                  setNamespaceFilter(v);
                  setPage(0);
                }}
                options={namespaceOptions}
                aria-label={t("Filter by event type")}
                size="sm"
                className="w-44"
              />
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              className="gap-2"
            >
              <RefreshCw
                aria-hidden="true"
                className={cn("h-4 w-4", query.isFetching && "animate-spin")}
              />
              {query.isFetching ? t("Refreshing...") : t("Refresh")}
            </Button>
          </div>
        </div>

        {/* KPI strip — what actually happened, at a glance. */}
        {allRows.length > 0 ? (
          <section
            aria-label={t("Audit summary")}
            className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border px-3 py-2 text-xs text-muted-foreground"
          >
            <span className="inline-flex items-center gap-1.5">
              <Zap aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
              {t("Today")}
              <span className="font-tabular text-sm font-semibold text-foreground">
                {kpis.todayCount}
              </span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Users aria-hidden="true" className="h-3.5 w-3.5 text-primary" />
              {t("Actors")}
              <span className="font-tabular text-sm font-semibold text-foreground">
                {kpis.actors}
              </span>
            </span>
            {kpis.top ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {t("Most frequent")}
                <span className="truncate rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
                  {kpis.top[0]}
                </span>
                <span className="font-tabular text-sm font-semibold text-foreground">
                  {kpis.top[1]}
                </span>
              </span>
            ) : null}
          </section>
        ) : null}

        <div className="p-3">
          {query.isLoading ? (
            <div className="overflow-hidden rounded-xl border border-border">
              <div className="divide-y divide-border">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-4 px-4 py-3.5"
                    aria-hidden="true"
                  >
                    <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                    <div className="h-5 w-28 animate-pulse rounded-full bg-muted" />
                    <div className="ml-auto h-4 w-40 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            </div>
          ) : query.isError ? (
            <div
              role="alert"
              className="flex flex-col items-center gap-3 rounded-xl border border-border p-12 text-center"
            >
              <h2 className="text-lg font-semibold">
                {t("Could not load audit log")}
              </h2>
              <p className="max-w-md text-sm text-muted-foreground">
                {query.error?.payload.detail ?? t("Try refreshing the page.")}
              </p>
              <Button type="button" onClick={() => query.refetch()}>
                {t("Retry")}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <ScrollText
                  aria-hidden="true"
                  className="h-6 w-6 text-muted-foreground/60"
                />
              </span>
              <p className="text-sm text-muted-foreground">
                {allRows.length === 0
                  ? t("No audit events yet for this tournament.")
                  : t("No audit events match this filter.")}
              </p>
            </div>
          ) : (
            <>
              {isMobile ? (
                <ul className="flex flex-col gap-2" aria-label={t("Audit events")}>
                  {paged.map((ev) => {
                    const ts = formatTimestamp(ev.created_at);
                    return (
                      <li
                        key={ev.id}
                        className="rounded-xl border border-border bg-card p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <EventTypeBadge event_type={ev.event_type} />
                          <span className="shrink-0 text-right font-tabular text-xs text-muted-foreground">
                            {ts.date}
                            <br />
                            {ts.time}
                          </span>
                        </div>
                        <dl className="mt-3 space-y-1.5 text-sm">
                          <div className="flex items-baseline gap-2">
                            <dt className="w-14 shrink-0 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                              {t("Actor")}
                            </dt>
                            <dd className="min-w-0 flex-1 truncate">
                              <ActorLabel ev={ev} />
                            </dd>
                          </div>
                          <div className="flex items-baseline gap-2">
                            <dt className="w-14 shrink-0 text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                              {t("Target")}
                            </dt>
                            <dd className="min-w-0 flex-1 truncate text-foreground">
                              {ev.target_label ?? ev.target_type}
                            </dd>
                          </div>
                        </dl>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="overflow-hidden rounded-xl border border-border">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted text-left text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                          <th className="px-4 py-2.5 font-medium">{t("When")}</th>
                          <th className="px-4 py-2.5 font-medium">{t("Event")}</th>
                          <th className="px-4 py-2.5 font-medium">{t("Actor")}</th>
                          <th className="px-4 py-2.5 font-medium">{t("Target")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paged.map((ev) => {
                          const ts = formatTimestamp(ev.created_at);
                          return (
                            <tr
                              key={ev.id}
                              className="border-t border-border align-top transition-colors first:border-t-0 hover:bg-accent/40"
                            >
                              <td className="whitespace-nowrap px-4 py-3 font-tabular text-xs text-muted-foreground">
                                <span className="text-foreground">{ts.date}</span>
                                <span className="ml-2">{ts.time}</span>
                              </td>
                              <td className="px-4 py-3">
                                <EventTypeBadge event_type={ev.event_type} />
                              </td>
                              <td className="max-w-[16rem] px-4 py-3">
                                <ActorLabel ev={ev} />
                              </td>
                              <td className="max-w-[16rem] truncate px-4 py-3 text-foreground">
                                {ev.target_label ?? ev.target_type}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Pager — 25 per page. */}
              <div className="flex flex-wrap items-center gap-2 pt-3">
                <span className="font-tabular text-xs text-muted-foreground">
                  {rangeStart}-{rangeEnd} {t("of")} {rows.length}
                </span>
                <div className="ml-auto flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={clampedPage === 0}
                    onClick={() => setPage((n) => Math.max(0, n - 1))}
                    data-testid="audit-prev"
                  >
                    <ChevronLeft aria-hidden="true" className="h-4 w-4" />
                    {t("Prev")}
                  </Button>
                  <span className="font-tabular text-xs text-muted-foreground">
                    {clampedPage + 1} / {pageCount}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={clampedPage >= pageCount - 1}
                    onClick={() =>
                      setPage((n) => Math.min(pageCount - 1, n + 1))
                    }
                    data-testid="audit-next"
                  >
                    {t("Next")}
                    <ChevronRight aria-hidden="true" className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
      </StarBorder>
    </BentoGrid>
  );
}
