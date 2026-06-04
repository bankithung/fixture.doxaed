import { useEffect, useState } from "react";
import { authApi } from "@/api/auth";
import { ApiError } from "@/types/api";
import { onAuthEvent } from "@/api/queryClient";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/lib/t";

/**
 * v1Users.md Appendix B.18 — sensitive verbs require a fresh password
 * within the session. The bus emits `password_reauth_required` whenever
 * the API returns 403 with `{detail: "password_reauth_required"}`. This
 * modal subscribes globally and re-prompts.
 */
export function PasswordReauthModal(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      onAuthEvent((e) => {
        if (e.type === "password_reauth_required") {
          setError(null);
          setPassword("");
          setOpen(true);
        }
      }),
    [],
  );

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await authApi.reauth(password);
      setOpen(false);
      setPassword("");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.payload.detail ?? t("Re-authentication failed"))
          : t("Re-authentication failed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      ariaLabel={t("Confirm your password")}
    >
      <form onSubmit={onSubmit}>
        <DialogHeader>
          <DialogTitle>{t("Confirm your password")}</DialogTitle>
          <DialogDescription>
            {t(
              "This action requires a fresh password confirmation for security.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="reauth-password">{t("Password")}</Label>
          <Input
            id="reauth-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            {t("Cancel")}
          </Button>
          <Button type="submit" disabled={submitting || !password}>
            {submitting ? t("Confirming...") : t("Confirm")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
