import * as React from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api } from "@/api/client";
import { ApiError } from "@/types/api";
import { useAuthStore } from "@/features/auth/authStore";
import { useToast } from "@/components/ui/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/lib/t";

/**
 * v1Users.md ``ORG_SETTINGS`` surface.
 *
 * Replaces the Phase 1A ``ComingSoonPage`` for ``/o/:orgSlug/settings``.
 * Admins / co-organizers / game-coordinators (the admin-tier roles) and
 * org owners can edit ``name`` and ``time_zone`` here. ``slug`` is
 * displayed read-only — slug changes go through a dedicated colon-verb
 * endpoint (``POST /api/orgs/{uuid}:change_slug/``) that emits redirects
 * and is intentionally not exposed in this form.
 *
 * Endpoints:
 *   GET   ``/api/orgs/{slug}/``    → ``OrganizationSerializer`` payload.
 *   PATCH ``/api/orgs/{uuid}/``    → ``OrganizationUpdateSerializer``
 *                                    (the backend rejects PATCH-by-slug).
 */

const REQUIRED_MODULE = "org.settings";

interface OrgDetail {
  id: string;
  slug: string;
  name: string;
  status: string;
  time_zone?: string;
  created_at: string;
  archived_at: string | null;
  suspended_at: string | null;
  suspended_reason: string;
}

const schema = z.object({
  name: z
    .string()
    .min(1, t("Organization name is required"))
    .max(200, t("Name must be 200 characters or fewer")),
  time_zone: z
    .string()
    .min(1, t("Pick a time zone")),
});
type FormValues = z.infer<typeof schema>;

/** A small curated TZ list. The backend validates against the full IANA
 * set, so unknown values still 400 cleanly; this list is just an
 * affordance for the dropdown. ``Asia/Kolkata`` is the project default
 * (PRD §14 + ``Organization.time_zone`` default). */
const TIMEZONE_OPTIONS: ReadonlyArray<string> = [
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Dubai",
  "Australia/Sydney",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Africa/Johannesburg",
  "UTC",
];

function NoPermissionCard(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Org settings")}</CardTitle>
          <CardDescription>
            {t(
              "You don't have permission to edit this organization's settings.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p
            role="status"
            data-testid="no-permission"
            className="text-sm text-muted-foreground"
          >
            {t(
              "Ask an organization admin to enable the Org settings module for your role.",
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-4"
      data-testid="settings-skeleton"
    >
      <span className="sr-only">{t("Loading organization settings...")}</span>
      <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-10 w-full animate-pulse rounded-md bg-muted/70" />
    </div>
  );
}

export function OrgSettingsPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  const user = useAuthStore((s) => s.user);
  const membership = user?.memberships.find((m) => m.org_slug === orgSlug);
  const effectiveModules = React.useMemo(
    () => new Set(membership?.effective_modules ?? []),
    [membership],
  );

  const isAdminish = (membership?.roles ?? []).some(
    (r): boolean =>
      r === "admin" ||
      r === "co_organizer" ||
      r === "game_coordinator" ||
      // Legacy "owner" string still appears in older MembershipSummary
      // payloads and in some test fixtures; widen the check defensively.
      (r as string) === "owner",
  );
  const isOrgOwner = Boolean(membership?.is_org_owner);
  const canEdit =
    isOrgOwner || isAdminish || effectiveModules.has(REQUIRED_MODULE);

  const qc = useQueryClient();
  const toast = useToast();

  const orgQuery = useQuery({
    queryKey: ["org", orgSlug, "detail"],
    queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),
    enabled: Boolean(orgSlug) && canEdit,
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", time_zone: "Asia/Kolkata" },
  });

  // Hydrate form when the org payload arrives.
  React.useEffect(() => {
    if (orgQuery.data) {
      form.reset({
        name: orgQuery.data.name,
        time_zone: orgQuery.data.time_zone ?? "Asia/Kolkata",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgQuery.data?.id]);

  const update = useMutation({
    mutationFn: (values: FormValues) => {
      if (!orgQuery.data) {
        return Promise.reject(new Error("missing_org"));
      }
      // Backend requires UUID for PATCH (not slug).
      return api.patch<OrgDetail>(
        `/api/orgs/${orgQuery.data.id}/`,
        values,
      );
    },
    onSuccess: (next) => {
      toast.push({
        kind: "success",
        title: t("Organization settings saved"),
      });
      qc.setQueryData(["org", orgSlug, "detail"], next);
    },
    onError: (e) => {
      toast.push({
        kind: "error",
        title:
          e instanceof ApiError
            ? (e.payload.detail ?? t("Could not save settings"))
            : t("Could not save settings"),
      });
    },
  });

  if (!canEdit) {
    return <NoPermissionCard />;
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("Org settings")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Edit organization name, time zone, and other core settings.",
          )}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("General")}</CardTitle>
          <CardDescription>
            {t(
              "These values appear across the platform and on public pages.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {orgQuery.isLoading ? (
            <LoadingSkeleton />
          ) : orgQuery.isError ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
            >
              <p className="font-medium text-destructive">
                {t("Failed to load organization settings.")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => orgQuery.refetch()}
                data-testid="settings-retry"
              >
                {t("Retry")}
              </Button>
            </div>
          ) : (
            <form
              onSubmit={form.handleSubmit((values) => update.mutate(values))}
              className="flex flex-col gap-4"
              noValidate
              data-testid="settings-form"
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-name">{t("Organization name")}</Label>
                <Input
                  id="org-name"
                  autoComplete="organization"
                  aria-invalid={Boolean(form.formState.errors.name)}
                  data-testid="settings-name"
                  {...form.register("name")}
                />
                {form.formState.errors.name ? (
                  <p
                    role="alert"
                    data-testid="name-error"
                    className="text-xs text-destructive"
                  >
                    {form.formState.errors.name.message}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-slug">{t("URL slug")}</Label>
                <Input
                  id="org-slug"
                  readOnly
                  value={orgQuery.data?.slug ?? ""}
                  data-testid="settings-slug"
                  aria-describedby="slug-hint"
                />
                <p
                  id="slug-hint"
                  className="text-xs text-muted-foreground"
                >
                  {t(
                    "Slugs are immutable here. Contact a super-admin to rename an organization.",
                  )}
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="org-tz">{t("Time zone")}</Label>
                <select
                  id="org-tz"
                  data-testid="settings-tz"
                  aria-invalid={Boolean(form.formState.errors.time_zone)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  {...form.register("time_zone")}
                >
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Used for default tournament scheduling. Personal viewer time zones still render local times.",
                  )}
                </p>
                {form.formState.errors.time_zone ? (
                  <p
                    role="alert"
                    data-testid="tz-error"
                    className="text-xs text-destructive"
                  >
                    {form.formState.errors.time_zone.message}
                  </p>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="submit"
                  disabled={update.isPending || !form.formState.isDirty}
                  data-testid="settings-submit"
                >
                  {update.isPending ? t("Saving...") : t("Save changes")}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
