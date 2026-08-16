import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type TournamentHouses } from "@/api/tournaments";
import { HousesPage } from "../HousesPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      houses: vi.fn(),
      createHouse: vi.fn(),
      removeHouse: vi.fn(),
      addHouseMember: vi.fn(),
      removeHouseMember: vi.fn(),
    },
  };
});

const DATA: TournamentHouses = {
  scope: "intra_school",
  group_kind: "house",
  can_manage: true,
  my_houses: null,
  houses: [
    {
      id: "h1",
      name: "Kohima",
      kind: "house",
      colour: "#1e90ff",
      teams: 3,
      members: [
        {
          id: "m1",
          user_id: "u1",
          name: "Imli Jamir",
          email: "imli@school.test",
          role: "manager",
        },
      ],
    },
    { id: "h2", name: "Dimapur", kind: "house", colour: "", teams: 0, members: [] },
  ],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/houses"]}>
          <Routes>
            <Route path="/tournaments/:id/houses" element={<HousesPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.houses).mockResolvedValue(DATA);
});

describe("HousesPage", () => {
  it("lists the competing houses with their teams and who manages them", async () => {
    mount();

    expect(await screen.findByText("Kohima")).toBeInTheDocument();
    expect(screen.getByText("Dimapur")).toBeInTheDocument();
    expect(screen.getByText("3 teams")).toBeInTheDocument();
    const kohima = screen.getByTestId("house-h1");
    expect(within(kohima).getByText("Imli Jamir")).toBeInTheDocument();
  });

  it("adds a house by whatever name the host types", async () => {
    vi.mocked(tournamentsApi.createHouse).mockResolvedValue(DATA.houses[0]);
    mount();
    await screen.findByText("Kohima");

    await userEvent.type(screen.getByLabelText("New house"), "Red Dragons");
    await userEvent.click(screen.getByRole("button", { name: /^Add$/ }));

    expect(vi.mocked(tournamentsApi.createHouse)).toHaveBeenCalledWith("t1", {
      name: "Red Dragons",
    });
  });

  it("puts a person in charge of one house", async () => {
    vi.mocked(tournamentsApi.addHouseMember).mockResolvedValue(DATA.houses[1]);
    mount();
    await screen.findByText("Dimapur");

    const dimapur = screen.getByTestId("house-h2");
    await userEvent.click(within(dimapur).getByRole("button", { name: /Add member/ }));
    await userEvent.type(screen.getByLabelText("Member email"), "capt@school.test");
    await userEvent.click(
      within(screen.getByTestId("house-h2")).getByRole("button", { name: /^Add$/ }),
    );

    expect(vi.mocked(tournamentsApi.addHouseMember)).toHaveBeenCalledWith(
      "t1",
      "h2",
      "capt@school.test",
    );
  });

  it("uses the noun the host chose, not the word 'house'", async () => {
    vi.mocked(tournamentsApi.houses).mockResolvedValue({
      ...DATA,
      group_kind: "class",
      houses: [],
    });
    mount();

    expect(await screen.findByRole("heading", { name: /Classes/ })).toBeInTheDocument();
    expect(screen.getByLabelText("New class")).toBeInTheDocument();
  });

  it("says what to do when nothing is set up yet", async () => {
    vi.mocked(tournamentsApi.houses).mockResolvedValue({ ...DATA, houses: [] });
    mount();

    expect(await screen.findByTestId("houses-empty")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add at least two before opening registration — one cannot play itself.",
      ),
    ).toBeInTheDocument();
  });

  it("a house captain sees the list but gets no editing controls", async () => {
    vi.mocked(tournamentsApi.houses).mockResolvedValue({
      ...DATA,
      can_manage: false,
      my_houses: ["h1"],
    });
    mount();

    expect(await screen.findByText("Kohima")).toBeInTheDocument();
    expect(screen.queryByLabelText("New house")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add member/ })).toBeNull();
  });
});
