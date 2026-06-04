import * as React from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Palette } from "lucide-react";
import { api } from "@/api/client";
import { useAuthStore } from "@/features/auth/authStore";
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
 * v1Users.md ``ORG_BRANDING`` surface.
 *
 * Replaces the Phase 1A ``ComingSoonPage`` for ``/o/:orgSlug/branding``.
 *
 * The ``Organization`` backend model does NOT yet carry ``primary_color``
 * or ``logo`` columns (see ``backend/apps/organizations/models.py``).
 * Rather than ship a working form against missing fields (or add a
 * migration that's out of scope for this fix wave), the page renders a
 * read-only preview of the current org name/slug and a clearly labelled
 * "Phase 1B" notice for the editable controls. Permission gating still
 * applies so non-admins see the same "no permission" message used
 * elsewhere — that surface alone is a substantive improvement over the
 * previous "coming soon" placeholder.
 */

const REQUIRED_MODULE = "org.branding";

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

function NoPermissionCard(): React.ReactElement {
  return (
    <div className="flex flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Branding")}</CardTitle>
          <CardDescription>
            {t(
              "You don't have permission to edit this organization's branding.",
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
              "Ask an organization admin to enable the Branding module for your role.",
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
      data-testid="branding-skeleton"
    >
      <span className="sr-only">{t("Loading branding settings...")}</span>
      <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-10 w-full animate-pulse rounded-md bg-muted/70" />
    </div>
  );
}

export function OrgBrandingPage(): React.ReactElement {
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

  const orgQuery = useQuery({
    queryKey: ["org", orgSlug, "detail"],
    queryFn: () => api.get<OrgDetail>(`/api/orgs/${orgSlug}/`),
    enabled: Boolean(orgSlug) && canEdit,
  });

  if (!canEdit) {
    return <NoPermissionCard />;
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("Branding")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "Configure the public-facing appearance of your organization's pages.",
          )}
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("Identity preview")}</CardTitle>
          <CardDescription>
            {t(
              "How your organization currently appears across the platform.",
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
                {t("Failed to load branding details.")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => orgQuery.refetch()}
                data-testid="branding-retry"
              >
                {t("Retry")}
              </Button>
            </div>
          ) : (
            <div
              className="flex flex-col gap-4"
              data-testid="branding-preview"
            >
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="inline-flex h-12 w-12 items-center justify-center rounded-md bg-emerald-100 text-emerald-700"
                >
                  <Palette className="h-6 w-6" />
                </span>
                <div className="min-w-0">
                  <div
                    className="truncate text-base font-semibold"
                    data-testid="branding-name"
                  >
                    {orgQuery.data?.name ?? ""}
                  </div>
                  <div
                    className="truncate text-xs text-muted-foreground"
                    data-testid="branding-slug"
                  >
                    {orgQuery.data?.slug ?? ""}
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Brand assets")}</CardTitle>
          <CardDescription>
            {t(
              "Primary brand color and logo will be editable in Phase 1B; the controls below are previewed only.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset
            className="flex flex-col gap-4"
            disabled
            aria-describedby="branding-phase-note"
            data-testid="branding-fieldset"
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="brand-color">{t("Primary color")}</Label>
              <div className="flex items-center gap-3">
                <Input
                  id="brand-color"
                  type="text"
                  value="#10b981"
                  readOnly
                  className="font-mono text-xs"
                  data-testid="brand-color"
                />
                <span
                  aria-hidden="true"
                  className="inline-block h-8 w-8 rounded-md border bg-emerald-500"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="brand-logo">{t("Logo URL")}</Label>
              <Input
                id="brand-logo"
                type="url"
                placeholder="https://"
                readOnly
                value=""
                data-testid="brand-logo"
              />
            </div>
          </fieldset>
          <p
            id="branding-phase-note"
            data-testid="branding-phase-note"
            className="mt-3 rounded-md border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground"
          >
            {t(
              "Branding fields coming with Phase 1B. The Organization model does not yet store color or logo, so saves are disabled until that migration ships.",
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
