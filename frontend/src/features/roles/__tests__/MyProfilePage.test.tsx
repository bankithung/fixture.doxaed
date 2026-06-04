import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { MyProfilePage } from "../MyProfilePage";
import { useAuthStore } from "@/features/auth/authStore";
import type { User } from "@/types/user";

const baseUser: User = {
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
      roles: ["admin"],
      is_org_owner: true,
      effective_modules: [],
    },
    {
      org_id: "o2",
      org_slug: "globex",
      org_name: "Globex",
      roles: ["admin"],
      is_org_owner: false,
      effective_modules: [],
    },
  ],
};

function renderProfile(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/me"]}>
          <Routes>
            <Route path="/me" element={<MyProfilePage />} />
            <Route path="/login" element={<div data-testid="login" />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: baseUser, bootstrapped: true });
});

afterEach(() => {
  useAuthStore.getState().clear();
  vi.restoreAllMocks();
});

describe("MyProfilePage", () => {
  it("renders header with name, email, and computed initials", () => {
    renderProfile();
    expect(
      screen.getByRole("heading", { level: 1, name: /org owner/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    // "Org Owner" -> "OO"
    expect(screen.getByTestId("profile-avatar")).toHaveTextContent("OO");
  });

  it("renders all three sections (Account / Memberships / Security)", () => {
    renderProfile();
    expect(
      screen.getByRole("heading", { name: /^account$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /memberships/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /^security$/i }),
    ).toBeInTheDocument();
  });

  it("lists every membership with its roles and a switch link", () => {
    renderProfile();
    const list = screen.getByTestId("membership-list");
    expect(list).toHaveTextContent("Acme");
    expect(list).toHaveTextContent("Globex");
    expect(list).toHaveTextContent("admin");
    expect(
      screen.getByRole("link", { name: /switch to acme/i }),
    ).toHaveAttribute("href", "/o/acme/dashboard");
    expect(
      screen.getByRole("link", { name: /switch to globex/i }),
    ).toHaveAttribute("href", "/o/globex/dashboard");
  });

  it("offers Enable 2FA when has_2fa_enrolled=false", () => {
    renderProfile();
    expect(
      screen.getByRole("link", { name: /enable 2fa/i }),
    ).toHaveAttribute("href", "/2fa/enroll");
  });

  it("shows 'Enabled' chip when has_2fa_enrolled=true", () => {
    useAuthStore.setState({
      user: { ...baseUser, has_2fa_enrolled: true },
      bootstrapped: true,
    });
    renderProfile();
    expect(screen.getByTestId("2fa-status")).toHaveTextContent(/enabled/i);
  });

  it("links Change password to /password-reset", () => {
    renderProfile();
    expect(
      screen.getByRole("link", { name: /change password/i }),
    ).toHaveAttribute("href", "/password-reset");
  });

  it("renders Sign out everywhere button", () => {
    renderProfile();
    expect(screen.getByTestId("sign-out-everywhere")).toBeInTheDocument();
  });

  it("renders a status placeholder when user is not loaded yet", () => {
    useAuthStore.setState({ user: null, bootstrapped: true });
    renderProfile();
    expect(screen.getByRole("status")).toHaveTextContent(/loading profile/i);
  });
});
