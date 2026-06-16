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

  it("renames a category, round-tripping its key so registered teams stay linked", async () => {
    vi.mocked(tournamentsApi.sports).mockResolvedValue({
      sports: [
        {
          key: "football",
          name: "Football",
          custom: false,
          nodes: [
            {
              key: "u_14",
              name: "U-14",
              kind: "age_group",
              age: { op: "under", age: 14 },
              children: [],
            },
          ],
        },
      ],
    });
    renderTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /next: set up categories/i }),
    );
    // The per-category "edit" button (was "type") is the rename entry point.
    await userEvent.click(
      await screen.findByRole("button", { name: /edit u-14/i }),
    );
    const nameInput = await screen.findByLabelText(/category name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Juniors");
    // Commits on blur — clicking Done blurs the field, then closes the modal.
    await userEvent.click(screen.getByRole("button", { name: /done/i }));
    await waitFor(() => {
      const call = vi.mocked(tournamentsApi.setSports).mock.calls.at(-1);
      // The key is preserved (leaf_key stays football.u_14) — only the name
      // changed; the kind/age rule travels along untouched.
      expect(call?.[1][0].nodes?.[0]).toMatchObject({
        key: "u_14",
        name: "Juniors",
        kind: "age_group",
        age: { op: "under", age: 14 },
      });
    });
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
    // The flow now walks every sport, then REVIEWS, then generates (no
    // jumping straight to the form while sports sit unconfigured).
    await userEvent.click(
      await screen.findByRole("button", { name: /review competitions/i }),
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

describe("SportsTab — copy categories across sports", () => {
  beforeEach(() => {
    vi.mocked(tournamentsApi.sportsCatalog).mockResolvedValue(CATALOG as never);
    vi.mocked(tournamentsApi.stage).mockResolvedValue(SETUP_STAGE as never);
    vi.mocked(formsApi.list).mockResolvedValue([]);
    vi.mocked(tournamentsApi.setSports).mockImplementation(
      async (_id, sports) => ({ sports }) as never,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("applies one sport's tree to selected sports (deep copy, replace)", async () => {
    vi.mocked(tournamentsApi.sports).mockResolvedValue({
      sports: [
        {
          key: "football",
          name: "Football",
          custom: false,
          nodes: [
            {
              key: "u15",
              name: "U15",
              kind: "age_group",
              age: { op: "under", age: 15 },
              children: [],
            },
          ],
        },
        { key: "sepak_takraw", name: "Sepak Takraw", custom: false, nodes: [] },
      ],
    });
    renderTab();
    await userEvent.click(
      await screen.findByRole("button", { name: /next: set up categories/i }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /copy categories to/i }),
    );
    await userEvent.click(
      await screen.findByRole("checkbox", { name: /all other sports/i }),
    );
    await userEvent.click(await screen.findByTestId("apply-copy-categories"));
    await waitFor(() => {
      const call = vi.mocked(tournamentsApi.setSports).mock.calls.at(-1);
      expect(call?.[1][1]).toMatchObject({
        key: "sepak_takraw",
        nodes: [
          {
            key: "u15",
            name: "U15",
            kind: "age_group",
            age: { op: "under", age: 15 },
          },
        ],
      });
    });
  });
});
