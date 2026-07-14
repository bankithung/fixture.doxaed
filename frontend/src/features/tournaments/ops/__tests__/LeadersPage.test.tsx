import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tournamentsApi, type LeadersPayload } from "@/api/tournaments";
import { LeadersPage } from "../LeadersPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, leaders: vi.fn() },
  };
});

const wins = (teams: [string, number][]) => ({
  key: "wins",
  label: "Match wins",
  subject: "team" as const,
  fmt: "int",
  rows: teams.map(([team_name, value], i) => ({
    team_id: `t${i}-${team_name}`,
    team_name,
    played: 1,
    value,
  })),
});

/** Sepak with two categories. The sport roll-up pools both — which is exactly
 * how the same school ended up twice in one table. */
const DATA: LeadersPayload = {
  played: 2,
  sports: [
    {
      sport: "sepak_takraw",
      name: "Sepak Takraw",
      played: 2,
      boards: [wins([["Bethel", 1], ["Bethel", 1], ["Loyola", 0]])],
      categories: [
        {
          leaf_key: "sepak.u14.boys",
          label: "u-14 boys",
          played: 1,
          boards: [wins([["Bethel", 1], ["Loyola", 0]])],
        },
        {
          leaf_key: "sepak.u14.girls",
          label: "u-14 girls",
          played: 1,
          boards: [wins([["City Tower", 1], ["Faith", 0]])],
        },
      ],
    },
  ],
  latest_badges: [],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tournaments/t1/leaders"]}>
        <Routes>
          <Route path="/tournaments/:id/leaders" element={<LeadersPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.leaders).mockResolvedValue(DATA);
});

describe("LeadersPage", () => {
  it("gives every category its own winner, not just the sport", async () => {
    mount();
    const board = await screen.findByTestId("leaders-board");

    // Defaults to the sport-wide roll-up, and says what it is.
    expect(screen.getByTestId("leaders-cat-all")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(board).toHaveTextContent(/across every category/i);

    // Picking a category scopes the boards to it: the girls' teams are gone.
    await userEvent.click(screen.getByTestId("leaders-cat-sepak.u14.boys"));
    const table = within(board).getByTestId("board-table-wins");
    expect(within(table).getByText("Bethel")).toBeInTheDocument();
    expect(within(table).queryByText("City Tower")).toBeNull();

    // The other category has its OWN winner.
    await userEvent.click(screen.getByTestId("leaders-cat-sepak.u14.girls"));
    const girls = within(board).getByTestId("board-table-wins");
    expect(within(girls).getByText("City Tower")).toBeInTheDocument();
    expect(within(girls).queryByText("Bethel")).toBeNull();
  });

  it("marks rank 1 as the leader of its board", async () => {
    mount();
    await screen.findByTestId("leaders-board");
    await userEvent.click(screen.getByTestId("leaders-cat-sepak.u14.boys"));

    const rows = within(screen.getByTestId("board-table-wins")).getAllByRole(
      "row",
    );
    // Header, then the winner (trophy in place of the rank numeral).
    expect(within(rows[1]).getByLabelText("Leader")).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("Bethel");
    expect(within(rows[2]).queryByLabelText("Leader")).toBeNull();
  });
});
