import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { OrgBrandingPage } from "../OrgBrandingPage";
import { useAuthStore } from "@/features/auth/authStore";
import { api } from "@/api/client";

const baseUser = {
  id: "u1",
  email: "admin@doxaed.test",
  name: "Admin User",
  is_superuser: false,
  has_2fa_enrolled: false,
  twofa_enrolled_at: null,
  email_verified_at: "2026-01-01T00:00:00Z",
  last_active_org_id: "o1",
  last_active_org_slug: "doxaed",
  memberships: [
    {
      org_id: "o1",
      org_slug: "doxaed",
      org_name: "DoxaEd Sports",
      roles: ["admin"],
      is_org_owner: true,
      effective_modules: ["org.branding", "org.settings"],
    },
  ],
  deleted_at: null,
};

const fixtureOrg = {
  id: "11111111-1111-7111-8111-111111111111",
  slug: "doxaed",
  name: "DoxaEd Sports",
  status: "active",
  time_zone: "Asia/Kolkata",
  created_at: "2026-01-01T00:00:00Z",
  archived_at: null,
  suspended_at: null,
  suspended_reason: "",
};

function renderPage(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/o/doxaed/branding"]}>
          <Routes>
            <Route
              path="/o/:orgSlug/branding"
              element={<OrgBrandingPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: baseUser, bootstrapped: true } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clear();
});

describe("OrgBrandingPage", () => {
  it("renders the org identity preview with name + slug", async () => {
    const getSpy = vi.spyOn(api, "get").mockResolvedValue(fixtureOrg);

    renderPage();

    expect(screen.getByTestId("branding-skeleton")).toBeInTheDocument();

    const name = await screen.findByTestId("branding-name");
    expect(name.textContent).toBe("DoxaEd Sports");
    expect(screen.getByTestId("branding-slug").textContent).toBe("doxaed");

    expect(getSpy).toHaveBeenCalledWith("/api/orgs/doxaed/");
  });

  it("disables the brand-asset fieldset and shows the Phase 1B note", async () => {
    vi.spyOn(api, "get").mockResolvedValue(fixtureOrg);

    renderPage();

    const fieldset = (await screen.findByTestId(
      "branding-fieldset",
    )) as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(true);

    const note = screen.getByTestId("branding-phase-note");
    expect(note.textContent).toMatch(/phase 1b/i);
  });

  it("shows the no-permission card for non-admin users", () => {
    useAuthStore.setState({
      user: {
        ...baseUser,
        memberships: [
          {
            ...baseUser.memberships[0],
            roles: ["referee"],
            is_org_owner: false,
            effective_modules: [],
          },
        ],
      },
      bootstrapped: true,
    } as never);
    const spy = vi.spyOn(api, "get");

    renderPage();

    expect(screen.getByTestId("no-permission")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("retries on fetch failure", async () => {
    const spy = vi
      .spyOn(api, "get")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(fixtureOrg);

    renderPage();

    const retryBtn = await screen.findByTestId("branding-retry");
    expect(screen.getByRole("alert")).toHaveTextContent(/failed/i);

    await userEvent.click(retryBtn);

    await screen.findByTestId("branding-preview");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
