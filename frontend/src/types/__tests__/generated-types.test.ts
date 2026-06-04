/**
 * Compile-time smoke test for the OpenAPI -> TypeScript pipeline.
 *
 * If `npm run gen:types` runs successfully and the schema still ships a
 * `Me` component with the canonical fields, this file type-checks. If the
 * backend serializer is renamed/dropped or the generation step is broken,
 * the project's `tsc` step fails here first — that is the point.
 *
 * The runtime assertion is trivial; the value of this test is the type
 * pressure it puts on `api.generated.ts`.
 */
import { describe, it, expect } from "vitest";
import type {
  ApiUser,
  ApiOrganization,
  ApiMembership,
  ApiModule,
  ApiRole,
  ApiGrantState,
} from "@/types/generated";

describe("OpenAPI generated types", () => {
  it("exposes the canonical /me/ fields with the expected runtime shapes", () => {
    // Fully literal value — types are checked at compile time, not runtime.
    const me: ApiUser = {
      id: "00000000-0000-0000-0000-000000000000",
      email: "user@example.com",
      name: "Test User",
      is_superuser: false,
      has_2fa_enrolled: false,
      twofa_enrolled_at: null,
      email_verified_at: null,
      last_active_org_id: null,
      last_active_org_slug: null,
      memberships: [],
      deleted_at: null,
    };

    expect(me.id).toBe("00000000-0000-0000-0000-000000000000");
    expect(me.email).toContain("@");
    expect(me.has_2fa_enrolled).toBe(false);
  });

  it("preserves the OrganizationMembership shape from the schema", () => {
    const mem: ApiMembership = {
      id: "00000000-0000-0000-0000-000000000001",
      user: "00000000-0000-0000-0000-000000000002",
      organization: "00000000-0000-0000-0000-000000000003",
      role: "admin" satisfies ApiRole,
      is_org_owner: false,
      is_active: true,
      created_at: "2026-05-02T00:00:00Z",
      removed_at: null,
    };
    expect(mem.role).toBe("admin");
    expect(mem.is_active).toBe(true);
  });

  it("models Organization and Module records", () => {
    const org: ApiOrganization = {
      id: "00000000-0000-0000-0000-000000000004",
      slug: "demo",
      name: "Demo Org",
      status: "active",
      time_zone: "Asia/Kolkata",
      created_at: "2026-05-02T00:00:00Z",
      archived_at: null,
      suspended_at: null,
      suspended_reason: "",
    };
    const mod: ApiModule = {
      id: "00000000-0000-0000-0000-000000000005",
      code: "tournament.scoring_console",
      name: "Scoring console",
      description: "Live scoring UI for referees and scorers.",
      category: "tournament",
      default_for_roles: ["match_scorer", "referee"],
    };
    expect(org.status).toBe("active");
    expect(mod.code).toContain(".");
  });

  it("constrains the grant-state enum to default | grant | deny", () => {
    const states: ApiGrantState[] = ["default", "grant", "deny"];
    expect(states).toHaveLength(3);
  });
});
