import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tournamentsApi, type PublicSchedulePayload } from "@/api/tournaments";
import { PublicStandingsPage } from "../PublicStandingsPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      publicSchedule: vi.fn(),
      publicStandings: vi.fn(),
      publicRosters: vi.fn(),
    },
  };
});

const FIELDS = {
  home_pens: null as number | null,
  away_pens: null as number | null,
  sport: "",
  set_scores: [] as number[][],
  current_period: "",
};

function payload(
  matches: PublicSchedulePayload["matches"],
): PublicSchedulePayload {
  return {
    tournament: {
      id: "t1", slug: "cup", name: "Demo Cup", status: "live",
      time_zone: "Asia/Kolkata",
    },
    matches,
  };
}

// One football group + one table-tennis group; NO knockout matches anywhere.
const FOOTBALL = {
  id: "f1", leaf_key: "football.u15", leaf_label: "Football · U-15 · Boys",
  stage: "group", group_label: "Football · U-15 · Boys · Group A",
  round_no: 1, match_no: 1,
  status: "completed", day: "2026-06-25", scheduled_at: "2026-06-25T04:00:00Z",
  venue: "Main Ground",
  home: { id: "tm1", name: "Alpha FC", short_name: "A", school: "North" },
  away: { id: "tm2", name: "Bravo FC", short_name: "B", school: "South" },
  home_score: 2, away_score: 1, ...FIELDS,
};

const TT = {
  id: "tt1", leaf_key: "table_tennis.open", leaf_label: "Table Tennis · Open",
  stage: "group", group_label: "Table Tennis · Open · Group T",
  round_no: 1, match_no: 2,
  status: "completed", day: "2026-06-25", scheduled_at: "2026-06-25T05:00:00Z",
  venue: "Table Hall",
  home: { id: "tm5", name: "Echo TT", short_name: "E", school: "East" },
  away: { id: "tm6", name: "Foxtrot TT", short_name: "F", school: "West" },
  home_score: 3, away_score: 1, ...FIELDS, sport: "table_tennis",
  set_scores: [[11, 7], [9, 11], [11, 8], [11, 6]],
};

const STANDINGS = {
  groups: [
    {
      group_label: "Football · U-15 · Boys · Group A",
      rows: [
        { team_id: "tm1", name: "Alpha FC", school: "North",
          P: 1, W: 1, D: 0, L: 0, GF: 2, GA: 1, GD: 1, Pts: 3 },
        { team_id: "tm2", name: "Bravo FC", school: "South",
          P: 1, W: 0, D: 0, L: 1, GF: 1, GA: 2, GD: -1, Pts: 0 },
      ],
    },
    {
      group_label: "Table Tennis · Open · Group T",
      rows: [
        { team_id: "tm5", name: "Echo TT", school: "East",
          P: 1, W: 1, D: 0, L: 0, GF: 3, GA: 1, GD: 2, Pts: 2,
          PF_pts: 42, PA_pts: 32, PD_pts: 10 },
        { team_id: "tm6", name: "Foxtrot TT", school: "West",
          P: 1, W: 0, D: 0, L: 1, GF: 1, GA: 3, GD: -2, Pts: 1,
          PF_pts: 32, PA_pts: 42, PD_pts: -10 },
      ],
    },
  ],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/t/cup/t1/standings"]}>
        <Routes>
          <Route path="/t/:slug/:id/standings" element={<PublicStandingsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const REAL_WIDTH = window.innerWidth;

function setWidth(px: number): void {
  act(() => {
    Object.defineProperty(window, "innerWidth", {
      value: px,
      configurable: true,
      writable: true,
    });
    window.dispatchEvent(new Event("resize"));
  });
}

afterEach(() => setWidth(REAL_WIDTH));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
    payload([FOOTBALL, TT]),
  );
  vi.mocked(tournamentsApi.publicStandings).mockResolvedValue(STANDINGS);
  vi.mocked(tournamentsApi.publicRosters).mockResolvedValue({
    teams: [
      { id: "tm1", name: "Alpha FC", school: "North", players: [
        { id: "p1", name: "Asha Rai", jersey_no: 7, captain: true },
        { id: "p2", name: "Ben Lotha", jersey_no: null, captain: false },
      ] },
      { id: "tm5", name: "Echo TT", school: "East", players: [
        { id: "p5", name: "Ela Sema", jersey_no: null, captain: false },
      ] },
    ],
  } as never);
});

describe("PublicStandingsPage", () => {
  it("renders every competition's group tables, grouped by sport, with sport-native columns", async () => {
    mount();

    // Sport sections (sorted): Football then Table Tennis.
    const fb = await screen.findByTestId("standings-sport-Football");
    const tt = screen.getByTestId("standings-sport-Table Tennis");

    // Football table: timed columns include a Draw column; rows carry GD.
    const fbComp = within(fb).getByTestId("standings-comp-football.u15");
    expect(within(fbComp).getByText("D")).toBeInTheDocument();
    const alpha = within(fbComp).getByTestId("group-standing-tm1");
    expect(alpha).toHaveTextContent("Alpha FC");
    expect(alpha).toHaveTextContent("3"); // Pts
    expect(alpha).toHaveTextContent("+1"); // goal difference

    // Table tennis table: target (set-sport) columns — P/W/L + Sets + point
    // diff; NO draw column, no goal columns.
    const ttComp = within(tt).getByTestId("standings-comp-table_tennis.open");
    expect(within(ttComp).getByText("Sets")).toBeInTheDocument();
    expect(within(ttComp).queryByText("D")).toBeNull();
    const echo = within(ttComp).getByTestId("group-standing-tm5");
    expect(echo).toHaveTextContent("3-1"); // sets for-against
    expect(echo).toHaveTextContent("+10"); // within-set point diff

    // Deep data check: one shared fetch shape (schedule + standings).
    expect(tournamentsApi.publicSchedule).toHaveBeenCalledWith("cup", "t1");
    expect(tournamentsApi.publicStandings).toHaveBeenCalledWith("cup", "t1");
  });

  it("filters to one sport, then one category (owner ask: hard to find a category)", async () => {
    mount();
    await screen.findByTestId("standings-sport-Football");
    // Both sports show until a filter is picked.
    expect(screen.getByTestId("standings-sport-Table Tennis")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("standings-sport-pick-Football"));
    expect(screen.getByTestId("standings-sport-Football")).toBeInTheDocument();
    expect(screen.queryByTestId("standings-sport-Table Tennis")).toBeNull();

    // Back to everything.
    await userEvent.click(screen.getByTestId("standings-sport-all"));
    expect(screen.getByTestId("standings-sport-Table Tennis")).toBeInTheDocument();
  });

  it("shows each team's crest beside its name", async () => {
    vi.mocked(tournamentsApi.publicStandings).mockResolvedValue({
      groups: [
        {
          group_label: "Football \u00b7 U-15 \u00b7 Boys \u00b7 Group A",
          rows: [
            { team_id: "tm1", name: "Alpha FC", school: "North",
              crest: "https://cdn.example/alpha.png",
              P: 1, W: 1, D: 0, L: 0, GF: 2, GA: 1, GD: 1, Pts: 3 },
            { team_id: "tm2", name: "Bravo FC", school: "South",
              P: 1, W: 0, D: 0, L: 1, GF: 1, GA: 2, GD: -1, Pts: 0 },
          ],
        },
      ],
    });
    mount();

    const alpha = await screen.findByTestId("group-standing-tm1");
    expect(within(alpha).getByTestId("team-crest")).toHaveAttribute(
      "src",
      "https://cdn.example/alpha.png",
    );
    // A crest-less team keeps a badge of its initials, never a gap.
    const bravo = screen.getByTestId("group-standing-tm2");
    expect(within(bravo).getByTestId("team-crest-fallback")).toHaveTextContent(
      "BF",
    );
  });

  it("links every standings row to that team's public page (all its matches)", async () => {
    mount();
    const alpha = await screen.findByTestId("standing-team-link-tm1");
    expect(alpha).toHaveTextContent("Alpha FC");
    expect(alpha).toHaveAttribute("href", "/t/cup/t1/team/tm1");
  });

  it("offers TWO tabs: the knockout draw is a scope of Matches, not a page", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([
        FOOTBALL,
        { ...TT, id: "ko1", stage: "knockout", group_label: "" },
      ]),
    );
    mount();
    await screen.findByTestId("standings-sport-Football");
    expect(screen.getByTestId("viewer-tab-schedule")).toHaveTextContent("Matches");
    expect(screen.getByTestId("viewer-tab-standings")).toHaveTextContent("Standings");
    // Even with a knockout stage in the payload there is no third tab: the
    // draw lives beside the matches (owner 2026-08-21).
    expect(screen.queryByTestId("viewer-tab-bracket")).toBeNull();
  });

  it("is ONE section headed by the tournament name, not a 'Standings' title", async () => {
    mount();
    await screen.findByTestId("standings-sport-Football");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Demo Cup");
    expect(screen.queryByText("Group tables, competition by competition")).toBeNull();
    expect(screen.getByTestId("standings-indicator")).toHaveTextContent("2 tables");
  });

  it("on a phone the bookmarks become the floating Filter pill and a sheet", async () => {
    setWidth(360);
    mount();
    await screen.findByTestId("standings-sport-Football");
    // No tab row on a phone; the pill names what is on screen.
    expect(screen.queryByRole("tab", { name: /All sports/ })).toBeNull();
    const fab = screen.getByTestId("standings-filters-open");
    expect(fab).toHaveTextContent("All sports");

    await userEvent.click(fab);
    const sheet = await screen.findByTestId("standings-filter-sheet");
    await userEvent.click(within(sheet).getByTestId("standings-sport-pick-Football"));
    expect(within(sheet).getByTestId("standings-sheet-apply")).toHaveTextContent("Show 1 table");
    await userEvent.click(within(sheet).getByTestId("standings-sheet-apply"));

    expect(screen.queryByTestId("standings-filter-sheet")).toBeNull();
    expect(screen.getByTestId("standings-sport-Football")).toBeInTheDocument();
    expect(screen.queryByTestId("standings-sport-Table Tennis")).toBeNull();
    expect(screen.getByTestId("standings-filters-open")).toHaveTextContent("Football");
    expect(screen.getByTestId("standings-filters-open")).toHaveTextContent("Filter 1");
  });

  it("names every table's players by DEFAULT, each category on its own switch", async () => {
    mount();
    const alpha = await screen.findByTestId("group-standing-tm1");
    // The row says who is playing, not only which school entered.
    await within(alpha).findByText(/Asha Rai/);
    expect(alpha).toHaveTextContent("7. Asha Rai (C)");
    expect(alpha).toHaveTextContent("Ben Lotha");
    // A team with no published sheet says so rather than leaving a blank.
    expect(screen.getByTestId("group-standing-tm2")).toHaveTextContent("No team sheet");
    expect(screen.getByTestId("group-standing-tm5")).toHaveTextContent("Ela Sema");

    // Folding one category's names leaves the other's alone.
    const fbToggle = screen.getByTestId("standings-names-toggle-football.u15");
    expect(fbToggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(fbToggle);
    expect(fbToggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("group-standing-tm1")).not.toHaveTextContent("Asha Rai");
    expect(screen.getByTestId("group-standing-tm5")).toHaveTextContent("Ela Sema");
    expect(tournamentsApi.publicRosters).toHaveBeenCalledWith("cup", "t1");
  });

  it("renders an empty state when no group standings exist", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([{ ...FOOTBALL, id: "ko2", stage: "knockout", group_label: "" }]),
    );
    vi.mocked(tournamentsApi.publicStandings).mockResolvedValue({ groups: [] });
    mount();
    expect(await screen.findByText("No group tables yet.")).toBeInTheDocument();
  });
});
