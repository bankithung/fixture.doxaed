import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { useAuthStore } from "./authStore";
import { AuthLayout } from "./AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Label } from "@/components/ui/label";
import { authApi } from "@/api/auth";
import { ApiError } from "@/types/api";
import { pickLandingPathForUser } from "@/features/roles/redirectByRole";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/** Map backend error codes to friendly, human messages. */
function friendlyAuthError(code: string | null): string | null {
  if (!code) return null;
  const map: Record<string, string> = {
    invalid_credentials: t("Incorrect email or password."),
    account_inactive: t("This account is inactive. Contact an administrator."),
    invalid_2fa: t("That code didn't match. Try again."),
    twofa_locked: t("Too many attempts. Try again in a few minutes."),
  };
  return map[code] ?? code;
}

const credSchema = z.object({
  email: z.string().email(t("Enter a valid email")),
  password: z.string().min(1, t("Password is required")),
});
type CredValues = z.infer<typeof credSchema>;

const totpSchema = z.object({
  totp: z
    .string()
    .regex(/^\d{6}$/, t("Enter the 6-digit code from your authenticator")),
});
type TotpValues = z.infer<typeof totpSchema>;

/** Validate redirect target; refuse external/protocol-relative URLs. */
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

export function LoginPage(): React.ReactElement {
  const login = useAuthStore((s) => s.login);
  const completeTotp = useAuthStore((s) => s.completeTotp);
  const requires2FA = useAuthStore((s) => s.requires2FA);
  const error = useAuthStore((s) => s.error);
  const isLoading = useAuthStore((s) => s.isLoading);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const explicitNext = safeNext(params.get("next"));

  // Email-verification gate: set when login returns `email_not_verified`.
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );

  const onResend = async (): Promise<void> => {
    if (!unverifiedEmail) return;
    setResend("sending");
    try {
      await authApi.resendVerification(unverifiedEmail);
      setResend("sent");
    } catch {
      setResend("error");
    }
  };

  const credForm = useForm<CredValues>({
    resolver: zodResolver(credSchema),
    defaultValues: { email: "", password: "" },
  });

  const totpForm = useForm<TotpValues>({
    resolver: zodResolver(totpSchema),
    defaultValues: { totp: "" },
  });

  // DEFECT-I: when the page mounts after a logout (or re-mount in any
  // scenario where the form state might be stale), force the controlled
  // form values back to empty so the previous user's email/password don't
  // flash on the next user's screen. We do NOT disable autocomplete — that
  // would break password managers; instead the inputs keep their
  // `autoComplete="email"` / `autoComplete="current-password"` hints and
  // simply start empty.
  useEffect(() => {
    credForm.reset({ email: "", password: "" });
    totpForm.reset({ totp: "" });
    // Run once on mount; resetting after every render would fight typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Where to send the user after a successful login or TOTP challenge. */
  const resolveDestination = (): string => {
    if (explicitNext) return explicitNext;
    const user = useAuthStore.getState().user;
    if (user) return pickLandingPathForUser(user);
    return routes.root();
  };

  const onCredSubmit = async (values: CredValues): Promise<void> => {
    setUnverifiedEmail(null);
    setResend("idle");
    try {
      const res = await login(values);
      if (!res.requires_2fa) {
        navigate(resolveDestination());
      }
      // If requires_2fa we stay on this page and the totp form renders.
    } catch (e) {
      // Surface the "verify your email" gate inline with a resend action.
      if (e instanceof ApiError && e.payload.detail === "email_not_verified") {
        const payload = e.payload as { email?: string };
        setUnverifiedEmail(payload.email ?? values.email);
      }
      // Other errors are surfaced via the store `error`.
    }
  };

  const onTotpSubmit = async (values: TotpValues): Promise<void> => {
    try {
      await completeTotp(values.totp);
      navigate(resolveDestination());
    } catch {
      // surfaced via store error
    }
  };

  return (
    <AuthLayout
      title={requires2FA ? t("Two-factor required") : t("Sign in")}
      subtitle={
        requires2FA
          ? t("Enter the 6-digit code from your authenticator app.")
          : t("Welcome back. Sign in to continue.")
      }
    >
      {unverifiedEmail ? (
        <div
          role="status"
          className="mb-4 rounded-md border border-primary/30 bg-primary/10 px-4 py-3 text-sm"
        >
          <p className="font-medium text-foreground">
            {t("Verify your email to continue")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t("We sent a verification link to")}{" "}
            <span className="font-medium text-foreground">
              {unverifiedEmail}
            </span>
            . {t("Click it to activate your account.")}
          </p>
          {resend === "sent" ? (
            <p className="mt-2 font-medium text-primary">
              {t("Sent. Check your inbox (and spam).")}
            </p>
          ) : (
            <button
              type="button"
              onClick={onResend}
              disabled={resend === "sending"}
              className="mt-2 font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none disabled:opacity-50"
            >
              {resend === "sending"
                ? t("Sending...")
                : t("Resend verification email")}
            </button>
          )}
          {resend === "error" ? (
            <p className="mt-1 text-destructive">
              {t("Couldn't resend right now. Try again shortly.")}
            </p>
          ) : null}
        </div>
      ) : null}

      {error && error !== "email_not_verified" ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {friendlyAuthError(error)}
        </div>
      ) : null}

      {requires2FA ? (
        <form
          onSubmit={totpForm.handleSubmit(onTotpSubmit)}
          className="flex flex-col gap-4"
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="totp">{t("Authentication code")}</Label>
            <Input
              id="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              aria-invalid={!!totpForm.formState.errors.totp}
              {...totpForm.register("totp")}
            />
            {totpForm.formState.errors.totp ? (
              <p role="alert" className="text-xs text-destructive">
                {totpForm.formState.errors.totp.message}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={isLoading} size="lg">
            {isLoading ? t("Verifying...") : t("Verify code")}
          </Button>
        </form>
      ) : (
        <form
          onSubmit={credForm.handleSubmit(onCredSubmit)}
          className="flex flex-col gap-4"
          noValidate
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">{t("Email")}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              aria-invalid={!!credForm.formState.errors.email}
              {...credForm.register("email")}
            />
            {credForm.formState.errors.email ? (
              <p role="alert" className="text-xs text-destructive">
                {credForm.formState.errors.email.message}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t("Password")}</Label>
              <Link
                to={routes.passwordResetRequest()}
                className="text-xs text-emerald-700 hover:underline focus-visible:underline focus-visible:outline-none"
              >
                {t("Forgot password?")}
              </Link>
            </div>
            <PasswordInput
              id="password"
              autoComplete="current-password"
              aria-invalid={!!credForm.formState.errors.password}
              {...credForm.register("password")}
            />
            {credForm.formState.errors.password ? (
              <p role="alert" className="text-xs text-destructive">
                {credForm.formState.errors.password.message}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={isLoading} size="lg">
            {isLoading ? t("Signing in...") : t("Sign in")}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {t("New here?")}{" "}
            <Link
              to={routes.signup()}
              className="font-medium text-emerald-700 hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {t("Create an account")}
            </Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
