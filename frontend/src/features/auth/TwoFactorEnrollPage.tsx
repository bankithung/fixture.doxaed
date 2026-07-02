import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "@/api/auth";
import { ApiError } from "@/types/api";
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
import { useAuthStore } from "./authStore";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

export function TwoFactorEnrollPage(): React.ReactElement {
  const navigate = useNavigate();
  const refreshMe = useAuthStore((s) => s.refreshMe);
  const [qrDataUri, setQrDataUri] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [totp, setTotp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authApi.totpEnrollBegin();
        if (cancelled) return;
        setQrDataUri(res.qr_data_uri ?? null);
        setUri(res.otpauth_uri);
      } catch (e) {
        if (cancelled) return;
        setError(
          e instanceof ApiError
            ? (e.payload.detail ?? t("Could not start 2FA enrollment"))
            : t("Could not start 2FA enrollment"),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onConfirm = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await authApi.totpEnrollConfirm(totp);
      setRecovery(res.recovery_codes);
      await refreshMe();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.payload.detail ?? t("Code rejected"))
          : t("Code rejected"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("Enable two-factor authentication")}</CardTitle>
          <CardDescription>
            {t(
              "Scan the QR with an authenticator app, then enter the 6-digit code.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {recovery ? (
            <>
              <p role="status" className="text-sm text-grant">
                {t(
                  "2FA enabled. Save these recovery codes somewhere safe · each works once.",
                )}
              </p>
              <ul className="grid grid-cols-2 gap-1 rounded border bg-muted/30 p-3 font-mono text-xs">
                {recovery.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
              <Button onClick={() => navigate(routes.root())}>
                {t("Done")}
              </Button>
            </>
          ) : (
            <>
              {qrDataUri ? (
                <div className="flex justify-center">
                  <img
                    src={qrDataUri}
                    alt={t("QR code for authenticator app")}
                    className="h-48 w-48 rounded border bg-white p-2"
                  />
                </div>
              ) : null}
              {uri ? (
                <div className="rounded border p-3 text-xs">
                  <p className="font-medium">{t("Manual entry URI")}</p>
                  <code className="break-all">{uri}</code>
                </div>
              ) : null}
              <form onSubmit={onConfirm} className="flex flex-col gap-3">
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
                <Button
                  type="submit"
                  disabled={submitting || totp.length !== 6}
                >
                  {submitting ? t("Verifying...") : t("Confirm")}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
