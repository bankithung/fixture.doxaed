import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { OrgSettingsPage } from "../OrgSettingsPage";
import { useAuthStore } from "@/features/auth/authStore";
import { api } from "@/api/client";

/**
 * The store's ``User`` shape uses ``name`` (not ``full_name``) and a richer
 * field set than the test mocks elsewhere in this folder. We keep the same
 * loose-shape pattern those tests use — vitest doesn't typecheck strictly,
 * and the page reads only ``memberships``/``email`` so a partial mock is fine.
 */
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
      effective_modules: ["org.settings", "org.member_directory"],
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
        <MemoryRouter initialEntries={["/o/doxaed/settings"]}>
          <Routes>
            <Route
              path="/o/:orgSlug/settings"
              element={<OrgSettingsPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // Cast through unknown — the loosely-typed mock is acceptable because the
  // page only reads ``memberships`` / ``email`` off the user.
  useAuthStore.setState({ user: baseUser, bootstrapped: true } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clear();
});

describe("OrgSettingsPage", () => {
  it("loads the org and pre-fills the form with name + time zone", async () => {
    const getSpy = vi.spyOn(api, "get").mockResolvedValue(fixtureOrg);

    renderPage();

    expect(screen.getByTestId("settings-skeleton")).toBeInTheDocument();

    const nameInput = (await screen.findByTestId(
      "settings-name",
    )) as HTMLInputElement;
    expect(nameInput.value).toBe("DoxaEd Sports");

    const tzSelect = screen.getByTestId("settings-tz") as HTMLSelectElement;
    expect(tzSelect.value).toBe("Asia/Kolkata");

    const slugInput = screen.getByTestId("settings-slug") as HTMLInputElement;
    expect(slugInput.value).toBe("doxaed");
    expect(slugInput.readOnly).toBe(true);

    expect(getSpy).toHaveBeenCalledWith("/api/orgs/doxaed/");
  });

  it("submits PATCH against the org UUID with the changed payload", async () => {
    vi.spyOn(api, "get").mockResolvedValue(fixtureOrg);
    const patchSpy = vi
      .spyOn(api, "patch")
      .mockResolvedValue({ ...fixtureOrg, name: "DoxaEd Sports League" });

    renderPage();

    const nameInput = (await screen.findByTestId(
      "settings-name",
    )) as HTMLInputElement;
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "DoxaEd Sports League");

    const tzSelect = screen.getByTestId("settings-tz") as HTMLSelectElement;
    await userEvent.selectOptions(tzSelect, "UTC");

    await userEvent.click(screen.getByTestId("settings-submit"));

    await waitFor(() => {
      expect(patchSpy).toHaveBeenCalledTimes(1);
    });
    expect(patchSpy).toHaveBeenCalledWith(
      `/api/orgs/${fixtureOrg.id}/`,
      { name: "DoxaEd Sports League", time_zone: "UTC" },
    );
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

  it("renders a retry-able error state on fetch failure", async () => {
    const spy = vi
      .spyOn(api, "get")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(fixtureOrg);

    renderPage();

    const retryBtn = await screen.findByTestId("settings-retry");
    expect(screen.getByRole("alert")).toHaveTextContent(/failed/i);

    await userEvent.click(retryBtn);

    await screen.findByTestId("settings-form");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
