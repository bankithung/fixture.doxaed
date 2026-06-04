import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrgSwitcher } from "../OrgSwitcher";
import { useAuthStore } from "@/features/auth/authStore";
import { authApi } from "@/api/auth";
import type { User } from "@/types/user";

const user: User = {
  id: "u1",
  email: "x@example.com",
  name: "User",
  is_superuser: false,
  has_2fa_enrolled: false,
  twofa_enrolled_at: null,
  email_verified_at: "2025-01-01T00:00:00Z",
  last_active_org_id: "o1",
  last_active_org_slug: "acme",
  deleted_at: null,
  memberships: [
    {
      org_id: "o1",
      org_slug: "acme",
      org_name: "Acme",
      roles: ["admin"],
      is_org_owner: false,
      effective_modules: [],
    },
    {
      org_id: "o2",
      org_slug: "globex",
      org_name: "Globex",
      roles: ["match_scorer", "referee"],
      is_org_owner: false,
      effective_modules: [],
    },
  ],
};

function LocationProbe(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderWithRouter(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/o/acme/dashboard"]}>
        <Routes>
          <Route
            path="/o/:orgSlug/dashboard"
            element={
              <>
                <OrgSwitcher />
                <LocationProbe />
              </>
            }
          />
          <Route
            path="*"
            element={
              <>
                <OrgSwitcher />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user, bootstrapped: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clear();
});

describe("OrgSwitcher", () => {
  it("PATCHes /me/ with last_active_org_id and navigates on switch", async () => {
    const patchSpy = vi
      .spyOn(authApi, "patchMe")
      .mockResolvedValue(user);

    renderWithRouter();
    const select = screen.getByRole("combobox", {
      name: /active organization/i,
    });

    await userEvent.selectOptions(select, "globex");

    expect(patchSpy).toHaveBeenCalledWith({ last_active_org_id: "o2" });
    expect(screen.getByTestId("loc").textContent).toBe("/o/globex/dashboard");
  });

  it("renders role radiogroup only when membership has multiple roles", () => {
    renderWithRouter();
    // Acme (active) has 1 role -> no radiogroup.
    expect(
      screen.queryByRole("radiogroup", { name: /active role view/i }),
    ).toBeNull();
  });
});
