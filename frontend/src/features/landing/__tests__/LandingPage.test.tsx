import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { LandingPage } from "../LandingPage";
import { useAuthStore } from "@/features/auth/authStore";
import type { User } from "@/types/user";

function LocationProbe(): React.ReactElement {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderAt(path = "/"): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <LandingPage />
              <LocationProbe />
            </>
          }
        />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.getState().clear();
  useAuthStore.setState({ bootstrapped: true });
});
afterEach(() => {
  useAuthStore.getState().clear();
});

describe("LandingPage", () => {
  it("renders hero, CTAs and roadmap when unauthenticated", () => {
    renderAt();
    // Hero heading
    expect(
      screen.getByRole("heading", {
        name: /sports fixtures, made in nagaland\./i,
      }),
    ).toBeInTheDocument();
    // CTAs (top bar + hero) — at least one of each
    expect(screen.getAllByRole("link", { name: /sign in/i }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /sign up|create an account/i })
        .length,
    ).toBeGreaterThan(0);
    // Roadmap
    expect(screen.getByText(/what's coming/i)).toBeInTheDocument();
    expect(screen.getByText(/Phase 1A · shipping/i)).toBeInTheDocument();
    expect(screen.getByText(/Phase 1B · football/i)).toBeInTheDocument();
    expect(screen.getByText(/v2 · beyond football/i)).toBeInTheDocument();
    // Footer
    expect(screen.getByRole("link", { name: /^about$/i })).toBeInTheDocument();
  });

  it("redirects authenticated users to the personal dashboard (root pages are individual-level)", () => {
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
          is_org_owner: true,
          effective_modules: [],
        },
      ],
    };
    useAuthStore.setState({ user, bootstrapped: true });
    renderAt();
    // Even an org admin lands on the personal dashboard — roles only shape
    // the experience inside a tournament (owner decision 2026-06-11).
    expect(screen.getByTestId("loc").textContent).toBe("/orgs");
  });

  it("redirects authenticated users without an active slug to /orgs", () => {
    const user: User = {
      id: "u1",
      email: "x@example.com",
      name: "User",
      is_superuser: false,
      has_2fa_enrolled: false,
      twofa_enrolled_at: null,
      email_verified_at: "2025-01-01T00:00:00Z",
      last_active_org_id: null,
      last_active_org_slug: null,
      deleted_at: null,
      memberships: [],
    };
    useAuthStore.setState({ user, bootstrapped: true });
    renderAt();
    expect(screen.getByTestId("loc").textContent).toBe("/orgs");
  });
});
