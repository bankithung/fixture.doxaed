import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SportsTab } from "../SportsTab";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";
import { formsApi } from "@/api/forms";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      sportsCatalog: vi.fn(),
      sports: vi.fn(),
      setSports: vi.fn(),
      stage: vi.fn(),
      transitionStage: vi.fn(),
    },
  };
});

vi.mock("@/api/forms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/forms")>();
  return {
    ...actual,
    formsApi: {
      ...actual.formsApi,
      generateInstitutionForm: vi.fn(),
      list: vi.fn(),
    },
  };
});

const SETUP_STAGE = {
  stage: "setup",
  status: "draft",
  order: [],
  allowed_to: [],
  can_manage: true,
  modules: [],
  rules_frozen_at: null,
  stages: [],
};

const CATALOG = [
  { code: "football", name: "Football", category: "team", icon: "", is_team_sport: true, status: "active" },
  { code: "sepak_takraw", name: "Sepak Takraw", category: "team", icon: "", is_team_sport: true, status: "active" },
];

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/sports"]}>
          <Routes>
            <Route path="/tournaments/:id/sports" element={<SportsTab />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(tournamentsApi.sportsCatalog).mockResolvedValue(CATALOG as any);
  vi.mocked(tournamentsApi.sports).mockResolvedValue({ sports: [] });
  vi.mocked(tournamentsApi.setSports).mockResolvedValue({ sports: [] });
  vi.mocked(formsApi.list).mockResolvedValue([]);
  vi.mocked(tournamentsApi.stage).mockResolvedValue(SETUP_STAGE);
  vi.mocked(tournamentsApi.transitionStage).mockResolvedValue(SETUP_STAGE);
});
afterEach(() => vi.restoreAllMocks());

describe("SportsTab", () => {
  it("adds a sport from the catalog", async () => {
    renderTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /football/i }),
    );
    await waitFor(() =>
      expect(tournamentsApi.setSports).toHaveBeenCalledWith("t1", [
        { key: "football", name: "Football", custom: false },
      ]),
    );
  });

  it("adds a custom sport not in the catalog", async () => {
    renderTab();
    await screen.findByRole("button", { name: /football/i });
    await userEvent.type(
      screen.getByLabelText(/search sports/i),
      "Kabaddi",
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /add .*kabaddi/i }),
    );
    await waitFor(() =>
      expect(tournamentsApi.setSports).toHaveBeenCalledWith("t1", [
        { key: "kabaddi", name: "Kabaddi", custom: true },
      ]),
    );
  });

  it("removes a selected sport", async () => {
    vi.mocked(tournamentsApi.sports).mockResolvedValue({
      sports: [{ key: "football", name: "Football", custom: false }],
    });
    renderTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /remove football/i }),
    );
    await waitFor(() =>
      expect(tournamentsApi.setSports).toHaveBeenCalledWith("t1", []),
    );
  });

  it("adds a top-level category node", async () => {
    vi.mocked(tournamentsApi.sports).mockResolvedValue({
      sports: [{ key: "football", name: "Football", custom: false, nodes: [] }],
    });
    renderTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /next: set up categories/i }),
    );
    const input = await screen.findByLabelText(/add a category to football/i);
    await userEvent.type(input, "U-14 Boys{Enter}");
    await waitFor(() =>
      expect(tournamentsApi.setSports).toHaveBeenCalledWith("t1", [
        {
          key: "football",
          name: "Football",
          custom: false,
          nodes: [{ name: "U-14 Boys" }],
        },
      ]),
    );
  });

  it("nests a level under an existing node, round-tripping its key", async () => {
    vi.mocked(tournamentsApi.sports).mockResolvedValue({
      sports: [
        {
          key: "football",
          name: "Football",
          custom: false,
          nodes: [{ key: "u_14", name: "U-14", children: [] }],
        },
      ],
    });
    renderTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /next: set up categories/i }),
    );
    await userEvent.click(
      await screen.findByLabelText(/add a level under u-14/i),
    );
    // The add form captures name + type together (W2 refinement); an NvN
    // name self-detects as a format with its players-per-side.
    const input = await screen.findByPlaceholderText(/e\.g\. u-14, girls/i);
    await userEvent.type(input, "5v5{Enter}");
    await waitFor(() =>
      expect(tournamentsApi.setSports).toHaveBeenCalledWith("t1", [
        {
          key: "football",
          name: "Football",
          custom: false,
          nodes: [
            {
              key: "u_14",
              name: "U-14",
              children: [
                {
                  name: "5v5",
                  kind: "format",
                  format: { players_per_side: 5 },
                },
              ],
            },
          ],
        },
      ]),
    );
  });

  it("generates the form AND advances to the registration stage", async () => {
    vi.mocked(tournamentsApi.sports).mockResolvedValue({
      sports: [
        {
          key: "football",
          name: "Football",
          custom: false,
          categories: [{ name: "U-14", subcategories: [] }],
        },
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(formsApi.generateInstitutionForm).mockResolvedValue({ id: "f1" } as any);
    renderTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /next: set up categories/i }),
    );
    await userEvent.click(
      await screen.findByTestId("generate-institution-form"),
    );
    await waitFor(() =>
      expect(formsApi.generateInstitutionForm).toHaveBeenCalledWith("t1"),
    );
    // ...and the tournament is moved into org_registration automatically.
    await waitFor(() =>
      expect(tournamentsApi.transitionStage).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          to_stage: "org_registration",
          ack_warnings: true,
        }),
      ),
    );
  });
});
