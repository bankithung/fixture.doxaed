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
    // Hero heading: the brand lockup
    expect(
      screen.getByRole("heading", {
        name: /doxaed · fixture/i,
      }),
    ).toBeInTheDocument();
    // CTAs (top bar + hero) — at least one of each
    expect(screen.getAllByRole("link", { name: /sign in/i }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("link", { name: /sign up|create an account/i })
        .length,
    ).toBeGreaterThan(0);
    // Platform status: everything shipped is marked live, one next item
    expect(screen.getByText(/live today/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^Live$/).length).toBe(3);
    expect(screen.getByText(/ten sports, one chassis/i)).toBeInTheDocument();
    expect(screen.getByText(/school records & badges/i)).toBeInTheDocument();
    // Redesign sections: bento features + how-it-works
    expect(
      screen.getByRole("heading", {
        name: /everything you need to run a competition/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /three steps to matchday/i }),
    ).toBeInTheDocument();
    // Content sections: demos (sample data), schools, why strip, FAQ
    expect(
      screen.getByRole("heading", { name: /see it in action/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("scorer-demo")).toBeInTheDocument();
    expect(screen.getByTestId("bracket-demo")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /built for institutions/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /why fixture/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /questions, answered/i }),
    ).toBeInTheDocument();
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
