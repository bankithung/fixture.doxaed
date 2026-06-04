/**
 * User / Org / Module domain types. Mirrors backend serialisers exactly.
 *
 * Where possible the canonical types are re-exported from
 * `./api.generated.ts` (drf-spectacular OpenAPI codegen) so backend changes
 * surface as TypeScript errors instead of silent runtime drift. The
 * remaining hand-written types here are app-only conveniences (e.g. card
 * keys, role-narrowed cell payloads) that don't map 1:1 to a serializer.
 */

import type { components } from "./api.generated";

type Schemas = components["schemas"];

// ---------------------------------------------------------------------------
// Roles (canonical to backend `MembershipRole` enum, see
// `backend/apps/organizations/models.py`).
// ---------------------------------------------------------------------------

/**
 * v1Users.md §2.7 / `MembershipRole` TextChoices. NOTE: `is_org_owner` is
 * a separate boolean on memberships and NOT a role value.
 */
export type Role = Schemas["RoleEnum"];

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

/** v1Users.md Appendix A.2: 22 modules total. */
export type ModuleScope = "org" | "tournament" | "match" | "platform";

export interface ModuleDef {
  /** Stable string key — e.g. "tournament.scoring_console". */
  key: string;
  scope: ModuleScope;
  label: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Memberships (per-org, per-user; aggregated from MeSerializer).
// ---------------------------------------------------------------------------

/**
 * One per-org membership row as returned by `MeSerializer.memberships[]`
 * (see `backend/apps/accounts/serializers.py: MembershipSummarySerializer`).
 *
 * NOTE: the backend aggregates multiple membership rows into a single
 * per-org entry — `roles` is the distinct list of role strings the user
 * holds in this org, and `is_org_owner` is OR-of all rows.
 */
export interface OrgMembership {
  org_id: string;
  org_slug: string;
  org_name: string;
  /** All role strings this user holds in this org (already de-duplicated). */
  roles: Role[];
  is_org_owner: boolean;
  /** Set of module keys effective for this user in this org. */
  effective_modules: string[];
  /** Active role view (Appendix B.20 nuance). Client-only field. */
  active_role?: Role;
}

// ---------------------------------------------------------------------------
// User — exact mirror of `MeSerializer` output.
// ---------------------------------------------------------------------------

/**
 * Authenticated user as returned by `GET /api/accounts/me/` and
 * `PATCH /api/accounts/me/`.
 *
 * Field set is locked by `MeSerializer` (`backend/apps/accounts/serializers.py`).
 * The hand-written `OrgMembership[]` above is a structural superset of
 * `Schemas["MembershipSummary"]` (it adds the optional client-only
 * `active_role`) so we cannot use the generated `Me` shape directly without
 * losing that field.
 */
export interface User {
  id: string;
  email: string;
  /** May be empty string. */
  name: string;
  is_superuser: boolean;
  has_2fa_enrolled: boolean;
  twofa_enrolled_at: string | null;
  email_verified_at: string | null;
  last_active_org_id: string | null;
  last_active_org_slug: string | null;
  memberships: OrgMembership[];
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Module-grant matrix
// ---------------------------------------------------------------------------

/** v1Users.md Appendix B.16: 3-state per-cell control. */
export type GrantState = "default" | "grant" | "deny";

export interface MembershipModuleGrant {
  user_id: string;
  module_key: string;
  state: Exclude<GrantState, "default">;
  reason?: string;
  set_by_user_id: string;
  set_at: string;
}

export interface ModuleMatrixRow {
  user_id: string;
  user_email: string;
  user_full_name: string;
  roles: Role[];
  /** key -> "default" | "grant" | "deny" | undefined (= role default). */
  cells: Record<string, GrantState>;
  /** key -> boolean: would the user's role grant this by default? */
  role_defaults: Record<string, boolean>;
}

/**
 * v1Users.md Appendix B.16 — aggregate response shape for the matrix
 * endpoint. The backend returns BOTH the module catalog AND the rows in
 * one round-trip so the table renders without a join on the client.
 */
export interface ModuleMatrixResponse {
  modules: ModuleDef[];
  members: ModuleMatrixRow[];
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface OrgInvitation {
  id: string;
  org_id: string;
  email: string;
  roles: Role[];
  token?: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  invited_by_email: string;
  expires_at: string;
}
