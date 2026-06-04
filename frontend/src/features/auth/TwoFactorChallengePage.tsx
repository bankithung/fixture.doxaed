import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "./authStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

export function TwoFactorChallengePage(): React.ReactElement {
  const completeTotp = useAuthStore((s) => s.completeTotp);
  const error = useAuthStore((s) => s.error);
  const isLoading = useAuthStore((s) => s.isLoading);
  const navigate = useNavigate();
  const [totp, setTotp] = useState("");

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    try {
      await completeTotp(totp);
      navigate(routes.root());
    } catch {
      // store sets error
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("Two-factor verification")}</CardTitle>
          <CardDescription>
            {t("Enter the code from your authenticator app.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="totp">{t("6-digit code")}</Label>
              <Input
                id="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={isLoading || totp.length !== 6}>
              {isLoading ? t("Verifying...") : t("Verify")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
