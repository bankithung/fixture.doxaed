import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { OrgDashboardPage } from "../OrgDashboardPage";
import { useAuthStore } from "@/features/auth/authStore";
import { tournamentsApi } from "@/api/tournaments";
import type { User } from "@/types/user";

vi.mock("@/api/tournaments", () => ({
  tournamentsApi: { list: vi.fn(), matches: vi.fn() },
}));

function makeUser(roles: string[]): User {
  return {
    id: "u1",
    email: "x@example.com",
    name: "Test User",
    is_superuser: false,
    has_2fa_enrolled: false,
    twofa_enrolled_at: null,
    email_verified_at: null,
    last_active_org_id: "o1",
    last_active_org_slug: "acme",
    memberships: [
      {
        org_id: "o1",
        org_slug: "acme",
        org_name: "Acme FC",
        roles: roles as User["memberships"][number]["roles"],
        is_org_owner: roles.includes("admin"),
        effective_modules: [],
      },
    ],
    deleted_at: null,
  };
}

function tn(over: Record<string, unknown>) {
  return {
    id: "t1",
    slug: "coal-cup",
    name: "Coal Cup",
    status: "published",
    organization_slug: "acme",
    sport_code: "football",
    time_zone: "UTC",
    created_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/o/acme/dashboard"]}>
          <Routes>
            <Route path="/o/:orgSlug/dashboard" element={<OrgDashboardPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(tournamentsApi.list).mockResolvedValue([
    tn({ id: "t1", name: "Coal Cup", slug: "coal-cup", status: "published" }),
    tn({ id: "t2", name: "U-15 League", slug: "u15", status: "live_first_half" }),
  ] as never);
  vi.mocked(tournamentsApi.matches).mockResolvedValue([] as never);
  useAuthStore.setState({ user: makeUser(["admin"]), bootstrapped: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clear();
});

describe("OrgDashboardPage", () => {
  it("renders org name and role pill", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Acme FC");
    expect(screen.getByTestId("role-pill").textContent).toMatch(/admin/i);
  });

  it("shows the KPI strip", () => {
    renderPage();
    expect(screen.getByTestId("kpi-strip")).toBeInTheDocument();
  });

  it("lists tournaments from the API", async () => {
    renderPage();
    expect(await screen.findByText("Coal Cup")).toBeInTheDocument();
    expect(screen.getByText("U-15 League")).toBeInTheDocument();
  });

  it("filters the table by search", async () => {
    renderPage();
    await screen.findByText("Coal Cup");
    await userEvent.type(screen.getByLabelText(/search tournaments/i), "u-15");
    expect(screen.queryByText("Coal Cup")).toBeNull();
    expect(screen.getByText("U-15 League")).toBeInTheDocument();
  });

  it("does not show a coming-soon teaser strip", () => {
    renderPage();
    expect(screen.queryByTestId("phase1b-teaser")).toBeNull();
  });

  it("opens the feedback modal from the quick action", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /send feedback/i }));
    const dialog = screen.getByRole("dialog", { name: /send feedback/i });
    expect(within(dialog).getByLabelText(/feedback message/i)).toBeInTheDocument();
  });

  it("falls back to the slug when membership is missing", () => {
    useAuthStore.setState({
      user: { ...makeUser(["admin"]), memberships: [] },
      bootstrapped: true,
    });
    renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("acme");
  });
});
