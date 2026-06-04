import * as React from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreVertical, Search, UserMinus, UserPlus } from "lucide-react";
import { orgsApi, unwrapList, type OrgMember } from "@/api/orgs";
import { useAuthStore } from "@/features/auth/authStore";
import { useToast } from "@/components/ui/toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/Avatar";
import { RoleBadge } from "@/components/ui/RoleBadge";
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

interface MemberRowProps {
  member: OrgMember;
  canManage: boolean;
  onRemove: (m: OrgMember) => void;
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

function MemberRow({
  member,
  canManage,
  onRemove,
}: MemberRowProps): React.ReactElement {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const isOwner = Boolean(member.is_org_owner);
  const displayName = member.full_name?.trim() || member.email;
  const joinedDate = new Date(member.joined_at);
  const joinedTitle = Number.isNaN(joinedDate.getTime())
    ? member.joined_at
    : joinedDate.toLocaleString();

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
    <tr
      className="border-b last:border-b-0 hover:bg-muted/40"
      data-testid={`member-row-${member.user_id}`}
    >
      <td className="py-3 pr-3">
        <div className="flex items-center gap-3">
          <Avatar email={member.email} name={member.full_name} />
          <div className="min-w-0">
            <div className="truncate font-semibold">
              {displayName}
              {member.is_active === false ? (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  ({t("inactive")})
                </span>
              ) : null}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {member.email}
            </div>
          </div>
        </div>
      </td>
      <td className="py-3 pr-3">
        <div className="flex flex-wrap gap-1">
          {isOwner ? <RoleBadge role="owner" isOwner /> : null}
          {(member.roles ?? [])
            .filter((r) => r !== "owner")
            .map((r) => (
              <RoleBadge key={r} role={r} />
            ))}
          {(!member.roles || member.roles.length === 0) && !isOwner ? (
            <span className="text-xs text-muted-foreground">
              {t("No roles")}
            </span>
          ) : null}
        </div>
      </td>
      <td className="py-3 pr-3 text-sm text-muted-foreground">
        <span title={joinedTitle}>{relativeJoined(member.joined_at)}</span>
      </td>
      <td className="py-3 pr-1 text-right">
        {canManage && !isOwner ? (
          <div className="relative inline-block" ref={menuRef}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t(`Actions for ${displayName}`)}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <MoreVertical className="h-4 w-4" aria-hidden="true" />
            </Button>
            {menuOpen ? (
              <div
                role="menu"
                className="absolute right-0 z-10 mt-1 w-44 rounded-md border bg-popover p-1 text-sm shadow-md"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onRemove(member);
                  }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-destructive hover:bg-destructive/10"
                >
                  <UserMinus className="h-4 w-4" aria-hidden="true" />
                  {t("Remove member")}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">{t("Loading members...")}</span>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-md border p-3"
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
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed p-10 text-center">
      <UserPlus
        className="h-8 w-8 text-muted-foreground"
        aria-hidden="true"
      />
      <div>
        <h3 className="text-base font-semibold">{t("No members yet")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Invite teammates to collaborate on this organization.")}
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
    <div className="flex flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Members")}</CardTitle>
          <CardDescription>
            {t(
              "You don't have permission to view this organization's members.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p
            role="status"
            data-testid="no-permission"
            className="text-sm text-muted-foreground"
          >
            {t(
              "Ask an organization admin to enable the Member directory module for your role.",
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export function MemberDirectoryPage(): React.ReactElement {
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  const user = useAuthStore((s) => s.user);
  const membership = user?.memberships.find((m) => m.org_slug === orgSlug);
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
    const displayName = m.full_name?.trim() || m.email;
    if (
      typeof window !== "undefined" &&
      !window.confirm(t(`Remove ${displayName} from this organization?`))
    ) {
      return;
    }
    removeMember.mutate(m);
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("Members")}</h1>
          <p className="text-sm text-muted-foreground">
            {membersQuery.isLoading
              ? t("Loading members...")
              : t(`${total} ${total === 1 ? "member" : "members"}`)}
          </p>
        </div>
        {canManage ? (
          <Button
            onClick={() => setInviteOpen(true)}
            data-testid="invite-button"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {t("Invite")}
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between sm:space-y-0">
          <div>
            <CardTitle>{t("Active members")}</CardTitle>
            <CardDescription>
              {t("People with access to this organization.")}
            </CardDescription>
          </div>
          <div className="relative w-full sm:w-72">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
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
              className="pl-8"
              data-testid="member-search"
            />
          </div>
        </CardHeader>
        <CardContent>
          {membersQuery.isLoading ? (
            <LoadingSkeleton />
          ) : membersQuery.isError ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
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
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t(`No members match "${search}".`)}
            </p>
          ) : (
            <div className={cn("overflow-x-auto")}>
              <table
                className="w-full text-sm"
                aria-label={t("Members table")}
                data-testid="members-table"
              >
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{t("Person")}</th>
                    <th className="py-2 pr-3 font-medium">{t("Roles")}</th>
                    <th className="py-2 pr-3 font-medium">{t("Joined")}</th>
                    <th className="w-10 py-2 pr-1" aria-hidden="true" />
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
        </CardContent>
      </Card>

      <InvitationsListPanel orgSlug={orgSlug} canManage={canManage} />

      <InviteCreateModal
        orgSlug={orgSlug}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
    </div>
  );
}
