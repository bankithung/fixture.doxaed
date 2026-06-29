import * as React from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreVertical, Search, UserMinus, UserPlus, Users } from "lucide-react";
import { orgsApi, unwrapList, type OrgMember } from "@/api/orgs";
import { useAuthStore } from "@/features/auth/authStore";
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
import { Avatar } from "@/components/ui/Avatar";
import { RoleBadge } from "@/components/ui/RoleBadge";
import { useBreakpoint } from "@/lib/useBreakpoint";
import { cn } from "@/lib/tailwind";
import { t } from "@/lib/t";
import { InviteCreateModal } from "./InviteCreateModal";
import { InvitationsListPanel } from "./InvitationsListPanel";

/**
 * v1Users.md §3.x member directory + invite surface.
 *
 * Module gating: rendered only when the active org membership has
 * `org.member_directory` in `effective_modules`. Without it we render a
 * "no permission" card — matches the rest of the app's gating idiom
 * (see `OrgDashboardPage`). The Invite + Remove actions are additionally
 * gated on `org.settings` OR membership.role ∈ {owner, admin}.
 */

const REQUIRED_MODULE = "org.member_directory";
const ADMIN_MODULE = "org.settings";

/** Active/inactive presentation — token-only, with a leading status dot. */
function activityMeta(isActive: boolean): {
  label: string;
  badge: string;
  dot: string;
} {
  return isActive
    ? { label: "Active", badge: "bg-primary/15 text-primary", dot: "bg-primary" }
    : {
        label: "Inactive",
        badge: "bg-muted text-muted-foreground",
        dot: "bg-muted-foreground/40",
      };
}

function MemberRoles({ member }: { member: OrgMember }): React.ReactElement {
  const isOwner = Boolean(member.is_org_owner);
  const extraRoles = (member.roles ?? []).filter((r) => r !== "owner");
  const hasAny = isOwner || extraRoles.length > 0;
  return (
    <div className="flex flex-wrap gap-1">
      {isOwner ? <RoleBadge role="owner" isOwner /> : null}
      {extraRoles.map((r) => (
        <RoleBadge key={r} role={r} />
      ))}
      {!hasAny ? (
        <span className="text-xs text-muted-foreground">{t("No roles")}</span>
      ) : null}
    </div>
  );
}

interface RowActionsProps {
  member: OrgMember;
  displayName: string;
  onRemove: (m: OrgMember) => void;
}

function RowActions({
  member,
  displayName,
  onRemove,
}: RowActionsProps): React.ReactElement {
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Flip the menu above the trigger when the row sits near the viewport
  // bottom (otherwise the menu opens off-screen).
  const [openUp, setOpenUp] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        !menuRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div className="relative inline-block" ref={menuRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t(`Actions for ${displayName}`)}
        onClick={() => {
          const r = menuRef.current?.getBoundingClientRect();
          if (r) setOpenUp(window.innerHeight - r.bottom < 64);
          setMenuOpen((o) => !o);
        }}
      >
        <MoreVertical className="h-4 w-4" aria-hidden="true" />
      </Button>
      {menuOpen ? (
        <div
          role="menu"
          className={cn(
            "absolute right-0 z-10 w-44 rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md",
            openUp ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onRemove(member);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <UserMinus className="h-4 w-4" aria-hidden="true" />
            {t("Remove member")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

interface MemberRowProps {
  member: OrgMember;
  canManage: boolean;
  onRemove: (m: OrgMember) => void;
}

function MemberRow({
  member,
  canManage,
  onRemove,
}: MemberRowProps): React.ReactElement {
  const isOwner = Boolean(member.is_org_owner);
  const displayName = member.full_name?.trim() || member.email;
  const isActive = member.is_active !== false;
  const am = activityMeta(isActive);

  return (
    <tr
      className="border-t border-border transition-colors hover:bg-accent/40"
      data-testid={`member-row-${member.user_id}`}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar email={member.email} name={member.full_name} />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">
              {displayName}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {member.email}
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <MemberRoles member={member} />
      </td>
      <td className="px-4 py-3">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
            am.badge,
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", am.dot)} />
          {t(am.label)}
        </span>
      </td>
      <td className="px-4 py-3 font-tabular text-sm text-muted-foreground">
        <span title={member.joined_at}>{relativeJoined(member.joined_at)}</span>
      </td>
      <td className="px-4 py-3 text-right">
        {canManage && !isOwner ? (
          <RowActions
            member={member}
            displayName={displayName}
            onRemove={onRemove}
          />
        ) : null}
      </td>
    </tr>
  );
}

function MemberCard({
  member,
  canManage,
  onRemove,
}: MemberRowProps): React.ReactElement {
  const isOwner = Boolean(member.is_org_owner);
  const displayName = member.full_name?.trim() || member.email;
  const isActive = member.is_active !== false;
  const am = activityMeta(isActive);

  return (
    <div
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      data-testid={`member-row-${member.user_id}`}
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
        {canManage && !isOwner ? (
          <RowActions
            member={member}
            displayName={displayName}
            onRemove={onRemove}
          />
        ) : null}
      </div>
      <div className="mt-3">
        <MemberRoles member={member} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium",
            am.badge,
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", am.dot)} />
          {t(am.label)}
        </span>
        <span className="font-tabular" title={member.joined_at}>
          {t("Joined")} {relativeJoined(member.joined_at)}
        </span>
      </div>
    </div>
  );
}

function relativeJoined(joinedAt: string): string {
  const then = new Date(joinedAt).getTime();
  if (Number.isNaN(then)) return joinedAt;
  const diffMs = then - Date.now();
  const absSeconds = Math.abs(diffMs) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  // Pick the largest sensible unit.
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["week", 60 * 60 * 24 * 7],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  for (const [unit, sec] of units) {
    if (absSeconds >= sec) {
      return rtf.format(Math.round(diffMs / 1000 / sec), unit);
    }
  }
  return rtf.format(Math.round(diffMs / 1000), "second");
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
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
  );
}

function EmptyState({
  canInvite,
  onInvite,
}: {
  canInvite: boolean;
  onInvite: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
      <UserPlus className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
      <div>
        <h3 className="text-base font-semibold">{t("No members yet")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Invite teammates to collaborate.")}
        </p>
      </div>
      {canInvite ? (
        <Button onClick={onInvite}>{t("Invite a member")}</Button>
      ) : null}
    </div>
  );
}

function NoPermissionCard(): React.ReactElement {
  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div>
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {t("Organization")}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
          {t("Members")}
        </h1>
      </div>
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">{t("No access")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("You can't view this organization's members.")}
        </p>
        <p
          role="status"
          data-testid="no-permission"
          className="mt-4 text-sm text-muted-foreground"
        >
          {t(
            "Ask an admin to enable the Member directory module for your role.",
          )}
        </p>
      </div>
    </div>
  );
}

export function MemberDirectoryPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  const user = useAuthStore((s) => s.user);
  const membership = user?.memberships.find((m) => m.org_slug === orgSlug);
  const { isMobile } = useBreakpoint();
  const effectiveModules = React.useMemo(
    () => new Set(membership?.effective_modules ?? []),
    [membership],
  );

  const canViewDirectory = effectiveModules.has(REQUIRED_MODULE);
  const isAdminish =
    Boolean(membership?.is_org_owner) ||
    (membership?.roles ?? []).some((r) => r === "admin");
  const canManage = isAdminish || effectiveModules.has(ADMIN_MODULE);

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [pendingRemoval, setPendingRemoval] = React.useState<OrgMember | null>(
    null,
  );
  const qc = useQueryClient();
  const toast = useToast();

  const membersQuery = useQuery({
    queryKey: ["org", orgSlug, "members"],
    queryFn: () => orgsApi.members(orgSlug),
    enabled: Boolean(orgSlug) && canViewDirectory,
  });

  const orgUuid = membership?.org_id ?? "";
  const removeMember = useMutation({
    mutationFn: (m: OrgMember) => {
      if (!orgUuid) {
        return Promise.reject(new Error("missing_org_uuid"));
      }
      return orgsApi.removeMember(orgUuid, m.id);
    },
    onSuccess: () => {
      toast.push({ kind: "success", title: t("Member removed") });
      qc.invalidateQueries({ queryKey: ["org", orgSlug, "members"] });
    },
    onError: () => {
      toast.push({ kind: "error", title: t("Could not remove member") });
    },
  });

  if (!canViewDirectory) {
    return <NoPermissionCard />;
  }

  const allMembers = unwrapList(membersQuery.data);
  const total = allMembers.length;

  const term = search.trim().toLowerCase();
  const filtered = term
    ? allMembers.filter((m) => {
        const haystack = `${m.full_name ?? ""} ${m.email}`.toLowerCase();
        return haystack.includes(term);
      })
    : allMembers;

  const onRemove = (m: OrgMember): void => {
    setPendingRemoval(m);
  };

  const confirmRemove = (): void => {
    if (!pendingRemoval) return;
    removeMember.mutate(pendingRemoval);
    setPendingRemoval(null);
  };

  const pendingName =
    pendingRemoval?.full_name?.trim() || pendingRemoval?.email || "";

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {t("Organization")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("Members")}
          </h1>
          <p className="mt-1 text-sm font-tabular text-muted-foreground">
            {membersQuery.isLoading
              ? t("Loading members...")
              : t(`${total} ${total === 1 ? "member" : "members"}`)}
          </p>
        </div>
        {canManage ? (
          <Button
            onClick={() => setInviteOpen(true)}
            data-testid="invite-button"
            className="shrink-0"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {t("Invite")}
          </Button>
        ) : null}
      </div>

      <section
        className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        aria-label={t("Active members")}
      >
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{t("Active members")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("People with access to this organization.")}
            </p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <label htmlFor="member-search" className="sr-only">
              {t("Search members")}
            </label>
            <Input
              id="member-search"
              type="search"
              placeholder={t("Search by name or email")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-8"
              data-testid="member-search"
            />
          </div>
        </div>

        <div className="p-4">
          {membersQuery.isLoading ? (
            <LoadingSkeleton />
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
            <EmptyState
              canInvite={canManage}
              onInvite={() => setInviteOpen(true)}
            />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <Users
                className="h-7 w-7 text-muted-foreground/40"
                aria-hidden="true"
              />
              <p className="text-sm text-muted-foreground">
                {t(`No members match "${search}".`)}
              </p>
            </div>
          ) : isMobile ? (
            <div
              className="flex flex-col gap-3"
              aria-label={t("Members table")}
              data-testid="members-table"
            >
              {filtered.map((m) => (
                <MemberCard
                  key={m.user_id}
                  member={m}
                  canManage={canManage}
                  onRemove={onRemove}
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
                    <th className="px-4 py-2.5 font-medium">{t("Person")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Roles")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Status")}</th>
                    <th className="px-4 py-2.5 font-medium">{t("Joined")}</th>
                    <th className="w-10 px-4 py-2.5" aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => (
                    <MemberRow
                      key={m.user_id}
                      member={m}
                      canManage={canManage}
                      onRemove={onRemove}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <InvitationsListPanel orgSlug={orgSlug} canManage={canManage} />

      <InviteCreateModal
        orgSlug={orgSlug}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />

      <Dialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        ariaLabel={t("Remove member")}
      >
        <DialogHeader>
          <DialogTitle>{t("Remove member")}</DialogTitle>
          <DialogDescription>
            {t(`Remove ${pendingName} from this organization?`)}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setPendingRemoval(null)}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={confirmRemove}
            data-testid="confirm-remove"
          >
            <UserMinus className="h-4 w-4" aria-hidden="true" />
            {t("Remove member")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
