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
    // Desktop rail + mobile drawer both render the wordmark now that the
    // logo img is decorative (alt="") — both must point home.
    const brands = screen.getAllByRole("link", { name: /^fixture$/i });
    expect(brands.length).toBeGreaterThan(0);
    for (const brand of brands) {
      expect(brand.getAttribute("href")).toBe("/");
    }
  });

  it("workspace nav is just the Workspace group (Dashboard + Tournaments); no Admin group", () => {
    // Member/role management + audit moved INSIDE a tournament; the org-level
    // Admin group is gone from the primary nav even for an admin.
    renderShellAt();
    const primary = screen.getByRole("navigation", { name: /primary/i });
    expect(primary.textContent).toMatch(/workspace/i);
    expect(primary.textContent).toMatch(/dashboard/i);
    expect(primary.textContent).toMatch(/tournaments/i);
    expect(primary.textContent).not.toMatch(/\badmin\b/i);
    expect(primary.textContent).not.toMatch(/permissions/i);
    expect(primary.textContent).not.toMatch(/settings/i);
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

  it("tournament route shows the CONTEXTUAL tournament nav + fetches the name header", async () => {
    vi.spyOn(tournamentsApi, "get").mockResolvedValue({
      id: "t-123",
      slug: "spring-cup",
      name: "Spring Cup",
      status: "draft",
      organization_slug: "acme",
      sport_code: "football",
      sports: [],
      time_zone: "Asia/Kolkata",
      created_at: "2026-01-01T00:00:00Z",
    } satisfies Tournament);
    // A set-up tournament (stage "ready") shows the full sidebar app.
    vi.spyOn(tournamentsApi, "stage").mockResolvedValue({
      stage: "ready",
      status: "scheduled",
      order: ["setup", "org_registration", "team_registration", "members", "fixtures", "ready"],
      allowed_to: [],
      can_manage: true,
      rules_frozen_at: null,
      stages: [],
    } as never);

    useAuthStore.setState({
      user: makeUser(["admin"], ["forms"]),
      bootstrapped: true,
    });
    renderShellAt("/tournaments/t-123");

    const primary = await screen.findByRole("navigation", { name: /primary/i });
    // Once fixtures are generated (stage "ready") the sidebar is the operations
    // console — Operations-first, no setup-flow pages (ops 2026-06-26).
    expect(primary.textContent).toMatch(/operations/i);
    expect(primary.textContent).toMatch(/today/i);
    expect(primary.textContent).toMatch(/standings/i);
    expect(primary.textContent).not.toMatch(/institutions/i);
    // Name resolves into the rail identity header.
    await waitFor(() =>
      expect(screen.getAllByText(/spring cup/i).length).toBeGreaterThan(0),
    );
  });

  it("hides the sidebar for a MANAGED tournament mid-setup (focused flow, W2-C)", async () => {
    vi.spyOn(tournamentsApi, "get").mockResolvedValue({
      id: "t-123",
      slug: "spring-cup",
      name: "Spring Cup",
      status: "draft",
      organization_slug: "acme",
      sport_code: null,
      sports: [],
      time_zone: "Asia/Kolkata",
      created_at: "2026-01-01T00:00:00Z",
    } satisfies Tournament);
    vi.spyOn(tournamentsApi, "stage").mockResolvedValue({
      stage: "org_registration",
      status: "published",
      order: ["setup", "org_registration", "team_registration", "members", "fixtures", "ready"],
      allowed_to: [],
      can_manage: true,
      rules_frozen_at: null,
      stages: [],
    } as never);

    useAuthStore.setState({
      user: makeUser(["admin"], ["forms"]),
      bootstrapped: true,
    });
    renderShellAt("/tournaments/t-123");

    // Mid-setup, managers get the focused flow: no sidebar until the
    // tournament is ready (the previous test covers stage "ready" → full
    // SaaS shell with the rail).
    await screen.findAllByText(/spring cup/i);
    await waitFor(() =>
      expect(
        screen.queryByRole("navigation", { name: /primary/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it("keeps the sidebar for NON-managers even mid-setup", async () => {
    vi.spyOn(tournamentsApi, "get").mockResolvedValue({
      id: "t-123",
      slug: "spring-cup",
      name: "Spring Cup",
      status: "draft",
      organization_slug: "acme",
      sport_code: null,
      sports: [],
      time_zone: "Asia/Kolkata",
      created_at: "2026-01-01T00:00:00Z",
    } satisfies Tournament);
    vi.spyOn(tournamentsApi, "stage").mockResolvedValue({
      stage: "org_registration",
      status: "published",
      order: ["setup", "org_registration", "team_registration", "members", "fixtures", "ready"],
      allowed_to: [],
      can_manage: false,
      rules_frozen_at: null,
      stages: [],
    } as never);

    useAuthStore.setState({
      user: makeUser(["admin"], ["forms"]),
      bootstrapped: true,
    });
    renderShellAt("/tournaments/t-123");

    await screen.findAllByText(/spring cup/i);
    const primary = screen.getByRole("navigation", { name: /primary/i });
    expect(primary.textContent).toMatch(/overview/i);
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
