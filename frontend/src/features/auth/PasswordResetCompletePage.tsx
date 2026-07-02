import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authApi } from "@/api/auth";
import { ApiError } from "@/types/api";
import { AuthLayout } from "./AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

const schema = z.object({
  password: z
    .string()
    .min(12, t("Password must be at least 12 characters")),
});
type FormValues = z.infer<typeof schema>;

export function PasswordResetCompletePage(): React.ReactElement {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: "" },
  });

  const onSubmit = async (values: FormValues): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await authApi.passwordResetComplete(token, values.password);
      setDone(true);
      // Auto-redirect after a brief moment so the success card is visible.
      setTimeout(() => navigate(routes.login()), 1500);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? (e.payload.detail ?? t("Reset failed"))
          : t("Reset failed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <AuthLayout
        title={t("Reset link missing")}
        subtitle={t("Request a new reset link to continue.")}
      >
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
        >
          {t("This page requires a token in the URL.")}
        </div>
        <div className="mt-6">
          <Link
            to={routes.passwordResetRequest()}
            className="text-sm font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {t("Request a new link")}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout
        title={t("Password updated")}
        subtitle={t("Redirecting you to sign in...")}
      >
        <div
          role="status"
          className="rounded-md border border-success/30 bg-success-muted p-4 text-sm text-success-foreground"
        >
          {t("You can now sign in with your new password.")}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t("Choose a new password")}
      subtitle={t("Pick something at least 12 characters long.")}
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
          <Label htmlFor="password">{t("New password")}</Label>
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
        <Button type="submit" disabled={submitting} size="lg">
          {submitting ? t("Saving...") : t("Set password")}
        </Button>
      </form>
    </AuthLayout>
  );
}
