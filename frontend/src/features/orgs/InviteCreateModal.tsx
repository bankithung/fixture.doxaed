import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, Copy, Mail } from "lucide-react";
import { orgsApi } from "@/api/orgs";
import { ApiError } from "@/types/api";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { ROLE_KEYS, RoleBadge } from "@/components/ui/RoleBadge";
import type { OrgInvitation } from "@/types/user";
import { t } from "@/lib/t";

/**
 * v1Users.md §2.13 invite-create surface.
 *
 * Scope per Wave 0 spec:
 *   1. Form: email, ≥1 role checkbox from the v1Users module catalog,
 *      optional message.
 *   2. Submit → POST /api/orgs/{slug}/invitations/ with a fresh `event_id`
 *      (idempotency invariant #3).
 *   3. Success → swap to a "Sent" view that reveals the one-shot token
 *      with copy-to-clipboard + a `${origin}/accept?token=...` share link.
 *   4. Failure → red error banner inside the modal; form values preserved.
 */

const ROLE_LABELS: Record<(typeof ROLE_KEYS)[number], string> = {
  admin: "Admin",
  co_organizer: "Co-organizer",
  game_coordinator: "Game coordinator",
  match_scorer: "Match scorer",
  referee: "Referee",
  team_manager: "Team manager",
};

const schema = z.object({
  email: z.string().min(1, t("Enter an email")).email(t("Enter a valid email")),
  roles: z.array(z.string()).min(1, t("Pick at least one role")),
  message: z.string().max(500).optional().or(z.literal("")),
});
type FormValues = z.infer<typeof schema>;

export interface InviteCreateModalProps {
  orgSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function newEventId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `ev_${Math.random().toString(36).slice(2)}`;
}

function shareLinkFor(token: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  return `${origin}/accept?token=${encodeURIComponent(token)}`;
}

export function InviteCreateModal({
  orgSlug,
  open,
  onOpenChange,
}: InviteCreateModalProps): React.ReactElement {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<OrgInvitation | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", roles: ["admin"], message: "" },
  });

  // Reset transient state every time the dialog re-opens.
  React.useEffect(() => {
    if (open) {
      setError(null);
      setSent(null);
      form.reset({ email: "", roles: ["admin"], message: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const createInvite = useMutation({
    mutationFn: (values: FormValues) =>
      orgsApi.createInvitation(orgSlug, {
        email: values.email,
        roles: values.roles,
        event_id: newEventId(),
      }),
    onSuccess: (inv) => {
      toast.push({ kind: "success", title: t("Invitation sent") });
      qc.invalidateQueries({ queryKey: ["org", orgSlug, "invitations"] });
      setSent(inv);
    },
    onError: (e) => {
      setError(
        e instanceof ApiError
          ? (e.payload.detail ?? t("Could not create invitation"))
          : t("Could not create invitation"),
      );
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setError(null);
    createInvite.mutate(values);
  });

  const close = (): void => {
    onOpenChange(false);
  };

  const isSent = sent !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={isSent ? t("Invitation sent") : t("Invite a member")}
    >
      <DialogHeader>
        <DialogTitle>
          {isSent ? t("Invitation sent") : t("Invite a member")}
        </DialogTitle>
      </DialogHeader>

      {isSent && sent ? <SentView invitation={sent} onDone={close} /> : null}

      {!isSent ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-email">{t("Email")}</Label>
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              autoFocus
              aria-invalid={Boolean(form.formState.errors.email)}
              {...form.register("email")}
            />
            {form.formState.errors.email ? (
              <p
                role="alert"
                data-testid="email-error"
                className="text-xs text-destructive"
              >
                {form.formState.errors.email.message}
              </p>
            ) : null}
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">{t("Roles")}</legend>
            <div className="flex flex-wrap gap-2">
              {ROLE_KEYS.map((r) => (
                <label
                  key={r}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                >
                  <input
                    type="checkbox"
                    value={r}
                    aria-label={t(ROLE_LABELS[r])}
                    {...form.register("roles")}
                  />
                  <RoleBadge role={r} />
                </label>
              ))}
            </div>
            {form.formState.errors.roles ? (
              <p
                role="alert"
                data-testid="roles-error"
                className="text-xs text-destructive"
              >
                {form.formState.errors.roles.message as string}
              </p>
            ) : null}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-message">
              {t("Message")}{" "}
              <span className="font-normal text-muted-foreground">
                ({t("optional")})
              </span>
            </Label>
            <textarea
              id="invite-message"
              rows={3}
              maxLength={500}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              placeholder={t("Add a personal note (sent with the invite email).")}
              {...form.register("message")}
            />
          </div>

          {error ? (
            <p
              role="alert"
              data-testid="invite-error"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={createInvite.isPending}
              data-testid="invite-submit"
            >
              <Mail className="h-4 w-4" aria-hidden="true" />
              {createInvite.isPending ? t("Sending...") : t("Send invite")}
            </Button>
          </DialogFooter>
        </form>
      ) : null}
    </Dialog>
  );
}

interface SentViewProps {
  invitation: OrgInvitation;
  onDone: () => void;
}

function SentView({ invitation, onDone }: SentViewProps): React.ReactElement {
  const token = invitation.token ?? "";
  const link = token ? shareLinkFor(token) : "";
  const expiry = new Date(invitation.expires_at);
  const expiryLabel = Number.isNaN(expiry.getTime())
    ? invitation.expires_at
    : expiry.toLocaleString();

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t(
          `Email sent to ${invitation.email}. Or share the link below.`,
        )}
      </p>
      <CopyField
        label={t("Invitation token")}
        value={token}
        testId="invite-token"
        helpText={t("Shown once. Copy it now.")}
      />
      <CopyField
        label={t("Share link")}
        value={link}
        testId="invite-link"
        helpText={t(`Expires ${expiryLabel}.`)}
      />
      <DialogFooter>
        <Button type="button" onClick={onDone} data-testid="invite-done">
          {t("Done")}
        </Button>
      </DialogFooter>
    </div>
  );
}

interface CopyFieldProps {
  label: string;
  value: string;
  testId: string;
  helpText?: string;
}

function CopyField({
  label,
  value,
  testId,
  helpText,
}: CopyFieldProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const inputId = `copy-${testId}`;
  const onCopy = async (): Promise<void> => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else if (typeof document !== "undefined") {
        const el = document.getElementById(inputId) as HTMLInputElement | null;
        el?.select();
        document.execCommand("copy");
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          readOnly
          value={value}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
          data-testid={testId}
        />
        <Button
          type="button"
          variant="outline"
          onClick={onCopy}
          aria-label={t(`Copy ${label}`)}
          data-testid={`${testId}-copy`}
        >
          {copied ? (
            <>
              <Check className="h-4 w-4" aria-hidden="true" />
              {t("Copied")}
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" aria-hidden="true" />
              {t("Copy")}
            </>
          )}
        </Button>
      </div>
      {helpText ? (
        <p className="text-xs text-muted-foreground">{helpText}</p>
      ) : null}
    </div>
  );
}
