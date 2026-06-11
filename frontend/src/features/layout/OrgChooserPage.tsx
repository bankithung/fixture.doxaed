import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronRight, Mail, Plus, Trophy } from "lucide-react";
import { useAuthStore } from "@/features/auth/authStore";
import { tournamentsApi } from "@/api/tournaments";
import { invitationsApi } from "@/api/invitations";
import { RoleBadge } from "@/components/ui/RoleBadge";
import {
  Monogram,
  StatusPill,
} from "@/features/tournaments/TournamentsListPage";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * The workspace Dashboard (the sidebar's "Dashboard" link when no org is
 * active). Shows everything the user is part of — tournaments they own OR were
 * invited into, org workspaces they admin, and a pending-invites callout — so
 * a freshly-invited user lands on something real, not a dead end. With nothing
 * to show, a single welcome CTA centered both vertically and horizontally.
 */
export function OrgChooserPage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);

  const tournamentsQuery = useQuery({
    queryKey: ["tournaments"],
    queryFn: () => tournamentsApi.list(),
  });
  const invitesQuery = useQuery({
    queryKey: ["my-invitations"],
    queryFn: invitationsApi.myInvitations,
  });

  if (!user) return <div />;

  const memberships = user.memberships;
  const tournaments = tournamentsQuery.data ?? [];
  const pendingInvites = (invitesQuery.data ?? []).filter(
    (inv) => inv.status === "pending",
  );
  const loading = tournamentsQuery.isLoading || invitesQuery.isLoading;

  const startCta = (label: string): React.ReactElement => (
    <Link
      to={routes.tournamentNew()}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Plus aria-hidden="true" className="h-4 w-4" />
      {label}
    </Link>
  );

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <div
          className="h-56 animate-pulse rounded-xl border border-border bg-card"
          data-testid="dashboard-skeleton"
        />
      </div>
    );
  }

  // Nothing at all yet → one welcoming CTA, centered in the viewport.
  if (
    memberships.length === 0 &&
    tournaments.length === 0 &&
    pendingInvites.length === 0
  ) {
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
                "You haven't started any tournaments yet. Create one to open your workspace.",
              )}
            </p>
          </div>
          {startCta(t("Start your first tournament"))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {t("Dashboard")}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(`Welcome back, ${user.name || user.email}.`)}
          </p>
        </div>
        {startCta(t("Start a tournament"))}
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
                {t("Accept to join the tournaments you've been invited to.")}
              </p>
            </div>
          </div>
          <ChevronRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground/50"
          />
        </Link>
      ) : null}

      {tournaments.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label={t("Your tournaments")}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("Your tournaments")}</h2>
            <Link
              to={routes.tournaments()}
              className="text-xs font-medium text-primary hover:underline"
            >
              {t("View all")}
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            {tournaments.map((tn) => (
              <Link
                key={tn.id}
                to={routes.tournamentDetail(tn.id)}
                data-testid={`dashboard-tournament-${tn.id}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5 shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Monogram name={tn.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{tn.name}</span>
                    <StatusPill status={tn.status} />
                    {tn.origin === "owner" ? (
                      <RoleBadge role="owner" />
                    ) : (
                      (tn.my_roles ?? []).map((role) => (
                        <RoleBadge key={role} role={role} />
                      ))
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-tabular text-xs text-muted-foreground">
                    {tn.slug}
                  </div>
                </div>
                <ChevronRight
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-muted-foreground/50"
                />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {memberships.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label={t("Workspaces")}>
          <h2 className="text-sm font-semibold">{t("Workspaces")}</h2>
          <div className="flex flex-col gap-2">
            {memberships.map((m) => (
              <Link
                key={m.org_id}
                to={routes.orgDashboard(m.org_slug)}
                className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5 shadow-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
                  <Building2
                    aria-hidden="true"
                    className="h-4 w-4 text-muted-foreground"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{m.org_name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {m.roles.join(", ")} · /o/{m.org_slug}
                  </div>
                </div>
                <ChevronRight
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-muted-foreground/50"
                />
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
