import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  tournamentsApi,
  type MatchRow,
  type StandingsGroup,
} from "@/api/tournaments";
import { OpsStandingsPage } from "../OpsStandingsPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      get: vi.fn(),
      matches: vi.fn(),
      standings: vi.fn(),
    },
  };
});

function match(over: Partial<MatchRow> & { id: string }): MatchRow {
  return {
    stage: "group",
    group_label: "Football U15 Group A",
    round_no: 1,
    match_no: 1,
    status: "completed",
    home_team: { id: "th", name: "Alpha", short_name: "ALP" },
    away_team: { id: "ta", name: "Bravo", short_name: "BRA" },
    home_score: 2,
    away_score: 0,
    sport: "",
    set_scores: [],
    leaf_key: "football.u15",
    venue: "Main",
    scoring: null,
    scheduled_at: "2026-06-20T03:30:00Z",
    locked_at: null,
    ...over,
  };
}

const GROUP_A: StandingsGroup = {
  group_label: "Football U15 Group A",
  rows: [
    { team_id: "th", name: "Alpha", school: "Alpha School", P: 1, W: 1, D: 0, L: 0, GF: 2, GA: 0, GD: 2, Pts: 3 },
    { team_id: "ta", name: "Bravo", school: "Bravo School", P: 1, W: 0, D: 0, L: 1, GF: 0, GA: 2, GD: -2, Pts: 0 },
  ],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tournaments/t1/standings"]}>
        <Routes>
          <Route path="/tournaments/:id/standings" element={<OpsStandingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // slug "" → no SSE EventSource in the test.
  vi.mocked(tournamentsApi.get).mockResolvedValue({
    id: "t1",
    name: "Cup",
    slug: "",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(tournamentsApi.standings).mockResolvedValue({ groups: [GROUP_A] });
});

describe("OpsStandingsPage", () => {
  it("renders the server group standings (accurate points) for a competition", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([match({ id: "m1" })]);
    mount();

    const table = await screen.findByTestId("ops-group-Football U15 Group A");
    const top = within(table).getByTestId("ops-standing-th");
    expect(top).toHaveTextContent("Alpha");
    expect(top).toHaveTextContent("3"); // Pts
  });

  it("scopes by competition via the chip selector", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      match({ id: "m1" }),
      match({ id: "m2", leaf_key: "table_tennis.u14", group_label: "TT U14 Group A" }),
    ]);
    mount();

    // Two competitions → chips; the first is selected by default.
    expect(await screen.findByTestId("comp-chip-football.u15")).toBeInTheDocument();
    const ttChip = screen.getByTestId("comp-chip-table_tennis.u14");
    await userEvent.click(ttChip);
    expect(ttChip).toHaveAttribute("aria-pressed", "true");
    // TT has no standings group in the mock → the empty-for-competition note.
    expect(
      screen.getByText(/no standings for this competition yet/i),
    ).toBeInTheDocument();
  });

  it("shows an empty state when there are no fixtures", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([]);
    mount();
    expect(await screen.findByText("No fixtures yet")).toBeInTheDocument();
  });
});
