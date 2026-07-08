import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { LoginPage } from "../LoginPage";
import { useAuthStore } from "../authStore";
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
  memberships: [],
};

function LocationProbe(): React.ReactElement {
  const loc = useLocation();
  return (
    <div data-testid="loc">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

function renderAt(path = "/login"): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/login"
          element={
            <>
              <LoginPage />
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
  useAuthStore.setState({ bootstrapped: true, error: null });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("LoginPage", () => {
  it("renders the brand wordmark, tagline, and form labels", () => {
    renderAt();
    // Brand panel renders the platform name (it's hidden via .lg:hidden on
    // mobile dupe + .hidden on the aside, but jsdom still mounts both).
    expect(screen.getAllByText(/Fixture Platform/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Doxaed · Fixture/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /forgot password\?/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /create an account/i }),
    ).toBeInTheDocument();
  });

  it("submits credentials and routes via pickLandingPathForUser by default", async () => {
    // Mock user has no memberships → pickLandingPathForUser returns /orgs
    // (the chooser). Previously this fell back to "/"; now post-login uses
    // role-aware routing per CLAUDE.md spec / B5 deliverable.
    vi.spyOn(authApi, "login").mockResolvedValue({ user });
    renderAt("/login");
    await userEvent.type(screen.getByLabelText(/email/i), "x@example.com");
    await userEvent.type(screen.getByLabelText(/^password$/i), "hunter22hunter");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByTestId("loc").textContent).toBe("/orgs");
    });
  });

  it("honours ?next= when present", async () => {
    vi.spyOn(authApi, "login").mockResolvedValue({ user });
    renderAt("/login?next=/o/acme/dashboard");
    await userEvent.type(screen.getByLabelText(/email/i), "x@example.com");
    await userEvent.type(screen.getByLabelText(/^password$/i), "hunter22hunter");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByTestId("loc").textContent).toBe(
        "/o/acme/dashboard",
      );
    });
  });

  it("renders TOTP form when login requires 2FA", async () => {
    vi.spyOn(authApi, "login").mockResolvedValue({ requires_2fa: true });
    renderAt();
    await userEvent.type(screen.getByLabelText(/email/i), "x@example.com");
    await userEvent.type(screen.getByLabelText(/^password$/i), "hunter22hunter");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      expect(screen.getByLabelText(/authentication code/i)).toBeInTheDocument();
    });
  });

  it("renders error banner with role=alert when store has error", async () => {
    useAuthStore.setState({ error: "Invalid credentials" });
    renderAt();
    expect(screen.getByRole("alert").textContent).toMatch(
      /invalid credentials/i,
    );
  });

  it("ignores ?next when it points off-site (falls back to role-aware landing)", async () => {
    vi.spyOn(authApi, "login").mockResolvedValue({ user });
    renderAt("/login?next=https://evil.example.com/x");
    await userEvent.type(screen.getByLabelText(/email/i), "x@example.com");
    await userEvent.type(screen.getByLabelText(/^password$/i), "hunter22hunter");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() => {
      // Off-site `next` is rejected; falls through to pickLandingPathForUser,
      // which routes a no-memberships user to the org chooser.
      expect(screen.getByTestId("loc").textContent).toBe("/orgs");
    });
  });
});
