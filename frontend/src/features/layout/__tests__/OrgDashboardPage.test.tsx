import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "@/components/ui/toast";
import { OrgDashboardPage } from "../OrgDashboardPage";
import { useAuthStore } from "@/features/auth/authStore";
import { MODULES } from "@/features/orgs/dashboardCards";
import type { User } from "@/types/user";

function makeUser(roles: string[], modules: string[]): User {
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
        is_org_owner: roles.includes("owner"),
        effective_modules: modules,
      },
    ],
    deleted_at: null,
  };
}

function renderPage(): void {
  render(
    <ToastProvider>
      <MemoryRouter initialEntries={["/o/acme/dashboard"]}>
        <Routes>
          <Route path="/o/:orgSlug/dashboard" element={<OrgDashboardPage />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({
    user: makeUser(
      ["admin"],
      [
        MODULES.ORG_MEMBER_DIRECTORY,
        MODULES.ORG_SETTINGS,
        MODULES.ORG_AUDIT_LOG,
        MODULES.ORG_TOURNAMENT_LIST,
        MODULES.ORG_BRANDING,
        MODULES.PERSONAL_NOTIFICATION_PREFS,
        MODULES.PERSONAL_FEEDBACK_WIDGET,
      ],
    ),
    bootstrapped: true,
  });
});

afterEach(() => {
  useAuthStore.getState().clear();
});

describe("OrgDashboardPage", () => {
  it("renders org name and role pill", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Acme FC",
    );
    const pill = screen.getByTestId("role-pill");
    expect(pill.textContent).toMatch(/admin/i);
  });

  it("admin sees the Members + Settings + Permissions + Audit + Branding cards", () => {
    renderPage();
    const grid = screen.getByTestId("dashboard-cards");
    const within_grid = within(grid);
    expect(
      within_grid.getByRole("link", { name: /member directory/i }),
    ).toBeInTheDocument();
    expect(
      within_grid.getByRole("link", { name: /org settings/i }),
    ).toBeInTheDocument();
    expect(
      within_grid.getByRole("link", { name: /module overrides/i }),
    ).toBeInTheDocument();
    expect(
      within_grid.getByRole("link", { name: /audit log/i }),
    ).toBeInTheDocument();
    expect(
      within_grid.getByRole("link", { name: /branding/i }),
    ).toBeInTheDocument();
    expect(
      within_grid.getByRole("link", { name: /my profile/i }),
    ).toBeInTheDocument();
  });

  it("Tournaments card links to the live tournaments hub", () => {
    renderPage();
    const link = screen.getByRole("link", { name: /tournaments/i });
    expect(link.getAttribute("href")).toBe("/tournaments");
  });

  it("scorer-only sees just Profile + Notifications + Feedback", () => {
    useAuthStore.setState({
      user: makeUser(
        ["match_scorer"],
        [
          MODULES.ORG_TOURNAMENT_LIST,
          MODULES.PERSONAL_NOTIFICATION_PREFS,
          MODULES.PERSONAL_FEEDBACK_WIDGET,
        ],
      ),
      bootstrapped: true,
    });
    renderPage();
    expect(
      screen.getByRole("link", { name: /my profile/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /notifications/i }),
    ).toBeInTheDocument();
    // No admin / settings cards.
    expect(
      screen.queryByRole("link", { name: /module overrides/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: /org settings/i }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: /audit log/i })).toBeNull();
  });

  it("does not show a coming-soon teaser strip (features shipped)", () => {
    renderPage();
    expect(screen.queryByTestId("phase1b-teaser")).toBeNull();
  });

  it("opens the feedback modal when the Feedback card is clicked", async () => {
    renderPage();
    const fb = screen.getByRole("button", { name: /send feedback/i });
    await userEvent.click(fb);
    // The dialog itself uses aria-label="Send feedback".
    const dialog = screen.getByRole("dialog", { name: /send feedback/i });
    expect(dialog).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText(/feedback message/i),
    ).toBeInTheDocument();
  });

  it("falls back gracefully when membership is missing for the slug", () => {
    useAuthStore.setState({
      user: {
        ...makeUser(["admin"], []),
        memberships: [],
      },
      bootstrapped: true,
    });
    renderPage();
    // Heading falls back to the slug.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "acme",
    );
    // Profile card always shows.
    expect(
      screen.getByRole("link", { name: /my profile/i }),
    ).toBeInTheDocument();
  });
});
