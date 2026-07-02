import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

const schema = z.object({
  name: z.string().optional(),
  password: z.string().min(12, t("Password must be at least 12 characters")),
});
type FormValues = z.infer<typeof schema>;

type State =
  | "idle"
  | "loading"
  | "ok"
  | "error"
  | "login_required"
  | "email_mismatch";

/**
 * Invite-accept landing. AllowAny: a logged-out, brand-new invitee can create
 * their account inline (email is bound to the invite server-side). An existing
 * active account is asked to sign in. On success we go to the tournaments hub
 * (works whether the invitee has org access or only a tournament membership).
 */
export function InviteAcceptPage(): React.ReactElement {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const refreshMe = useAuthStore((s) => s.refreshMe);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState<{
    invited: string;
    current: string;
  } | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", password: "" },
  });

  useEffect(() => {
    if (!token) {
      setState("error");
      setError(t("Missing invitation token."));
    }
  }, [token]);

  const finishAccept = async (opts?: {
    password?: string;
    name?: string;
  }): Promise<void> => {
    setState("loading");
    setError(null);
    try {
      await orgsApi.acceptInvitation(token, opts);
      await refreshMe();
      setState("ok");
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 401 &&
        e.payload.detail === "login_required"
      ) {
        setState("login_required");
        return;
      }
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        e.payload.detail === "email_mismatch"
      ) {
        const invited =
          typeof e.payload.invited_email === "string"
            ? e.payload.invited_email
            : "";
        const current =
          typeof e.payload.current_email === "string"
            ? e.payload.current_email
            : (user?.email ?? "");
        setMismatch({ invited, current });
        setState("email_mismatch");
        return;
      }
      setState("error");
      setError(
        e instanceof ApiError
          ? (e.payload.detail ?? t("Could not accept invitation"))
          : t("Could not accept invitation"),
      );
    }
  };

  const signInHref = `${routes.login()}?next=${encodeURIComponent(routes.inviteAccept(token))}`;

  const handleSwitchAccount = async (): Promise<void> => {
    await logout();
    await refreshMe();
    navigate(signInHref);
  };

  if (state === "email_mismatch" && mismatch) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t("Wrong account")}</CardTitle>
            <CardDescription>
              {t("This invitation is for a different account.")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {t(
                `Sent to ${mismatch.invited}. You're signed in as ${mismatch.current}. Switch accounts to accept.`,
              )}
            </p>
            <Button onClick={handleSwitchAccount}>
              {t("Sign out & switch account")}
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate(routes.tournaments())}
            >
              {t("Cancel")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (state === "ok") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{t("You're in.")}</CardTitle>
            <CardDescription>{t("Invitation accepted.")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate(routes.tournaments())}>
              {t("Go to your tournaments")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("Accept invitation")}</CardTitle>
          <CardDescription>
            {user
              ? t("Accept to join this tournament.")
              : t("Create an account to join, or sign in.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {user ? (
            <Button
              onClick={() => finishAccept()}
              disabled={!token || state === "loading"}
            >
              {state === "loading" ? t("Accepting...") : t("Accept invite")}
            </Button>
          ) : state === "login_required" ? (
            <>
              <p className="text-sm text-muted-foreground">
                {t("You already have an account. Sign in to accept.")}
              </p>
              <Link
                to={signInHref}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-white hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t("Sign in to continue")}
              </Link>
            </>
          ) : (
            <form
              onSubmit={form.handleSubmit((v) =>
                finishAccept({ password: v.password, name: v.name }),
              )}
              className="flex flex-col gap-3"
              noValidate
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">
                  {t("Your name")}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    {t("(optional)")}
                  </span>
                </Label>
                <Input id="name" autoComplete="name" {...form.register("name")} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">{t("Create a password")}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={!!form.formState.errors.password}
                  {...form.register("password")}
                />
                {form.formState.errors.password ? (
                  <p role="alert" className="text-xs text-destructive">
                    {form.formState.errors.password.message}
                  </p>
                ) : null}
              </div>
              <Button type="submit" disabled={!token || state === "loading"}>
                {state === "loading" ? t("Joining...") : t("Create account & join")}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                {t("Already have an account?")}{" "}
                <Link
                  to={signInHref}
                  className="font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {t("Sign in")}
                </Link>
              </p>
            </form>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
