import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Link } from "react-router-dom";
import { authApi } from "@/api/auth";
import { AuthLayout } from "./AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

const schema = z.object({
  email: z.string().email(t("Enter a valid email")),
});
type FormValues = z.infer<typeof schema>;

export function PasswordResetRequestPage(): React.ReactElement {
  const [submitted, setSubmitted] = useState(false);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  const onSubmit = async (values: FormValues): Promise<void> => {
    try {
      await authApi.passwordResetRequest(values.email);
    } catch {
      // Anti-enumeration: always show success state even on backend error.
    }
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <AuthLayout
        title={t("Check your email")}
        subtitle={t("If we found a match, a reset link is on its way.")}
      >
        <div
          role="status"
          className="rounded-md border border-success/30 bg-success-muted p-4 text-sm text-success-foreground"
        >
          {t(
            "Reset links expire in 30 minutes. Didn't get one? Check spam or try again.",
          )}
        </div>
        <div className="mt-6">
          <Link
            to={routes.login()}
            className="text-sm font-medium text-primary hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {t("Back to sign in")}
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={t("Reset your password")}
      subtitle={t(
        "Enter your email and we'll send you a link to choose a new one.",
      )}
    >
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
        noValidate
      >
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
        <Button type="submit" size="lg">
          {t("Send reset link")}
        </Button>
        <Link
          to={routes.login()}
          className="text-center text-xs text-primary hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {t("Back to sign in")}
        </Link>
      </form>
    </AuthLayout>
  );
}
