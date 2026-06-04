import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { authApi } from "@/api/auth";
import { ApiError } from "@/types/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

export function VerifyEmailPage(): React.ReactElement {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<"idle" | "loading" | "ok" | "error">(
    token ? "loading" : "idle",
  );
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        await authApi.verifyEmail(token);
        if (!cancelled) setState("ok");
      } catch (e) {
        if (cancelled) return;
        setState("error");
        setMessage(
          e instanceof ApiError
            ? (e.payload.detail ?? t("Verification failed"))
            : t("Verification failed"),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("Verify your email")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {state === "idle" ? (
            <p className="text-sm text-muted-foreground">
              {t(
                "Check your inbox for a verification link. Click it to activate your account.",
              )}
            </p>
          ) : null}
          {state === "loading" ? (
            <p role="status" className="text-sm">
              {t("Verifying...")}
            </p>
          ) : null}
          {state === "ok" ? (
            <>
              <p role="status" className="text-sm text-grant">
                {t("Email verified. You can now sign in.")}
              </p>
              <Link
                to={routes.login()}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t("Continue to sign in")}
              </Link>
            </>
          ) : null}
          {state === "error" ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
