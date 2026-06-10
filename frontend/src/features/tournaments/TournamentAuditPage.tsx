import * as React from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw, ScrollText, ShieldAlert } from "lucide-react";
import { tournamentsApi } from "@/api/tournaments";
import type { AuditEvent } from "@/api/audit";
import { ApiError } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import { useBreakpoint } from "@/lib/useBreakpoint";
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

export function TournamentAuditPage(): React.ReactElement {
  const { id = "" } = useParams<{ id: string }>();
  const { isMobile } = useBreakpoint();
  const [namespaceFilter, setNamespaceFilter] = React.useState("all");

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
            {t("Only tournament managers can view the audit log.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <Link
        to={routes.tournamentOverview(id)}
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
        {t("Back to tournament")}
      </Link>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("Tournament")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("Audit log")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Append-only record of state-changing actions in this tournament.")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showFilter ? (
            <Select
              value={namespaceFilter}
              onChange={(v) => setNamespaceFilter(v)}
              options={namespaceOptions}
              aria-label={t("Filter by event type")}
              className="w-44"
            />
          ) : null}
          <Button
            type="button"
            variant="outline"
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

      {/* Body */}
      {query.isLoading ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
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
          className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-12 text-center shadow-sm"
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
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card p-12 text-center">
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
      ) : isMobile ? (
        <ul className="flex flex-col gap-2" aria-label={t("Audit events")}>
          {rows.map((ev) => {
            const ts = formatTimestamp(ev.created_at);
            return (
              <li
                key={ev.id}
                className="rounded-xl border border-border bg-card p-4 shadow-sm"
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
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">{t("When")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("Event")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("Actor")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("Target")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ev) => {
                  const ts = formatTimestamp(ev.created_at);
                  return (
                    <tr
                      key={ev.id}
                      className="border-t border-border align-top transition-colors hover:bg-accent/40"
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
    </div>
  );
}
