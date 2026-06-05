import { api } from "./client";
import type { OrgInvitation, Role } from "@/types/user";
import type { components } from "@/types/api.generated";
import type { Paginated } from "@/types/api";

type Schemas = components["schemas"];

/**
 * Organization row as returned by `GET /api/orgs/` and `GET /api/orgs/{id}/`
 * (see `OrganizationSerializer`). Re-exported from the OpenAPI codegen so
 * field renames in the backend surface as TypeScript errors automatically.
 */
export type Organization = Schemas["Organization"];

/**
 * Membership row as returned by the (currently unused on the FE) plain
 * `OrganizationMembershipSerializer`. Provided for the
 * `acceptInvitation` response shape only.
 */
export type Membership = Schemas["OrganizationMembership"];

/**
 * Member-row payload from `GET /api/orgs/{slug}/members/` (see
 * `OrgMemberDetailSerializer`). All fields required by the backend.
 *
 * `roles` is intentionally widened to `string[]` — the catalog includes
 * future role strings the FE narrow `Role` union might lag on.
 */
export interface OrgMember {
  /** Server-side membership row id (UUID). The DELETE route uses this. */
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  /** Widened to `string[]` for v1Users module catalog roles. */
  roles: string[];
  /** True if this membership owns the org. */
  is_org_owner: boolean;
  joined_at: string;
  is_active: boolean;
}

/** Invitation list item — matches the backend list shape (subset of full). */
export interface InvitationListItem {
  id: string;
  email: string;
  roles: string[];
  status: "pending" | "accepted" | "expired" | "revoked";
  expires_at: string;
  invited_by_email: string;
  /** Token is only ever returned at creation, never on list responses. */
  token?: string;
}

/**
 * The members endpoint may be served as a plain array (per the v1Users
 * spec) OR as a DRF `Paginated<T>` envelope (some routers wrap by default).
 * We accept both at the API boundary and let the page normalise.
 */
export type MembersResponse = OrgMember[] | Paginated<OrgMember>;
export type InvitationsResponse =
  | InvitationListItem[]
  | Paginated<InvitationListItem>;

export const orgsApi = {
  /**
   * `GET /api/orgs/` returns a list of `Organization` rows the user can
   * see (super-admin: all active; otherwise: orgs they are a member of).
   */
  list: () => api.get<Organization[]>("/api/orgs/"),
  members: (slug: string) =>
    api.get<MembersResponse>(`/api/orgs/${slug}/members/`),
  invitations: (slug: string) =>
    api.get<InvitationsResponse>(`/api/orgs/${slug}/invitations/`),
  createInvitation: (
    slug: string,
    payload: { email: string; roles: string[]; event_id: string },
  ) =>
    api.post<OrgInvitation>(`/api/orgs/${slug}/invitations/`, payload),
  revokeInvitation: (slug: string, id: string) =>
    api.delete<void>(`/api/orgs/${slug}/invitations/${id}/`),
  acceptInvitation: (
    token: string,
    opts?: { password?: string; name?: string },
  ) =>
    api.post<{ org_slug: string | null; tournament_id: string | null }>(
      "/api/orgs/invitations/accept/",
      { token, ...(opts ?? {}) },
    ),
  /**
   * Remove a member from an org. Backend has only the UUID-routed delete:
   * `DELETE /api/orgs/{org_uuid}/members/{membership_id}/`. The membership
   * id (NOT user id) is required — it is the row primary key, available
   * as `OrgMember.id`.
   */
  removeMember: (orgUuid: string, membershipId: string) =>
    api.delete<void>(`/api/orgs/${orgUuid}/members/${membershipId}/`),
  /**
   * Transfer ownership. Backend serializer (`TransferOwnershipSerializer`)
   * canonical field is `new_owner_user_id`.
   */
  transferOwnership: (
    slug: string,
    payload: {
      new_owner_user_id: string;
      reason: string;
      event_id: string;
      conflict_acknowledged?: boolean;
    },
  ) =>
    api.post<{ ok: true }>(
      `/api/orgs/${slug}/ownership/transfer/`,
      payload,
    ),
};

/** Normalise either a list or a Paginated envelope into a flat array. */
export function unwrapList<T>(
  res: T[] | Paginated<T> | undefined | null,
): T[] {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  return res.results ?? [];
}

/** Re-export so callers don't need a separate `Role` import path. */
export type { Role };
