import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Inbox, X } from "lucide-react";
import { invitationsApi, type MyInvitation } from "@/api/invitations";
import { ApiError } from "@/types/api";
import { useToast } from "@/components/ui/toast";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { routes } from "@/lib/routes";
import { t } from "@/lib/t";

/**
 * Invites inbox (Increment 13). Lists the signed-in user's PENDING invitations
 * and lets them accept (joins + jumps to the tournament) or decline:
 *
 *   GET  /api/invitations/          → the current user's pending invites
 *   POST /api/invitations/<id>:accept/
 *   POST /api/invitations/<id>:decline/
 *
 * Accept invalidates both this list AND the tournaments-list query
 * (`["tournaments"]`) so a freshly-joined tournament appears immediately on the
 * Tournaments hub; the AppShell's pending-count badge falls off too.
 */

/** Humanize the 6 snake_case roles → display labels. */
const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  co_organizer: "Co-organizer",
  game_coordinator: "Game coordinator",
  match_scorer: "Match scorer",
  referee: "Referee",
  team_manager: "Team manager",
};

function humanizeRole(role: string): string {
  return t(ROLE_LABELS[role] ?? role.replace(/_/g, " "));
}

/** Tournament name when present, else the org name (org-level invite). */
function scopeName(inv: MyInvitation): string {
  return inv.tournament_name?.trim() || inv.organization_name;
}

function formatExpires(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

interface RowProps {
  invite: MyInvitation;
  onAccept: (inv: MyInvitation) => void;
  onDecline: (inv: MyInvitation) => void;
  busy: boolean;
}

function InviteActions({
  invite,
  onAccept,
  onDecline,
  busy,
}: RowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        type="button"
        size="sm"
        disabled={busy}
        onClick={() => onAccept(invite)}
        data-testid={`accept-${invite.id}`}
      >
        <Check className="h-4 w-4" aria-hidden="true" />
        {t("Accept")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => onDecline(invite)}
        data-testid={`decline-${invite.id}`}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="h-4 w-4" aria-hidden="true" />
        {t("Decline")}
      </Button>
    </div>
  );
}

function InviteRow({
  invite,
  onAccept,
  onDecline,
  busy,
}: RowProps): React.ReactElement {
  return (
    <tr
      className="border-t border-border transition-colors hover:bg-accent/40"
      data-testid={`invite-row-${invite.id}`}
    >
      <td className="px-4 py-3">
        <span className="truncate font-medium text-foreground">
          {scopeName(invite)}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="truncate text-sm text-foreground">
          {humanizeRole(invite.role)}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="truncate text-sm text-muted-foreground">
          {invite.invited_by_email}
        </span>
      </td>
      <td className="px-4 py-3 font-tabular text-sm text-muted-foreground">
        <span title={invite.expires_at}>{formatExpires(invite.expires_at)}</span>
      </td>
      <td className="px-4 py-3 text-right">
        <InviteActions
          invite={invite}
          onAccept={onAccept}
          onDecline={onDecline}
          busy={busy}
        />
      </td>
    </tr>
  );
}

function InviteCard({
  invite,
  onAccept,
  onDecline,
  busy,
}: RowProps): React.ReactElement {
  return (
    <div
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      data-testid={`invite-row-${invite.id}`}
    >
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">
          {scopeName(invite)}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {humanizeRole(invite.role)} · {t("from")} {invite.invited_by_email}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span
          className="font-tabular text-xs text-muted-foreground"
          title={invite.expires_at}
        >
          {t("Expires")} {formatExpires(invite.expires_at)}
        </span>
        <InviteActions
          invite={invite}
          onAccept={onAccept}
          onDecline={onDecline}
          busy={busy}
        />
      </div>
    </div>
  );
}

export function InvitesPage(): React.ReactElement {
  const { isMobile } = useBreakpoint();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const [pendingDecline, setPendingDecline] =
    React.useState<MyInvitation | null>(null);

  const invitesQuery = useQuery({
    queryKey: ["my-invitations"],
    queryFn: invitationsApi.myInvitations,
  });

  const acceptMutation = useMutation({
    mutationFn: (inv: MyInvitation) => invitationsApi.acceptInvitation(inv.id),
    onSuccess: (data, inv) => {
      toast.push({
        kind: "success",
        title: t(`Joined ${scopeName(inv)}`),
      });
      // Refresh the inbox AND the tournaments hub so the freshly-joined
      // tournament shows up immediately.
      void qc.invalidateQueries({ queryKey: ["my-invitations"] });
      void qc.invalidateQueries({ queryKey: ["tournaments"] });
      const tournamentId = data.tournament_id ?? inv.tournament_id;
      if (tournamentId) {
        navigate(routes.tournamentDetail(tournamentId));
      } else {
        navigate(routes.tournaments());
      }
    },
    onError: (e) => {
      toast.push({
        kind: "error",
        title: t("Could not accept invitation"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      });
    },
  });

  const declineMutation = useMutation({
    mutationFn: (inv: MyInvitation) => invitationsApi.declineInvitation(inv.id),
    onSuccess: () => {
      toast.push({ kind: "success", title: t("Invitation declined") });
      void qc.invalidateQueries({ queryKey: ["my-invitations"] });
    },
    onError: (e) => {
      toast.push({
        kind: "error",
        title: t("Could not decline invitation"),
        description:
          e instanceof ApiError ? (e.payload.detail ?? undefined) : undefined,
      });
    },
  });

  const onAccept = (inv: MyInvitation): void => {
    acceptMutation.mutate(inv);
  };

  const onDecline = (inv: MyInvitation): void => {
    setPendingDecline(inv);
  };

  const confirmDecline = (): void => {
    if (!pendingDecline) return;
    declineMutation.mutate(pendingDecline);
    setPendingDecline(null);
  };

  const invites = invitesQuery.data ?? [];
  const total = invites.length;
  const busy = acceptMutation.isPending || declineMutation.isPending;

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="min-w-0">
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t("Workspace")}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {t("Invitations")}
        </h1>
        <p className="mt-1 font-tabular text-sm text-muted-foreground">
          {invitesQuery.isLoading
            ? t("Loading invitations...")
            : t(
                `${total} pending ${total === 1 ? "invitation" : "invitations"}`,
              )}
        </p>
      </div>

      <section
        className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        aria-label={t("Pending invitations")}
      >
        <div className="p-4">
          {invitesQuery.isLoading ? (
            <div role="status" aria-live="polite" className="flex flex-col gap-3">
              <span className="sr-only">{t("Loading invitations...")}</span>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                  data-testid="invite-skeleton"
                >
                  <div className="flex flex-1 flex-col gap-2">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-muted/70" />
                  </div>
                  <div className="h-8 w-40 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : invitesQuery.isError ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
            >
              <p className="font-medium text-destructive">
                {t("Failed to load invitations.")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => invitesQuery.refetch()}
                data-testid="invites-retry"
              >
                {t("Retry")}
              </Button>
            </div>
          ) : total === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
              <Inbox
                className="h-8 w-8 text-muted-foreground/50"
                aria-hidden="true"
              />
              <div>
                <h3 className="text-base font-semibold">
                  {t("No pending invitations.")}
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("When someone invites you, it'll show up here.")}
                </p>
              </div>
            </div>
          ) : isMobile ? (
            <div
              className="flex flex-col gap-3"
              aria-label={t("Invitations table")}
              data-testid="invites-table"
            >
              {invites.map((inv) => (
                <InviteCard
                  key={inv.id}
                  invite={inv}
                  onAccept={onAccept}
                  onDecline={onDecline}
                  busy={busy}
                />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                aria-label={t("Invitations table")}
                data-testid="invites-table"
              >
                <thead>
                  <tr className="text-left text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">
                      {t("Tournament")}
                    </th>
                    <th className="px-4 py-2.5 font-medium">{t("Role")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Invited by")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Expires")}</th>
                    <th className="w-10 px-4 py-2.5" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv) => (
                    <InviteRow
                      key={inv.id}
                      invite={inv}
                      onAccept={onAccept}
                      onDecline={onDecline}
                      busy={busy}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <Dialog
        open={pendingDecline !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDecline(null);
        }}
        ariaLabel={t("Decline invitation")}
      >
        <DialogHeader>
          <DialogTitle>{t("Decline invitation")}</DialogTitle>
          <DialogDescription>
            {t(
              `Decline the invitation to ${
                pendingDecline ? scopeName(pendingDecline) : ""
              }? This can't be undone — they'd need to re-invite you.`,
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setPendingDecline(null)}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={confirmDecline}
            data-testid="confirm-decline"
          >
            <X className="h-4 w-4" aria-hidden="true" />
            {t("Decline")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
