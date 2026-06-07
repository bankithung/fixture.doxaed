import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppShell } from "../AppShell";
import { useAuthStore } from "@/features/auth/authStore";
import { authApi } from "@/api/auth";
import { tournamentsApi, type Tournament } from "@/api/tournaments";
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
            <Route path="/tournaments" element={<LocationProbe />} />
            <Route path="/tournaments/:id" element={<LocationProbe />} />
            <Route
              path="/tournaments/:id/bracket"
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

  it("admin renders Workspace + Admin groups (Dashboard/Members/Permissions/Audit/Settings)", () => {
    renderShellAt();
    const primary = screen.getByRole("navigation", { name: /primary/i });
    expect(primary.textContent).toMatch(/workspace/i);
    expect(primary.textContent).toMatch(/admin/i);
    expect(primary.textContent).toMatch(/dashboard/i);
    expect(primary.textContent).toMatch(/members/i);
    expect(primary.textContent).toMatch(/permissions/i);
    expect(primary.textContent).toMatch(/audit/i);
    expect(primary.textContent).toMatch(/settings/i);
  });

  it("workspace nav no longer surfaces the standalone Scoring item", () => {
    // Org-level Scoring was a Phase-1A placeholder; it's dropped from the
    // primary workspace nav (per-match scoring is reached from Overview).
    useAuthStore.setState({
      user: makeUser(["match_scorer"], ["match.scoring_console"]),
      bootstrapped: true,
    });
    renderShellAt();
    const primary = screen.getByRole("navigation", { name: /primary/i });
    expect(primary.textContent).not.toMatch(/scoring/i);
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

  it("tournament route switches to the Manage group + fetches the name header", async () => {
    vi.spyOn(tournamentsApi, "get").mockResolvedValue({
      id: "t-123",
      slug: "spring-cup",
      name: "Spring Cup",
      status: "draft",
      organization_slug: "acme",
      sport_code: "football",
      time_zone: "Asia/Kolkata",
      created_at: "2026-01-01T00:00:00Z",
    } satisfies Tournament);

    useAuthStore.setState({
      user: makeUser(["admin"], ["forms"]),
      bootstrapped: true,
    });
    renderShellAt("/tournaments/t-123");

    const primary = screen.getByRole("navigation", { name: /primary/i });
    // Manage group with the three tournament destinations.
    expect(primary.textContent).toMatch(/manage/i);
    expect(primary.textContent).toMatch(/overview/i);
    expect(primary.textContent).toMatch(/registration forms/i);
    expect(primary.textContent).toMatch(/fixtures & bracket/i);
    // "All tournaments" back-link is present.
    expect(
      screen.getAllByRole("link", { name: /all tournaments/i }).length,
    ).toBeGreaterThan(0);
    // Workspace-only items are gone in tournament mode.
    expect(primary.textContent).not.toMatch(/members/i);
    // Name resolves asynchronously into the rail header.
    await waitFor(() =>
      expect(screen.getAllByText(/spring cup/i).length).toBeGreaterThan(0),
    );
  });

  it("/tournaments/new is NOT treated as a tournament context", () => {
    const getSpy = vi.spyOn(tournamentsApi, "get");
    renderShellAt("/tournaments/new");
    const primary = screen.getByRole("navigation", { name: /primary/i });
    // Workspace mode: the Workspace group + Dashboard remain.
    expect(primary.textContent).toMatch(/workspace/i);
    expect(primary.textContent).toMatch(/dashboard/i);
    expect(primary.textContent).not.toMatch(/manage/i);
    expect(getSpy).not.toHaveBeenCalled();
  });
});
