import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CreditCard,
  KeyRound,
  ShieldCheck,
  Trophy,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { BentoCard, BentoGrid } from "@/features/dashboard/BentoCard";
import { Monogram, StatusPill } from "@/features/tournaments/TournamentsListPage";
import { useAuthStore } from "@/features/auth/authStore";
import { authApi } from "@/api/auth";
import { tournamentsApi } from "@/api/tournaments";
import { invitationsApi } from "@/api/invitations";
import { ApiError } from "@/types/api";
import { qk } from "@/lib/queryKeys";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * `/me` — authenticated profile page, on the app's bento language: full
 * width, panel chrome, staggered card entrances under the shared spotlight.
 *
 * Sections:
 *   - Account: avatar (initials only — Phase 1A doesn't ship uploads),
 *     email (read-only), name (editable via PATCH /me/), 2FA status
 *     (link to /2fa/enroll if not enabled, else display state).
 *   - Memberships: list of orgs + roles with deep links to that org's
 *     dashboard (the org switcher pattern: navigating updates URL slug).
 *   - Security: change-password link, "Sign out everywhere" button which
 *     calls the existing logout endpoint and routes to /login.
 *
 * 2FA enrolment lives at `/2fa/enroll` (separate page); this page only
 * surfaces the status + the link. Avatar upload and account deletion are
 * out of scope per the role-landing spec.
 */
export function MyProfilePage(): React.ReactElement {
  const user = useAuthStore((s) => s.user);
  const refreshMe = useAuthStore((s) => s.refreshMe);
  const logout = useAuthStore((s) => s.logout);
  const toast = useToast();
  const navigate = useNavigate();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user?.name ?? "");

  // Keep the local edit buffer in sync with store updates.
  useEffect(() => {
    if (!editing) setName(user?.name ?? "");
  }, [user?.name, editing]);

  const initials = useMemo(() => {
    const src = user?.name?.trim() || user?.email?.trim() || "";
    if (!src) return "?";
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }, [user?.name, user?.email]);

  const saveName = useMutation({
    mutationFn: (newName: string) => authApi.patchMe({ name: newName }),
    onSuccess: async () => {
      await refreshMe();
      setEditing(false);
      toast.push({ kind: "success", title: t("Profile updated") });
    },
    onError: (e) => {
      toast.push({
        kind: "error",
        title: t("Could not save profile"),
        description:
          e instanceof ApiError
            ? (e.payload.detail ?? e.message)
            : e instanceof Error
              ? e.message
              : t("Network error"),
      });
    },
  });

  const onSignOutEverywhere = async (): Promise<void> => {
    try {
      await logout();
    } finally {
      // logout() clears local auth state regardless of server status.
      navigate(routes.login(), { replace: true });
    }
  };

  const tournamentsQuery = useQuery({
    queryKey: qk.tournaments(),
    queryFn: () => tournamentsApi.list(),
    enabled: !!user,
  });
  const invitesQuery = useQuery({
    queryKey: ["my-invitations"],
    queryFn: invitationsApi.myInvitations,
    enabled: !!user,
  });

  if (!user) {
    return (
      <div className="p-6 text-sm text-muted-foreground" role="status">
        {t("Loading profile...")}
      </div>
    );
  }

  const tournaments = tournamentsQuery.data ?? [];
  const pendingInvites = (invitesQuery.data ?? []).filter(
    (i) => i.status === "pending" && i.tournament_id,
  );

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
      <header className="flex items-center gap-4">
        <div
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-lg font-semibold text-primary"
          data-testid="profile-avatar"
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1 flex-col">
          <h1 className="page-title truncate">
            {user.name || t("(no name set)")}
          </h1>
          <p className="truncate text-sm text-muted-foreground">{user.email}</p>
        </div>
        {!editing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => setEditing(true)}
          >
            {t("Edit profile")}
          </Button>
        ) : null}
      </header>

      <BentoGrid className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {/* Account */}
        <BentoCard className="animate-fade-up lg:col-span-2">
          <div className="panel-header gap-2">
            <UserRound aria-hidden="true" className="h-4 w-4 text-primary" />
            <h2 className="panel-title">{t("Account")}</h2>
            <span className="text-xs text-muted-foreground">
              {t("Personal details and two-factor status.")}
            </span>
          </div>
          <div className="flex flex-col gap-4 p-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="profile-email">{t("Email")}</Label>
              <Input
                id="profile-email"
                type="email"
                value={user.email}
                readOnly
                aria-readonly="true"
                className="max-w-md"
              />
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                {user.email_verified_at !== null ? (
                  <>
                    <ShieldCheck
                      aria-hidden="true"
                      className="h-3.5 w-3.5 text-success"
                    />
                    {t("Email verified.")}
                  </>
                ) : (
                  t("Email not yet verified.")
                )}
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="profile-name">{t("Full name")}</Label>
              <div className="flex max-w-md items-center gap-2">
                <Input
                  id="profile-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!editing || saveName.isPending}
                  aria-disabled={!editing || saveName.isPending}
                />
                {editing ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => saveName.mutate(name.trim())}
                      disabled={
                        saveName.isPending || name.trim() === user.name
                      }
                    >
                      {saveName.isPending ? t("Saving...") : t("Save")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        setName(user.name ?? "");
                      }}
                      disabled={saveName.isPending}
                    >
                      {t("Cancel")}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-background px-3 py-2.5">
              <div>
                <div className="text-sm font-medium">
                  {t("Two-factor authentication")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {user.has_2fa_enrolled
                    ? t("2FA is enabled on this account.")
                    : t("Add an authenticator app to protect your account.")}
                </div>
              </div>
              {user.has_2fa_enrolled ? (
                <span
                  data-testid="2fa-status"
                  className="rounded-full bg-success-muted px-3 py-1 text-xs font-medium text-success"
                >
                  {t("Enabled")}
                </span>
              ) : (
                <Link
                  to={routes.twoFactorEnroll()}
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent"
                >
                  {t("Enable 2FA")}
                </Link>
              )}
            </div>
          </div>
        </BentoCard>

        {/* Security */}
        <BentoCard className="animate-fade-up" style={{ animationDelay: "60ms" }}>
          <div className="panel-header gap-2">
            <KeyRound aria-hidden="true" className="h-4 w-4 text-primary" />
            <h2 className="panel-title">{t("Security")}</h2>
          </div>
          <div className="flex flex-col gap-4 p-4">
            <div>
              <Link
                to={routes.passwordResetRequest()}
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("Change password")}
              </Link>
              <p className="text-xs text-muted-foreground">
                {t("We'll email a one-time reset link.")}
              </p>
            </div>
            <div className="border-t border-border pt-4">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => void onSignOutEverywhere()}
                data-testid="sign-out-everywhere"
              >
                {t("Sign out everywhere")}
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Ends all sessions, including this one. You'll sign in again.")}
              </p>
            </div>
          </div>
        </BentoCard>

        {/* Billing (memberships hidden: orgs are an implementation detail,
            owner 2026-07-04; no paid plans yet, so this states the truth). */}
        <BentoCard
          className="animate-fade-up"
          style={{ animationDelay: "120ms" }}
          testId="billing-card"
        >
          <div className="panel-header gap-2">
            <CreditCard aria-hidden="true" className="h-4 w-4 text-primary" />
            <h2 className="panel-title">{t("Billing")}</h2>
          </div>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium">{t("Plan")}</p>
              <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
                {t("Early access")}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("All features included. Nothing to pay today.")}
            </p>
            <div className="border-t border-border pt-3">
              <p className="text-sm font-medium">{t("Billing email")}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>
        </BentoCard>

        {/* Tournaments + invitations — so members find what they're part of. */}
        <BentoCard
          className="animate-fade-up lg:col-span-2"
          style={{ animationDelay: "180ms" }}
        >
          <div className="panel-header gap-2">
            <Trophy aria-hidden="true" className="h-4 w-4 text-primary" />
            <h2 className="panel-title">{t("Your tournaments")}</h2>
            <span className="text-xs text-muted-foreground">
              {t("Tournaments you're part of, plus pending invitations.")}
            </span>
          </div>
          <div className="flex flex-col gap-4 p-4">
            {pendingInvites.length ? (
              <div className="flex flex-col gap-2">
                <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                  {t("Pending invitations")}
                </p>
                {pendingInvites.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <span className="truncate font-medium">{inv.tournament_name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t("invited as")} {t(inv.role.replace(/_/g, " "))}
                      </span>
                    </div>
                    <Link
                      to={routes.invites()}
                      className="shrink-0 text-sm font-medium text-primary hover:underline"
                    >
                      {t("Review")}
                    </Link>
                  </div>
                ))}
              </div>
            ) : null}

            {tournaments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("You're not part of any tournament yet.")}
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {tournaments.map((tn) => (
                  <li key={tn.id}>
                    <Link
                      to={routes.tournamentDetail(tn.id)}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background px-3 py-2 transition-colors hover:border-primary/40 hover:bg-accent/30"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Monogram name={tn.name} />
                        <span className="truncate text-sm font-medium">{tn.name}</span>
                      </span>
                      <StatusPill status={tn.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </BentoCard>
      </BentoGrid>
    </div>
  );
}
