import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../AppShell";
import { useAuthStore } from "@/features/auth/authStore";
import { authApi } from "@/api/auth";
import type { Role, User } from "@/types/user";

function makeUser(roles: string[], modules: string[]): User {
  return {
    id: "u1",
    email: "owner@example.com",
    name: "Org Owner",
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
        roles: roles as Role[],
        is_org_owner: roles.includes("admin") || roles.length === 0,
        effective_modules: modules,
      },
    ],
  };
}

function LocationProbe(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderShellAt(path = "/o/acme/dashboard"): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route
              path="/o/:orgSlug/dashboard"
              element={<LocationProbe />}
            />
            <Route path="/login" element={<LocationProbe />} />
            <Route path="/me" element={<LocationProbe />} />
            <Route path="*" element={<LocationProbe />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({
    user: makeUser(
      ["admin"],
      ["org.member_directory", "org.audit_log"],
    ),
    bootstrapped: true,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clear();
});

describe("AppShell", () => {
  it("renders the brand wordmark linking to the landing page", () => {
    renderShellAt();
    const brand = screen.getByRole("link", { name: /^fixture$/i });
    expect(brand.getAttribute("href")).toBe("/");
  });

  it("admin renders Dashboard + Members + Permissions + Audit nav items", () => {
    renderShellAt();
    const primary = screen.getByRole("navigation", { name: /primary/i });
    expect(primary.textContent).toMatch(/dashboard/i);
    expect(primary.textContent).toMatch(/members/i);
    expect(primary.textContent).toMatch(/permissions/i);
    expect(primary.textContent).toMatch(/audit/i);
  });

  it("scorer sees the Scoring nav item", () => {
    useAuthStore.setState({
      user: makeUser(["match_scorer"], ["match.scoring_console"]),
      bootstrapped: true,
    });
    renderShellAt();
    const primary = screen.getByRole("navigation", { name: /primary/i });
    expect(primary.textContent).toMatch(/scoring/i);
  });

  it("non-admin viewer does NOT see the Permissions nav item", () => {
    useAuthStore.setState({
      user: makeUser(["viewer"], []),
      bootstrapped: true,
    });
    renderShellAt();
    const primary = screen.getByRole("navigation", { name: /primary/i });
    expect(primary.textContent).not.toMatch(/permissions/i);
  });

  it("opens the user menu and exposes profile + notifications + sign out", async () => {
    renderShellAt();
    const trigger = screen.getByRole("button", { name: /open user menu/i });
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: /user menu/i });
    expect(menu).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /my profile/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /notifications/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /sign out/i }),
    ).toBeInTheDocument();
  });

  it("Sign out calls authStore.logout and routes to /login", async () => {
    const logoutSpy = vi
      .spyOn(authApi, "logout")
      .mockResolvedValue(undefined as unknown as void);

    renderShellAt();
    await userEvent.click(
      screen.getByRole("button", { name: /open user menu/i }),
    );
    await userEvent.click(
      screen.getByRole("menuitem", { name: /sign out/i }),
    );

    expect(logoutSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("loc").textContent).toBe("/login"),
    );
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("nav falls back to last_active_org_slug when no slug is in the URL (DEFECT-F)", () => {
    // On /me the URL has no :orgSlug, but the user has a last-active org —
    // the primary nav should populate from that fallback so the user can
    // navigate back to the dashboard without using the wordmark.
    renderShellAt("/me");
    const primary = screen.getByRole("navigation", { name: /primary/i });
    expect(primary.textContent ?? "").toMatch(/dashboard/i);
  });

  it("mobile hamburger toggles the navigation drawer", async () => {
    renderShellAt();
    const hamburger = screen.getByRole("button", {
      name: /open navigation menu/i,
    });
    await userEvent.click(hamburger);
    expect(
      screen.getByRole("dialog", { name: /navigation menu/i }),
    ).toBeInTheDocument();
  });
});
