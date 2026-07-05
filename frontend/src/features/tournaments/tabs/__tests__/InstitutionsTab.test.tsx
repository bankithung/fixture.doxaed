import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InstitutionsTab } from "../InstitutionsTab";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";
import { institutionsApi } from "@/api/institutions";
import { formsApi } from "@/api/forms";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, stage: vi.fn() },
  };
});
vi.mock("@/api/institutions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/institutions")>();
  return {
    ...actual,
    institutionsApi: { ...actual.institutionsApi, list: vi.fn() },
  };
});
vi.mock("@/api/forms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/forms")>();
  return {
    ...actual,
    formsApi: { ...actual.formsApi, list: vi.fn() },
  };
});

const ORG_FORM = {
  id: "f1",
  title: "Institution registration",
  stage: "org_registration",
  purpose: "organization_registration",
  status: "open",
  response_count: 1,
  schema: { sections: [] },
  settings: {},
};

const INSTITUTION = {
  id: "i1",
  name: "abc",
  short_name: "",
  kind: "school",
  region: "",
  contact_name: "Ketoulhou Sekhose",
  contact_email: "k@example.com",
  contact_phone: "0961",
  status: "registered",
  team_count: 1,
  answers: {},
  competitions: [
    { leaf_key: "sepak_takraw.u_15.female", label: "Sepak Takraw — u-15 — female" },
  ],
};

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/institutions"]}>
          <Routes>
            <Route
              path="/tournaments/:id/institutions"
              element={<InstitutionsTab />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(formsApi.list).mockResolvedValue([ORG_FORM] as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(institutionsApi.list).mockResolvedValue([INSTITUTION] as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(tournamentsApi.stage).mockResolvedValue({ can_manage: true } as any);
});
afterEach(() => vi.restoreAllMocks());

describe("InstitutionsTab", () => {
  it("share opens the share modal with channels, not just copy", async () => {
    renderTab();
    await userEvent.click(await screen.findByTestId("open-share-dialog"));
    // Channels present, each pointing at its share intent in a new tab.
    const whatsapp = await screen.findByRole("link", { name: /whatsapp/i });
    expect(whatsapp).toHaveAttribute("href", expect.stringContaining("wa.me"));
    expect(whatsapp).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: /telegram/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /email/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("add institute opens the public form in a new tab", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /add institute/i }),
    );
    expect(open).toHaveBeenCalledWith("/f/f1", "_blank", "noopener");
  });

  it("filters open in the right-side drawer", async () => {
    renderTab();
    await userEvent.click(
      await screen.findByTestId("open-institution-filters"),
    );
    expect(
      await screen.findByTestId("institution-filter-drawer"),
    ).toBeInTheDocument();
  });
});
