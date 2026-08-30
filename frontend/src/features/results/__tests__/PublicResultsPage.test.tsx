import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tournamentsApi, type PublicResultsPayload } from "@/api/tournaments";
import { PublicResultsPage } from "../PublicResultsPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, publicResults: vi.fn() },
  };
});

const TT = "table_tennis.u_14.boys.singles";
const TT2 = "table_tennis.u_14.girls.singles";
const SEPAK = "sepak_takraw.u_14.boys";

const winner = (
  id: string,
  name: string,
  team = `${name} TT-1`,
): PublicResultsPayload["competitions"][number]["places"][number]["winners"][number] => ({
  team_id: `${id}-team`,
  team_name: team,
  institution_id: id,
  institution_name: name,
  crest: "",
});

const PAYLOAD: PublicResultsPayload = {
  tournament: {
    id: "t1", slug: "cup", name: "Demo Meet", status: "live",
    starts_at: null, ends_at: null,
  },
  awards: {
    enabled: true,
    ladder: [
      { place: 1, points: 5, label: "Gold" },
      { place: 2, points: 3, label: "Silver" },
      { place: 3, points: 2, label: "Bronze" },
    ],
    bronze: "shared",
    places: [1, 2, 3],
  },
  competitions: [
    {
      leaf_key: TT, sport_key: "table_tennis", sport_name: "Table Tennis",
      path: ["U-14", "Boys", "Singles"], label: "U-14 · Boys · Singles",
      status: "final",
      places: [
        { place: 1, label: "Gold", points: 5, source: "final", match_id: "m1",
          note: "", winners: [winner("i1", "Greenwood")] },
        { place: 2, label: "Silver", points: 3, source: "final", match_id: "m1",
          note: "", winners: [winner("i2", "Pilgrim")] },
        { place: 3, label: "Bronze", points: 2, source: "third_place",
          match_id: "m2", note: "", winners: [winner("i3", "Holy Cross")] },
      ],
    },
    {
      leaf_key: TT2, sport_key: "table_tennis", sport_name: "Table Tennis",
      path: ["U-14", "Girls", "Singles"], label: "U-14 · Girls · Singles",
      status: "provisional",
      places: [
        { place: 1, label: "Gold", points: 5, source: "final", match_id: "m3",
          note: "", winners: [winner("i2", "Pilgrim")] },
      ],
    },
    {
      leaf_key: SEPAK, sport_key: "sepak_takraw", sport_name: "Sepak Takraw",
      path: ["U-14", "Boys"], label: "U-14 · Boys",
      status: "pending", places: [],
    },
  ],
  schools: [
    {
      id: "i1", name: "Greenwood", short_name: "", crest: "",
      medals: { "1": 1, "2": 0, "3": 0 }, points: 5, rank: 1,
      results: {
        [TT]: [{ place: 1, points: 5, label: "Gold", team_name: "Greenwood TT-1" }],
      },
    },
    {
      id: "i2", name: "Pilgrim", short_name: "", crest: "",
      medals: { "1": 1, "2": 1, "3": 0 }, points: 8, rank: 1,
      results: {
        [TT]: [{ place: 2, points: 3, label: "Silver", team_name: "Pilgrim TT-1" }],
        [TT2]: [{ place: 1, points: 5, label: "Gold", team_name: "Pilgrim TT-2" }],
      },
    },
    {
      id: "i3", name: "Holy Cross", short_name: "", crest: "",
      medals: { "1": 0, "2": 0, "3": 1 }, points: 2, rank: 3,
      results: {
        [TT]: [{ place: 3, points: 2, label: "Bronze", team_name: "Holy Cross TT-1" }],
      },
    },
    {
      id: "i4", name: "Eden School", short_name: "", crest: "",
      medals: { "1": 0, "2": 0, "3": 0 }, points: 0, rank: 4, results: {},
    },
  ],
  groups: [
    {
      key: "u14_boys", label: "U-14 Boys",
      include: ["table_tennis.u_14.boys", "sepak_takraw.u_14.boys"],
      decide: "points", leaf_keys: [TT, SEPAK], status: "provisional",
      table: [
        { id: "i1", name: "Greenwood", crest: "", medals: { "1": 1 }, points: 5, rank: 1 },
        { id: "i2", name: "Pilgrim", crest: "", medals: { "2": 1 }, points: 3, rank: 2 },
      ],
      champions: [
        { id: "i1", name: "Greenwood", crest: "", medals: { "1": 1 }, points: 5, rank: 1 },
      ],
    },
  ],
  students: [
    {
      person_id: "p1", name: "Imli Jamir", institution_id: "i2",
      institution_name: "Pilgrim", crest: "", class_section: "VIII A",
      roll_no: "12",
      events: [
        { leaf_key: TT, label: "U-14 · Boys · Singles", sport_name: "Table Tennis",
          team_id: "i2-team", team_name: "Pilgrim TT-1", place: 2,
          place_label: "Silver", points: 3, status: "final" },
        { leaf_key: SEPAK, label: "U-14 · Boys", sport_name: "Sepak Takraw",
          team_id: "i2-st", team_name: "Pilgrim ST-1", place: null,
          place_label: "", points: 0, status: "pending" },
      ],
      medals: { "1": 0, "2": 1, "3": 0 }, points: 3, event_count: 2,
      medal_count: 1,
    },
    {
      person_id: "p2", name: "Tia Konyak", institution_id: "i1",
      institution_name: "Greenwood", crest: "", class_section: "", roll_no: "",
      events: [
        { leaf_key: TT, label: "U-14 · Boys · Singles", sport_name: "Table Tennis",
          team_id: "i1-team", team_name: "Greenwood TT-1", place: 1,
          place_label: "Gold", points: 5, status: "final" },
      ],
      medals: { "1": 1, "2": 0, "3": 0 }, points: 5, event_count: 1,
      medal_count: 1,
    },
  ],
  totals: {
    schools: 4, competitions: 3, decided: 1, medals: 4, points: 15, students: 2,
  },
};

function renderPage(entry = "/t/cup/t1/results"): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/t/:slug/:id/results" element={<PublicResultsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PublicResultsPage", () => {
  beforeEach(() => {
    vi.mocked(tournamentsApi.publicResults).mockResolvedValue(PAYLOAD);
  });

  it("is the medal sheet: a placing in the cell, medals and points on the row", async () => {
    renderPage();
    const row = await screen.findByTestId("tally-row-i2");
    // Pilgrim: silver in boys singles, gold in girls singles, 8 points.
    expect(within(row).getByTestId("medal-2")).toBeInTheDocument();
    expect(within(row).getByTestId("medal-1")).toBeInTheDocument();
    expect(within(row).getByText("8")).toBeInTheDocument();
  });

  it("ranks by points, so a spread of medals can beat a single gold", async () => {
    renderPage();
    await screen.findByTestId("tally-grid");
    const order = screen
      .getAllByTestId(/^tally-row-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order.slice(0, 3)).toEqual([
      "tally-row-i2", "tally-row-i1", "tally-row-i3",
    ]);
  });

  it("keeps a school that won nothing, the way the paper sheet does", async () => {
    renderPage();
    expect(await screen.findByTestId("tally-row-i4")).toBeInTheDocument();
  });

  it("cuts to medallists on request", async () => {
    renderPage();
    await screen.findByTestId("tally-grid");
    await userEvent.click(screen.getByTestId("results-medalists-only"));
    expect(screen.queryByTestId("tally-row-i4")).not.toBeInTheDocument();
    expect(screen.getByTestId("tally-row-i1")).toBeInTheDocument();
  });

  it("rescopes every total when one sport is filtered", async () => {
    renderPage();
    await screen.findByTestId("tally-grid");
    await userEvent.click(screen.getByTestId("results-sport-sepak_takraw"));
    // Pilgrim's 8 points were all table tennis: under Sepak Takraw it is 0.
    const row = screen.getByTestId("tally-row-i2");
    expect(within(row).queryByTestId("medal-1")).not.toBeInTheDocument();
    expect(within(row).getAllByText("0").length).toBeGreaterThan(0);
  });

  it("charts the points so the gap between schools is visible", async () => {
    renderPage();
    const chart = await screen.findByTestId("points-chart");
    // Only medal-winning schools carry a bar; Eden has none.
    expect(within(chart).getByText("Pilgrim")).toBeInTheDocument();
    expect(within(chart).queryByText("Eden School")).not.toBeInTheDocument();
  });

  it("names the champion of each authored group", async () => {
    renderPage("/t/cup/t1/results?view=champions");
    const group = await screen.findByTestId("champion-group-u14_boys");
    const first = within(group).getByTestId("podium-1");
    expect(within(first).getByText("Greenwood")).toBeInTheDocument();
    expect(within(group).getByText("Still playing")).toBeInTheDocument();
  });

  it("gives a student one row across every event they played", async () => {
    renderPage("/t/cup/t1/results?view=students");
    const row = await screen.findByTestId("student-row-p1");
    expect(within(row).getByText("Imli Jamir")).toBeInTheDocument();
    expect(within(row).getByText("U-14 · Boys · Singles")).toBeInTheDocument();
    expect(within(row).getByText("U-14 · Boys")).toBeInTheDocument();
    // The sport is printed on each chip, so two same-named categories in
    // different sports are told apart without a hover.
    expect(within(row).getByText("Table Tennis")).toBeInTheDocument();
    expect(within(row).getByText("Sepak Takraw")).toBeInTheDocument();
  });

  it("says a competition is still playing rather than pretending it is done", async () => {
    renderPage();
    const legend = await screen.findByTestId("results-legend");
    expect(within(legend).getByText("still playing")).toBeInTheDocument();
    expect(within(legend).getByText("not decided")).toBeInTheDocument();
  });

  it("carries the view and the filters in the URL so a board is shareable", async () => {
    renderPage();
    await screen.findByTestId("tally-grid");
    await userEvent.click(screen.getByTestId("results-view-students"));
    expect(await screen.findByTestId("students-table")).toBeInTheDocument();
  });

  it("is headed by the tournament name, which the printed sheet needs", async () => {
    renderPage();
    // No 'Results' title: the tab strip says that (owner 2026-08-28). The
    // band carries the tournament name and the decided count instead.
    expect(
      await screen.findByRole("heading", { level: 1, name: "Demo Meet" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Results" })).toBeNull();
    expect(screen.getByTestId("results-indicator")).toHaveTextContent(/competitions decided/);
  });

  it("says so plainly when nothing has been decided", async () => {
    vi.mocked(tournamentsApi.publicResults).mockResolvedValue({
      ...PAYLOAD,
      competitions: PAYLOAD.competitions.map((c) => ({
        ...c, status: "pending" as const, places: [],
      })),
      schools: PAYLOAD.schools.map((s) => ({
        ...s, results: {}, points: 0, medals: {},
      })),
      totals: { ...PAYLOAD.totals, decided: 0, medals: 0, points: 0 },
    });
    renderPage();
    expect(
      await screen.findByText("No medal has been decided yet."),
    ).toBeInTheDocument();
  });
});
