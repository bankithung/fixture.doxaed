import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
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
import { useToast } from "@/components/ui/toast";
import { useAuthStore } from "@/features/auth/authStore";
import { authApi } from "@/api/auth";
import { ApiError } from "@/types/api";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * `/me` — authenticated profile page.
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

  if (!user) {
    return (
      <div className="p-6 text-sm text-muted-foreground" role="status">
        {t("Loading profile...")}
      </div>
    );
  }

  const memberships = user.memberships ?? [];

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex items-center gap-4">
        <div
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-lg font-semibold text-secondary-foreground"
          data-testid="profile-avatar"
        >
          {initials}
        </div>
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold leading-tight">
            {user.name || t("(no name set)")}
          </h1>
          <p className="text-sm text-muted-foreground">{user.email}</p>
        </div>
        {!editing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setEditing(true)}
          >
            {t("Edit profile")}
          </Button>
        ) : null}
      </header>

      {/* Account section */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Account")}</CardTitle>
          <CardDescription>
            {t("Personal details and two-factor status.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
            <p className="text-xs text-muted-foreground">
              {user.email_verified_at !== null
                ? t("Email verified.")
                : t("Email not yet verified.")}
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
          <div className="flex items-center justify-between gap-4">
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
                className="rounded-full bg-grant-muted px-3 py-1 text-xs font-medium"
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
        </CardContent>
      </Card>

      {/* Memberships section */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Memberships")}</CardTitle>
          <CardDescription>
            {t("Organizations you belong to and the roles you hold there.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {memberships.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("You are not a member of any organization yet.")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="membership-list">
              {memberships.map((m) => (
                <li
                  key={m.org_id}
                  className="flex items-center justify-between rounded-md border bg-card px-3 py-2"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{m.org_name}</span>
                    <span className="text-xs text-muted-foreground">
                      {(m.roles ?? []).join(", ") || t("(no roles)")}
                    </span>
                  </div>
                  <Link
                    to={routes.orgDashboard(m.org_slug)}
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    aria-label={`${t("Switch to")} ${m.org_name}`}
                  >
                    {t("Switch")}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Security section */}
      <Card>
        <CardHeader>
          <CardTitle>{t("Security")}</CardTitle>
          <CardDescription>
            {t("Reset your password or sign out of every device.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div>
            <Link
              to={routes.passwordResetRequest()}
              className="text-sm text-primary underline-offset-4 hover:underline"
            >
              {t("Change password")}
            </Link>
            <p className="text-xs text-muted-foreground">
              {t(
                "We will email you a one-time link to set a new password.",
              )}
            </p>
          </div>
          <div>
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
              {t(
                "Ends every session you have, including this one. You will need to sign in again.",
              )}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
