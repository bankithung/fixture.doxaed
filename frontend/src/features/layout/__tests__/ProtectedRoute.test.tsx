import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "../ProtectedRoute";
import { useAuthStore } from "@/features/auth/authStore";
import type { User } from "@/types/user";

function makeUser(memberships: User["memberships"]): User {
  return {
    id: "u1",
    email: "me@example.com",
    name: "Merithung",
    is_superuser: false,
    has_2fa_enrolled: false,
    twofa_enrolled_at: null,
    email_verified_at: null,
    last_active_org_id: null,
    last_active_org_slug: null,
    memberships,
    deleted_at: null,
  };
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/orgs" element={<div>chooser</div>} />
        <Route
          path="/tournaments/:id"
          element={
            <ProtectedRoute>
              <div>workspace</div>
            </ProtectedRoute>
          }
        />
        <Route
          path="/tournaments/:id/members"
          element={
            <ProtectedRoute>
              <div>members tab</div>
            </ProtectedRoute>
          }
        />
        <Route
          path="/o/:orgSlug/dashboard"
          element={
            <ProtectedRoute>
              <div>org dashboard</div>
            </ProtectedRoute>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: makeUser([]), bootstrapped: true });
});

afterEach(() => {
  useAuthStore.getState().clear();
});

describe("ProtectedRoute zero-org-membership gate", () => {
  it("lets an org-less user open a tournament workspace (invite-accepted case)", () => {
    renderAt("/tournaments/t-9");
    expect(screen.getByText("workspace")).toBeInTheDocument();
    expect(screen.queryByText("chooser")).not.toBeInTheDocument();
  });

  it("lets an org-less user open nested tournament pages", () => {
    renderAt("/tournaments/t-9/members");
    expect(screen.getByText("members tab")).toBeInTheDocument();
  });

  it("still bounces an org-less user off org-scoped pages", () => {
    renderAt("/o/acme/dashboard");
    expect(screen.getByText("chooser")).toBeInTheDocument();
    expect(screen.queryByText("org dashboard")).not.toBeInTheDocument();
  });
});
