import * as React from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { auditApi, type AuditEvent } from "@/api/audit";
import { ApiError } from "@/types/api";
import { useAuthStore } from "@/features/auth/authStore";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function ActorCell({ ev }: { ev: AuditEvent }): React.ReactElement {
  if (ev.actor_email_at_time) {
    return <span className="font-mono text-xs">{ev.actor_email_at_time}</span>;
  }
  return <span className="text-xs text-muted-foreground">{t("system")}</span>;
}

function EventTypeBadge({
  event_type,
}: {
  event_type: string;
}): React.ReactElement {
  const [namespace] = event_type.split(".");
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded bg-muted px-2 py-0.5 font-mono text-[11px]"
      title={event_type}
    >
      <span className="text-muted-foreground">{namespace}</span>
      <span>·</span>
      <span>{event_type.slice(namespace.length + 1)}</span>
    </span>
  );
}

export function OrgAuditLogPage(): React.ReactElement {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const slug = orgSlug ?? "";
  const user = useAuthStore((s) => s.user);
  const membership = user?.memberships.find((m) => m.org_slug === slug) ?? null;
  const hasModule = membership?.effective_modules?.includes("org.audit_log");

  const [cursor, setCursor] = React.useState<string | null>(null);

  const query = useQuery<
    Awaited<ReturnType<typeof auditApi.list>>,
    ApiError
  >({
    queryKey: ["audit", slug, cursor],
    queryFn: () => auditApi.list(slug, cursor ? { cursor, limit: 50 } : { limit: 50 }),
    enabled: Boolean(slug && hasModule),
  });

  if (!hasModule) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("Access required")}</CardTitle>
            <CardDescription>
              {t("You don't have access to the audit log in this organization.")}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const rows: AuditEvent[] = query.data?.results ?? [];
  const nextCursor = query.data?.next_cursor ?? null;
  const prevCursor = query.data?.previous_cursor ?? null;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("Audit log")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("Append-only record of state-changing actions in this organization.")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
        >
          {query.isFetching ? t("Refreshing…") : t("Refresh")}
        </Button>
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-md bg-muted/40"
              aria-hidden="true"
            />
          ))}
        </div>
      ) : query.isError ? (
        <Card role="alert">
          <CardHeader>
            <CardTitle>{t("Could not load audit log")}</CardTitle>
            <CardDescription>
              {query.error.payload.detail ?? t("Try refreshing the page.")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => query.refetch()}>{t("Retry")}</Button>
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t("No audit events yet for this organization.")}
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t("When")}</th>
                <th className="px-3 py-2 font-medium">{t("Event")}</th>
                <th className="px-3 py-2 font-medium">{t("Actor")}</th>
                <th className="px-3 py-2 font-medium">{t("Target")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((ev) => (
                <tr key={ev.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                    {formatTimestamp(ev.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <EventTypeBadge event_type={ev.event_type} />
                  </td>
                  <td className="px-3 py-2">
                    <ActorCell ev={ev} />
                  </td>
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">
                      {ev.target_label ?? ev.target_type}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(prevCursor || nextCursor) && !query.isLoading && !query.isError ? (
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!prevCursor}
            onClick={() => setCursor(prevCursor ?? null)}
          >
            {t("Previous")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!nextCursor}
            onClick={() => setCursor(nextCursor ?? null)}
          >
            {t("Next")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
