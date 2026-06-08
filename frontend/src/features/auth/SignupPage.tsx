import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "react-router-dom";
import { useState } from "react";
import { authApi } from "@/api/auth";
import { ApiError } from "@/types/api";
import { AuthLayout } from "./AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Label } from "@/components/ui/label";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

const schema = z.object({
  full_name: z.string().optional(),
  email: z.string().email(t("Enter a valid email")),
  password: z
    .string()
    .min(12, t("Password must be at least 12 characters")),
  accept_terms: z.literal(true, {
    message: t("You must accept the terms"),
  }),
});
type FormValues = z.infer<typeof schema>;

/**
 * Score a password 0-3 with rough heuristics.
 *
 * - 0 = empty
 * - 1 = under 12 chars
 * - 2 = 12+ chars, single character class
 * - 3 = 12+ chars, mixed classes (letters + digits + symbol)
 *
 * The hint is non-blocking; the actual minimum is enforced by the zod schema
 * (min 12). The strength is purely advisory UI.
 */
function passwordStrength(pw: string): 0 | 1 | 2 | 3 {
  if (!pw) return 0;
  if (pw.length < 12) return 1;
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/\d/.test(pw)) +
    Number(/[^A-Za-z0-9]/.test(pw));
  return classes >= 3 ? 3 : 2;
}

export function SignupPage(): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      full_name: "",
      email: "",
      password: "",
      // accept_terms must be `true` literal at submit; default unchecked.
      accept_terms: undefined as unknown as true,
    },
  });

  const password = form.watch("password");
  const strength = passwordStrength(password);

  const onSubmit = async (values: FormValues): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      await authApi.signup({
        email: values.email,
        password: values.password,
        name: values.full_name ?? "",
      });
      setSubmittedEmail(values.email);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.payload.detail ?? t("Signup failed"))
          : t("Signup failed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (submittedEmail) {
    return (
      <AuthLayout
        title={t("Check your email")}
        subtitle={t(
          "We've sent a verification link. Click it to activate your account.",
        )}
      >
        <div
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          <p className="font-medium">{t("Almost there.")}</p>
          <p className="mt-1 text-emerald-900/80">
            {t("We sent a verification link to")}{" "}
            <span className="font-semibold">{submittedEmail}</span>.
          </p>
          <p className="mt-3 text-xs text-emerald-900/70">
            {t(
              "In development, the link is also printed to the Django console.",
            )}
          </p>
        </div>
        <div className="mt-6 flex flex-col gap-2 text-sm">
          <Link
            to={routes.login()}
            className="font-medium text-emerald-700 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {t("Back to sign in")}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  const strengthLabel = [
    t("Too short"),
    t("Weak"),
    t("Fair"),
    t("Strong"),
  ][strength];
  const strengthColor = [
    "bg-slate-200",
    "bg-red-500",
    "bg-amber-500",
    "bg-emerald-600",
  ][strength];

  return (
    <AuthLayout
      title={t("Create your account")}
      subtitle={t("You'll verify your email and (optionally) enable 2FA next.")}
    >
      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
        noValidate
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="full_name">
            {t("Full name")}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              {t("(optional)")}
            </span>
          </Label>
          <Input
            id="full_name"
            autoComplete="name"
            {...form.register("full_name")}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">{t("Email")}</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={!!form.formState.errors.email}
            {...form.register("email")}
          />
          {form.formState.errors.email ? (
            <p role="alert" className="text-xs text-destructive">
              {form.formState.errors.email.message}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">{t("Password")}</Label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            aria-invalid={!!form.formState.errors.password}
            aria-describedby="password-hint"
            {...form.register("password")}
          />
          <div id="password-hint" className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={3}
                aria-valuenow={strength}
                aria-label={t("Password strength")}
                className={`h-full transition-all ${strengthColor}`}
                style={{ width: `${(strength / 3) * 100}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {strengthLabel}
            </span>
          </div>
          {form.formState.errors.password ? (
            <p role="alert" className="text-xs text-destructive">
              {form.formState.errors.password.message}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("12+ characters; mix letters, numbers, symbols.")}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-input text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-invalid={!!form.formState.errors.accept_terms}
              {...form.register("accept_terms")}
            />
            <span>
              {t("I agree to the")}{" "}
              <Link
                to={routes.about()}
                className="font-medium text-emerald-700 hover:underline focus-visible:underline focus-visible:outline-none"
              >
                {t("terms of service")}
              </Link>
              .
            </span>
          </label>
          {form.formState.errors.accept_terms ? (
            <p role="alert" className="text-xs text-destructive">
              {form.formState.errors.accept_terms.message}
            </p>
          ) : null}
        </div>
        <Button type="submit" disabled={submitting} size="lg">
          {submitting ? t("Creating...") : t("Sign up")}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {t("Already have an account?")}{" "}
          <Link
            to={routes.login()}
            className="font-medium text-emerald-700 hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {t("Sign in")}
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}
