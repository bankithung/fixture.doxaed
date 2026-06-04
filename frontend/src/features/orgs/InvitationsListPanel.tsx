import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Trash2 } from "lucide-react";
import {
  orgsApi,
  unwrapList,
  type InvitationListItem,
} from "@/api/orgs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { RoleBadge } from "@/components/ui/RoleBadge";
import { t } from "@/lib/t";

/**
 * Companion panel for the member directory. Lists pending invitations,
 * lets admins revoke them, and offers a copy-link affordance for any
 * invite whose token is still surfaced (the create response embeds the
 * token; the LIST response normally does not). When there are no pending
 * invites we render nothing — the parent page already shows the member
 * table and an invite button, so an empty panel would just be noise.
 */

export interface InvitationsListPanelProps {
  orgSlug: string;
  canManage: boolean;
}

function shareLinkFor(token: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  return `${origin}/accept?token=${encodeURIComponent(token)}`;
}

export function InvitationsListPanel({
  orgSlug,
  canManage,
}: InvitationsListPanelProps): React.ReactElement | null {
  const qc = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ["org", orgSlug, "invitations"],
    queryFn: () => orgsApi.invitations(orgSlug),
    enabled: Boolean(orgSlug) && canManage,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => orgsApi.revokeInvitation(orgSlug, id),
    onSuccess: () => {
      toast.push({ kind: "success", title: t("Invitation revoked") });
      qc.invalidateQueries({ queryKey: ["org", orgSlug, "invitations"] });
    },
    onError: () => {
      toast.push({ kind: "error", title: t("Could not revoke invitation") });
    },
  });

  if (!canManage) return null;

  const all = unwrapList(query.data);
  const pending = all.filter((i) => i.status === "pending");
  if (pending.length === 0) return null;

  return (
    <Card data-testid="invitations-panel">
      <CardHeader>
        <CardTitle>{t("Pending invitations")}</CardTitle>
        <CardDescription>
          {t(
            `${pending.length} ${pending.length === 1 ? "invitation" : "invitations"} awaiting acceptance.`,
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {pending.map((inv) => (
            <InvitationRow
              key={inv.id}
              invitation={inv}
              onRevoke={() => revoke.mutate(inv.id)}
              isRevoking={revoke.isPending && revoke.variables === inv.id}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

interface InvitationRowProps {
  invitation: InvitationListItem;
  onRevoke: () => void;
  isRevoking: boolean;
}

function InvitationRow({
  invitation,
  onRevoke,
  isRevoking,
}: InvitationRowProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const expiresAt = new Date(invitation.expires_at);
  const expiresLabel = Number.isNaN(expiresAt.getTime())
    ? invitation.expires_at
    : expiresAt.toLocaleDateString();
  const link = invitation.token ? shareLinkFor(invitation.token) : "";

  const onCopy = async (): Promise<void> => {
    if (!link) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <li
      className="flex flex-wrap items-center justify-between gap-3 py-3"
      data-testid={`invitation-row-${invitation.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{invitation.email}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {(invitation.roles ?? []).map((r) => (
            <RoleBadge key={r} role={r} />
          ))}
          <span className="text-xs text-muted-foreground">
            {t(`expires ${expiresLabel}`)}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {link ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCopy}
            aria-label={t(`Copy invitation link for ${invitation.email}`)}
            data-testid={`invitation-copy-${invitation.id}`}
          >
            {copied ? (
              <>
                <Check className="h-4 w-4" aria-hidden="true" />
                {t("Copied")}
              </>
            ) : (
              <>
                <Copy className="h-4 w-4" aria-hidden="true" />
                {t("Copy link")}
              </>
            )}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRevoke}
          disabled={isRevoking}
          aria-label={t(`Revoke invitation for ${invitation.email}`)}
          data-testid={`invitation-revoke-${invitation.id}`}
          className="text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {isRevoking ? t("Revoking...") : t("Revoke")}
        </Button>
      </div>
    </li>
  );
}
