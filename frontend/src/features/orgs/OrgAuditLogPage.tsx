import * as React from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, RefreshCw, ScrollText, ShieldAlert } from "lucide-react";
import { auditApi, type AuditEvent } from "@/api/audit";
import { ApiError } from "@/types/api";
import { useAuthStore } from "@/features/auth/authStore";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/Select";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * v1Users.md Appendix A.2 module ``org.audit_log``.
 *
 * Replaces the Phase 1A ``ComingSoonPage`` for ``/o/:orgSlug/audit``. Backend
 * exposes a cursor-paginated, append-only feed at ``GET /api/audit/orgs/<slug>/``.
 * Permission is enforced server-side by ``IsOrgMember`` + module gate
 * ``org.audit_log``; referees see only their own match-scoped events
 * (server-side row scoping is a Phase 1B follow-up — Phase 1A returns the
 * whole org feed for any holder of the module).
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

// --- event-type namespace presentation (tokens only) ------------------------
// Map the leading namespace of an event_type (e.g. "tournament" in
// "tournament.published") to a token-based chip so the timeline scans fast.
function namespaceMeta(ns: string): { badge: string; dot: string } {
  const map: Record<string, { badge: string; dot: string }> = {
    tournament: { badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    match: { badge: "bg-primary/15 text-primary", dot: "bg-primary" },
    org: { badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    membership: { badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    user: { badge: "bg-secondary text-secondary-foreground", dot: "bg-primary" },
    grant: { badge: "bg-accent text-accent-foreground", dot: "bg-muted-foreground" },
    permission: { badge: "bg-accent text-accent-foreground", dot: "bg-muted-foreground" },
    dispute: { badge: "bg-destructive/15 text-destructive", dot: "bg-destructive" },
  };
  return map[ns] ?? { badge: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40" };
}

function EventTypeBadge({ event_type }: { event_type: string }): React.ReactElement {
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
    return <span className="truncate text-foreground">{ev.actor_email_at_time}</span>;
  }
  return <span className="text-muted-foreground">{t("System")}</span>;
}

export function OrgAuditLogPage(): React.ReactElement {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const slug = orgSlug ?? "";
  const user = useAuthStore((s) => s.user);
  const membership = user?.memberships.find((m) => m.org_slug === slug) ?? null;
  const hasModule = membership?.effective_modules?.includes("org.audit_log");
  const { isMobile } = useBreakpoint();

  const [cursor, setCursor] = React.useState<string | null>(null);
  const [namespaceFilter, setNamespaceFilter] = React.useState("all");

  const query = useQuery<Awaited<ReturnType<typeof auditApi.list>>, ApiError>({
    queryKey: ["audit", slug, cursor],
    queryFn: () =>
      auditApi.list(slug, cursor ? { cursor, limit: 50 } : { limit: 50 }),
    enabled: Boolean(slug && hasModule),
  });

  if (!hasModule) {
    return (
      <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-12 text-center shadow-sm">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <ShieldAlert aria-hidden="true" className="h-6 w-6 text-muted-foreground" />
          </span>
          <h1 className="text-lg font-semibold">{t("Access required")}</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("You don't have access to the audit log in this organization.")}
          </p>
        </div>
      </div>
    );
  }

  const allRows: AuditEvent[] = query.data?.results ?? [];
  const nextCursor = query.data?.next_cursor ?? null;
  const prevCursor = query.data?.previous_cursor ?? null;

  // Distinct namespaces present in the current page → filter options.
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
        : allRows.filter((ev) => ev.event_type.split(".")[0] === namespaceFilter),
    [allRows, namespaceFilter],
  );

  const showFilter = !query.isLoading && !query.isError && allRows.length > 0;

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("Compliance")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("Audit log")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Append-only record of state-changing actions in this organization.")}
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
            {query.isFetching ? t("Refreshing…") : t("Refresh")}
          </Button>
        </div>
      </div>

      {/* Body */}
      {query.isLoading ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="divide-y divide-border">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-3.5" aria-hidden="true">
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
          <h2 className="text-lg font-semibold">{t("Could not load audit log")}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {query.error.payload.detail ?? t("Try refreshing the page.")}
          </p>
          <Button type="button" onClick={() => query.refetch()}>
            {t("Retry")}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card p-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <ScrollText aria-hidden="true" className="h-6 w-6 text-muted-foreground/60" />
          </span>
          <p className="text-sm text-muted-foreground">
            {allRows.length === 0
              ? t("No audit events yet for this organization.")
              : t("No audit events match this filter.")}
          </p>
        </div>
      ) : isMobile ? (
        // --- stacked cards on small screens -----------------------------------
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
        // --- timeline table on desktop ----------------------------------------
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

      {/* Pager */}
      {(prevCursor || nextCursor) && !query.isLoading && !query.isError ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!prevCursor}
            onClick={() => setCursor(prevCursor ?? null)}
            className="gap-1.5"
          >
            <ChevronLeft aria-hidden="true" className="h-4 w-4" />
            {t("Previous")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!nextCursor}
            onClick={() => setCursor(nextCursor ?? null)}
            className="gap-1.5"
          >
            {t("Next")}
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
