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
      sportsMeta: vi.fn(),
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
  vi.mocked(tournamentsApi.sportsMeta).mockResolvedValue({
    sports: [],
    descriptors: {},
  });
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

    // Two sports, one category each → the sport switcher scopes the view
    // (the category row collapses when a sport has a single competition).
    expect(await screen.findByTestId("sport-chip-Football")).toBeInTheDocument();
    const ttChip = screen.getByTestId("sport-chip-Table Tennis");
    await userEvent.click(ttChip);
    expect(ttChip).toHaveAttribute("aria-selected", "true");
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

  it("renders sport-native columns for set sports (P1.c)", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      match({
        id: "m3",
        leaf_key: "sepak_takraw.u14",
        group_label: "Sepak U14 Group A",
        sport: "sepak_takraw",
      }),
    ]);
    vi.mocked(tournamentsApi.standings).mockResolvedValue({
      groups: [
        {
          group_label: "Sepak U14 Group A",
          rows: [
            {
              team_id: "th", name: "Alpha", school: "", P: 1, W: 1, D: 0,
              L: 0, GF: 2, GA: 0, GD: 2, Pts: 3,
              PF_pts: 42, PA_pts: 22, PD_pts: 20,
            },
          ],
        },
      ],
    });
    vi.mocked(tournamentsApi.sportsMeta).mockResolvedValue({
      sports: [{ key: "sepak_takraw", name: "Sepak Takraw", leaf_count: 1 }],
      descriptors: {
        sepak_takraw: {
          key: "sepak_takraw", name: "Sepak Takraw", family: "target",
          has_draw: false, terms: { period: "Set" }, boards: [],
        },
      },
    });
    mount();

    const table = await screen.findByTestId("ops-group-Sepak U14 Group A");
    // Set-native columns: Sets + point diff, NO draw and NO goal columns.
    expect(within(table).getByText("Sets")).toBeInTheDocument();
    expect(within(table).getByText("2-0")).toBeInTheDocument(); // sets W-L
    expect(within(table).getByText("20")).toBeInTheDocument();  // PD_pts
    expect(within(table).queryByText("D")).toBeNull();
    expect(within(table).queryByText("GF")).toBeNull();
    expect(within(table).queryByText("GD")).toBeNull();
  });

  it("marks the rows that qualify, using the bracket's own group_position", async () => {
    // The knockout's pointers say the top 1 of each group advances.
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      match({ id: "m1" }),
      match({
        id: "k1",
        stage: "knockout",
        group_label: "",
        status: "scheduled",
        home_team: null,
        away_team: null,
        home_source: { type: "group_position", group_label: "Football U15 Group A", position: 1 },
        away_source: { type: "group_position", group_label: "Football U15 Group B", position: 1 },
      }),
    ]);
    mount();

    await screen.findByTestId("ops-group-Football U15 Group A");
    // The legend states the qualification line the bracket implies.
    expect(screen.getByTestId("standings-board").textContent).toMatch(
      /top\s*1\s*of each group advances/i,
    );
    // Alpha is 1st and qualifies; Bravo is 2nd and does not.
    expect(screen.getByTestId("ops-standing-th").className).toMatch(/success/);
    expect(screen.getByTestId("ops-standing-ta").className).not.toMatch(/success/);

    // Tables and bracket sit in ONE sheet, as on the public standings page.
    const board = screen.getByTestId("standings-board");
    expect(within(board).getByText("Group standings")).toBeInTheDocument();
    expect(within(board).getByText("Knockout")).toBeInTheDocument();
  });

  it("does not print the school twice when it IS the team name", async () => {
    vi.mocked(tournamentsApi.standings).mockResolvedValue({
      groups: [
        {
          group_label: "Football U15 Group A",
          rows: [
            // School-entered team: the school is the name. It rendered twice.
            { team_id: "th", name: "Bethel School", school: "Bethel School", P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 },
            { team_id: "ta", name: "Bravo B", school: "Bravo School", P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 },
          ],
        },
      ],
    });
    vi.mocked(tournamentsApi.matches).mockResolvedValue([match({ id: "m1" })]);
    mount();

    const dupe = await screen.findByTestId("ops-standing-th");
    expect(within(dupe).getAllByText("Bethel School")).toHaveLength(1);
    // A school that genuinely differs from the team name still shows.
    const distinct = screen.getByTestId("ops-standing-ta");
    expect(within(distinct).getByText("Bravo School")).toBeInTheDocument();
  });
});
