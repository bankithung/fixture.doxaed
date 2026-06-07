import * as React from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserMinus, UserPlus, Users } from "lucide-react";
import {
  tournamentsApi,
  type TournamentMember,
} from "@/api/tournaments";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/Select";
import { Avatar } from "@/components/ui/Avatar";
import { ROLE_KEYS } from "@/components/ui/RoleBadge";
import { newEventId } from "@/lib/eventId";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";

/**
 * Tournament-scoped Members & roles (Increment 11). Mirrors the org
 * `MemberDirectoryPage`, but the directory now lives INSIDE a tournament:
 *
 *   GET   /api/tournaments/:id/members/                 → roster
 *   PATCH /api/tournaments/:id/members/:membershipId/   → role / status
 *   POST  /api/tournaments/:id/invitations/             → invite by email
 *
 * The roster + mutations are manager-gated on the server (404 on no-access,
 * 403 for non-managers); we surface those as friendly states. The last-admin
 * guard (`400 {detail:"last_admin"}`) becomes a clear inline error.
 */

/** The 6 tournament roles, presented as Select options. */
const ROLE_OPTIONS = ROLE_KEYS.map((r) => ({
  value: r,
  label: t(r.replace(/_/g, " ")),
}));

/** Status pill presentation — token-only, with a leading status dot. */
function statusMeta(status: string): {
  label: string;
  badge: string;
  dot: string;
} {
  switch (status) {
    case "active":
      return {
        label: "Active",
        badge: "bg-primary/15 text-primary",
        dot: "bg-primary",
      };
    case "suspended":
      return {
        label: "Suspended",
        badge: "bg-accent text-accent-foreground",
        dot: "bg-muted-foreground",
      };
    case "revoked":
      return {
        label: "Revoked",
        badge: "bg-destructive/15 text-destructive",
        dot: "bg-destructive",
      };
    default:
      return {
        label: status,
        badge: "bg-muted text-muted-foreground",
        dot: "bg-muted-foreground/40",
      };
  }
}

function StatusPill({ status }: { status: string }): React.ReactElement {
  const m = statusMeta(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        m.badge,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} />
      {t(m.label)}
    </span>
  );
}

function formatJoined(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

interface RowProps {
  member: TournamentMember;
  onRoleChange: (m: TournamentMember, role: string) => void;
  onRevoke: (m: TournamentMember) => void;
  busy: boolean;
}

function MemberRow({
  member,
  onRoleChange,
  onRevoke,
  busy,
}: RowProps): React.ReactElement {
  const displayName = member.full_name?.trim() || member.email;
  const revoked = member.status === "revoked";
  return (
    <tr
      className="border-t border-border transition-colors hover:bg-accent/40"
      data-testid={`member-row-${member.id}`}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar email={member.email} name={member.full_name} />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">
              {member.email}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="truncate text-sm text-foreground">{displayName}</span>
      </td>
      <td className="px-4 py-3">
        <Select
          value={member.role}
          onChange={(v) => onRoleChange(member, v)}
          options={ROLE_OPTIONS}
          disabled={busy || revoked}
          aria-label={t(`Role for ${displayName}`)}
          className="w-44"
        />
      </td>
      <td className="px-4 py-3">
        <StatusPill status={member.status} />
      </td>
      <td className="px-4 py-3 font-tabular text-sm text-muted-foreground">
        <span title={member.assigned_at}>{formatJoined(member.assigned_at)}</span>
      </td>
      <td className="px-4 py-3 text-right">
        {!revoked ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onRevoke(member)}
            data-testid={`revoke-${member.id}`}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <UserMinus className="h-4 w-4" aria-hidden="true" />
            {t("Revoke")}
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

function MemberCard({
  member,
  onRoleChange,
  onRevoke,
  busy,
}: RowProps): React.ReactElement {
  const displayName = member.full_name?.trim() || member.email;
  const revoked = member.status === "revoked";
  return (
    <div
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      data-testid={`member-row-${member.id}`}
    >
      <div className="flex items-start gap-3">
        <Avatar email={member.email} name={member.full_name} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground">
            {displayName}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {member.email}
          </div>
        </div>
        <StatusPill status={member.status} />
      </div>
      <div className="mt-3 flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">{t("Role")}</Label>
        <Select
          value={member.role}
          onChange={(v) => onRoleChange(member, v)}
          options={ROLE_OPTIONS}
          disabled={busy || revoked}
          aria-label={t(`Role for ${displayName}`)}
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="font-tabular" title={member.assigned_at}>
          {t("Joined")} {formatJoined(member.assigned_at)}
        </span>
        {!revoked ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onRevoke(member)}
            data-testid={`revoke-${member.id}`}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <UserMinus className="h-4 w-4" aria-hidden="true" />
            {t("Revoke")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function InvitePanel({ tournamentId }: { tournamentId: string }): React.ReactElement {
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<string>("team_manager");
  const toast = useToast();

  const invite = useMutation({
    mutationFn: () =>
      tournamentsApi.invite(tournamentId, {
        email,
        role,
        event_id: newEventId(),
      }),
    onSuccess: () => {
      toast.push({
        kind: "success",
        title: t("Invitation sent"),
        description: t(
          "They'll appear in the roster once they accept the invitation.",
        ),
      });
      setEmail("");
    },
    onError: (e) => {
      toast.push({
        kind: "error",
        title: t("Could not send invitation"),
        description:
          e instanceof ApiError
            ? (e.payload.detail ?? undefined)
            : undefined,
      });
    },
  });

  return (
    <section
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      aria-label={t("Invite a member")}
    >
      <div className="mb-3">
        <h2 className="text-sm font-semibold">{t("Invite a member")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("They'll appear in the roster once they accept the invitation.")}
        </p>
      </div>
      <form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (email && !invite.isPending) invite.mutate();
        }}
      >
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="invite-email" className="text-xs text-muted-foreground">
            {t("Email")}
          </Label>
          <Input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("person@example.com")}
            data-testid="invite-email"
          />
        </div>
        <div className="flex flex-col gap-1 sm:w-48">
          <Label htmlFor="invite-role" className="text-xs text-muted-foreground">
            {t("Role")}
          </Label>
          <Select
            id="invite-role"
            value={role}
            onChange={setRole}
            options={ROLE_OPTIONS}
            aria-label={t("Invite role")}
          />
        </div>
        <Button
          type="submit"
          disabled={!email || invite.isPending}
          data-testid="invite-submit"
          className="shrink-0"
        >
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          {invite.isPending ? t("Sending...") : t("Invite")}
        </Button>
      </form>
    </section>
  );
}

export function TournamentMembersPage(): React.ReactElement {
  const { id = "" } = useParams<{ id: string }>();
  const { isMobile } = useBreakpoint();
  const qc = useQueryClient();
  const toast = useToast();

  const [pendingRevoke, setPendingRevoke] =
    React.useState<TournamentMember | null>(null);

  const membersQuery = useQuery({
    queryKey: ["tournament", id, "members"],
    queryFn: () => tournamentsApi.members(id),
    enabled: Boolean(id),
  });

  const mutation = useMutation({
    mutationFn: ({
      membershipId,
      body,
    }: {
      membershipId: string;
      body: { role?: string; status?: string };
    }) => tournamentsApi.updateMember(id, membershipId, body),
    onSuccess: (_data, vars) => {
      toast.push({
        kind: "success",
        title:
          vars.body.status === "revoked"
            ? t("Member removed")
            : t("Role updated"),
      });
      qc.invalidateQueries({ queryKey: ["tournament", id, "members"] });
    },
    onError: (e) => {
      const isLastAdmin =
        e instanceof ApiError && e.payload.detail === "last_admin";
      toast.push({
        kind: "error",
        title: isLastAdmin
          ? t("You can't remove the last admin")
          : t("Could not update member"),
        description: isLastAdmin
          ? t("Promote another member to admin first.")
          : undefined,
      });
    },
  });

  const onRoleChange = (m: TournamentMember, role: string): void => {
    if (role === m.role) return;
    mutation.mutate({ membershipId: m.id, body: { role } });
  };

  const onRevoke = (m: TournamentMember): void => {
    setPendingRevoke(m);
  };

  const confirmRevoke = (): void => {
    if (!pendingRevoke) return;
    mutation.mutate({
      membershipId: pendingRevoke.id,
      body: { status: "revoked" },
    });
    setPendingRevoke(null);
  };

  const members = membersQuery.data ?? [];
  const total = members.length;
  const busy = mutation.isPending;
  const pendingName =
    pendingRevoke?.full_name?.trim() || pendingRevoke?.email || "";

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="min-w-0">
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t("Tournament")}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {t("Members & roles")}
        </h1>
        <p className="mt-1 font-tabular text-sm text-muted-foreground">
          {membersQuery.isLoading
            ? t("Loading members...")
            : t(`${total} ${total === 1 ? "member" : "members"}`)}
        </p>
      </div>

      <InvitePanel tournamentId={id} />

      <section
        className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        aria-label={t("Roster")}
      >
        <div className="border-b border-border p-4">
          <h2 className="text-sm font-semibold">{t("Roster")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("People with a role in this tournament.")}
          </p>
        </div>

        <div className="p-4">
          {membersQuery.isLoading ? (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col gap-3"
            >
              <span className="sr-only">{t("Loading members...")}</span>
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                  data-testid="member-skeleton"
                >
                  <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
                  <div className="flex flex-1 flex-col gap-2">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-muted/70" />
                  </div>
                  <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
                </div>
              ))}
            </div>
          ) : membersQuery.isError ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
            >
              <p className="font-medium text-destructive">
                {t("Failed to load members.")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => membersQuery.refetch()}
                data-testid="members-retry"
              >
                {t("Retry")}
              </Button>
            </div>
          ) : total === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
              <Users
                className="h-8 w-8 text-muted-foreground/50"
                aria-hidden="true"
              />
              <div>
                <h3 className="text-base font-semibold">{t("No members yet")}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("Invite people to give them a role in this tournament.")}
                </p>
              </div>
            </div>
          ) : isMobile ? (
            <div
              className="flex flex-col gap-3"
              aria-label={t("Members table")}
              data-testid="members-table"
            >
              {members.map((m) => (
                <MemberCard
                  key={m.id}
                  member={m}
                  onRoleChange={onRoleChange}
                  onRevoke={onRevoke}
                  busy={busy}
                />
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full text-sm"
                aria-label={t("Members table")}
                data-testid="members-table"
              >
                <thead>
                  <tr className="text-left text-[0.6875rem] uppercase tracking-[0.12em] text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">{t("Email")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Name")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Role")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Status")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Joined")}</th>
                    <th className="w-10 px-4 py-2.5" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <MemberRow
                      key={m.id}
                      member={m}
                      onRoleChange={onRoleChange}
                      onRevoke={onRevoke}
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
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
        ariaLabel={t("Revoke member")}
      >
        <DialogHeader>
          <DialogTitle>{t("Revoke member")}</DialogTitle>
          <DialogDescription>
            {t(
              `Remove ${pendingName} from this tournament? They'll lose access to all tournament surfaces.`,
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setPendingRevoke(null)}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={confirmRevoke}
            data-testid="confirm-revoke"
          >
            <UserMinus className="h-4 w-4" aria-hidden="true" />
            {t("Revoke")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
