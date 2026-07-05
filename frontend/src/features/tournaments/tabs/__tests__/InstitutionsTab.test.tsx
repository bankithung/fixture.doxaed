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
    tournamentsApi: {
      ...actual.tournamentsApi,
      stage: vi.fn(),
      sports: vi.fn(),
      get: vi.fn(),
    },
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(tournamentsApi.get).mockResolvedValue({ name: "Anpsa Test" } as any);
  vi.mocked(tournamentsApi.sports).mockResolvedValue({
    sports: [
      {
        key: "sepak_takraw",
        name: "Sepak Takraw",
        custom: false,
        nodes: [
          { key: "u_15", name: "u-15", children: [{ key: "female", name: "female" }] },
        ],
      },
      {
        key: "table_tennis",
        name: "Table Tennis",
        custom: false,
        nodes: [{ key: "u_19", name: "u-19" }],
      },
    ],
  });
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

  it("shows ONE registered count in the header, no submissions chip", async () => {
    renderTab();
    await screen.findByText("abc");
    expect(screen.getByTestId("registered-count")).toHaveTextContent(
      "1registered",
    );
    // The old "<n> submissions" chip is gone ("Review raw submissions"
    // remains as a link).
    expect(screen.queryByText(/\d+ submissions/i)).not.toBeInTheDocument();
  });

  it("export drawer offers CSV and PDF and downloads the filtered CSV", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    renderTab();
    await userEvent.click(await screen.findByTestId("open-export-drawer"));
    expect(await screen.findByTestId("export-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("export-format-csv")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("export-format-pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("run-export"));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("PDF export opens a print view carrying the rows", async () => {
    const write = vi.fn();
    const fakeWin = {
      document: { write, close: vi.fn(), querySelector: vi.fn(() => null) },
      focus: vi.fn(),
      print: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const open = vi.spyOn(window, "open").mockReturnValue(fakeWin as any);
    renderTab();
    await userEvent.click(await screen.findByTestId("open-export-drawer"));
    await userEvent.click(await screen.findByTestId("export-format-pdf"));
    await userEvent.click(screen.getByTestId("run-export"));
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(write).toHaveBeenCalledWith(expect.stringContaining("abc"));
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("Ketoulhou Sekhose"),
    );
    // The tournament name heads the document.
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Anpsa Test"));
  });

  it("filter tree lists every configured sport, even without entries", async () => {
    renderTab();
    await userEvent.click(
      await screen.findByTestId("open-institution-filters"),
    );
    // Sepak Takraw has the one registration; Table Tennis was added AFTER
    // and has none yet, but must still be filterable.
    expect(await screen.findByText("Sepak Takraw")).toBeInTheDocument();
    expect(screen.getByText("Table Tennis")).toBeInTheDocument();
  });
});
