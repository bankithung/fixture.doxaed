import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { orgsApi } from "@/api/orgs";
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
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * v1Users.md §2.13 invite-accept landing. Backend cycles the session on
 * accept (B.11), so we re-bootstrap the auth store before redirecting.
 */
export function InviteAcceptPage(): React.ReactElement {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const refreshMe = useAuthStore((s) => s.refreshMe);
  const user = useAuthStore((s) => s.user);

  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">(
    "idle",
  );
  const [orgSlug, setOrgSlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState("error");
      setError(t("Missing invitation token."));
    }
  }, [token]);

  const onAccept = async (): Promise<void> => {
    setState("loading");
    setError(null);
    try {
      const res = await orgsApi.acceptInvitation(token);
      setOrgSlug(res.org_slug);
      // Backend cycles the session — refresh local user state.
      await refreshMe();
      setState("ok");
    } catch (e) {
      setState("error");
      setError(
        e instanceof ApiError
          ? (e.payload.detail ?? t("Could not accept invitation"))
          : t("Could not accept invitation"),
      );
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("Accept invitation")}</CardTitle>
          <CardDescription>
            {user
              ? t(
                  "Joining a new organization will switch your active session to it.",
                )
              : t("Sign in first to accept this invitation.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!user ? (
            <Link
              to={`${routes.login()}?next=${encodeURIComponent(`/accept?token=${token}`)}`}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("Sign in to continue")}
            </Link>
          ) : state === "ok" && orgSlug ? (
            <>
              <p role="status" className="text-sm text-grant">
                {t("You're now a member.")}
              </p>
              <Button onClick={() => navigate(routes.orgDashboard(orgSlug))}>
                {t("Go to organization")}
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={onAccept}
                disabled={!token || state === "loading"}
              >
                {state === "loading" ? t("Accepting...") : t("Accept invite")}
              </Button>
              {error ? (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
