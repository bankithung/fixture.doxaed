/**
 * Ergonomic re-exports of the auto-generated OpenAPI schema types.
 *
 * Source: `src/types/api.generated.ts` (produced by `npm run gen:types`).
 * Regenerate whenever a backend serializer changes — see CONTRACT.md.
 *
 * IMPORTANT: This file deliberately mirrors backend serialiser names. The
 * hand-written domain types in `./user.ts` are richer (e.g. they include
 * `memberships[]`, `last_active_org_slug`, `is_superuser`, `effective_modules`,
 * a `Role[]` array, etc.) which the current `MeSerializer` does not yet expose.
 * Once `MeSerializer` is widened to surface those fields (and a
 * `MembershipSummary` nested serializer is added), the hand-written types
 * here can be replaced wholesale by the generated ones. Until then, prefer
 * the generated alias for any field that already exists in the schema and
 * keep the hand-written type as the authoritative app-facing model.
 */
import type { components } from "./api.generated";

/** All schema components, indexed by name (e.g. `Schemas["Me"]`). */
export type Schemas = components["schemas"];

// --- /me/ -------------------------------------------------------------------
export type ApiUser = Schemas["Me"];
export type ApiPatchedUser = Schemas["PatchedMe"];

// --- Organizations & memberships -------------------------------------------
export type ApiOrganization = Schemas["Organization"];
export type ApiOrganizationCreate = Schemas["OrganizationCreate"];
export type ApiOrganizationStatus = Schemas["OrganizationStatusEnum"];
export type ApiMembership = Schemas["OrganizationMembership"];
export type ApiRole = Schemas["RoleEnum"];

// --- Modules / RBAC --------------------------------------------------------
export type ApiModule = Schemas["Module"];
export type ApiEffectiveModules = Schemas["EffectiveModules"];
export type ApiGrantInput = Schemas["GrantInput"];
export type ApiGrantRow = Schemas["GrantRow"];
export type ApiBulkGrants = Schemas["BulkGrants"];
export type ApiGrantState = Schemas["StateEnum"];

// --- Auth flows ------------------------------------------------------------
export type ApiLogin = Schemas["Login"];
export type ApiSignup = Schemas["Signup"];
export type ApiReauth = Schemas["Reauth"];
export type ApiVerifyEmail = Schemas["VerifyEmail"];
export type ApiPasswordResetRequest = Schemas["PasswordResetRequest"];
export type ApiPasswordResetComplete = Schemas["PasswordResetComplete"];
export type ApiTwoFAConfirm = Schemas["TwoFAConfirm"];
export type ApiTwoFAConfirmResponse = Schemas["TwoFAConfirmResponse"];
export type ApiTwoFADisable = Schemas["TwoFADisable"];
export type ApiTwoFAEnrollResponse = Schemas["TwoFAEnrollResponse"];

// --- Invitations -----------------------------------------------------------
export type ApiAcceptInvitation = Schemas["AcceptInvitation"];
export type ApiAdminInvitation = Schemas["AdminInvitation"];
export type ApiAdminInvitationCreate = Schemas["AdminInvitationCreate"];
export type ApiAdminInvitationStatus = Schemas["AdminInvitationStatusEnum"];
export type ApiRevokeInvitation = Schemas["RevokeInvitation"];

// --- Lifecycle / admin ops -------------------------------------------------
export type ApiArchive = Schemas["Archive"];
export type ApiSuspend = Schemas["Suspend"];
export type ApiSoftDelete = Schemas["SoftDelete"];
export type ApiChangeSlug = Schemas["ChangeSlug"];
export type ApiTransferOwnership = Schemas["TransferOwnership"];
