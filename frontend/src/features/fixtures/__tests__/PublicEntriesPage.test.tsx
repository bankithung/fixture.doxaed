import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tournamentsApi, type PublicEntriesPayload } from "@/api/tournaments";
import { PublicEntriesPage } from "../PublicEntriesPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, publicEntries: vi.fn() },
  };
});

const TT_SINGLES = "table_tennis.open.boys.singles";
const TT_DOUBLES = "table_tennis.open.boys.doubles";
const SEPAK_BOYS = "sepak_takraw.u14.boys";

const PAYLOAD: PublicEntriesPayload = {
  tournament: { id: "t1", slug: "cup", name: "Demo Cup", status: "scheduled" },
  competitions: [
    {
      leaf_key: TT_SINGLES,
      sport_key: "table_tennis",
      sport_name: "Table Tennis",
      path: ["Open Category", "Boys", "Singles"],
      label: "Open Category · Boys · Singles",
      teams: 3,
      schools: 2,
    },
    {
      leaf_key: TT_DOUBLES,
      sport_key: "table_tennis",
      sport_name: "Table Tennis",
      path: ["Open Category", "Boys", "Doubles"],
      label: "Open Category · Boys · Doubles",
      teams: 1,
      schools: 1,
    },
    {
      leaf_key: SEPAK_BOYS,
      sport_key: "sepak_takraw",
      sport_name: "Sepak Takraw",
      path: ["U-14", "Boys"],
      label: "U-14 · Boys",
      teams: 1,
      schools: 1,
    },
  ],
  institutions: [
    {
      id: "i1",
      name: "Holy Cross",
      short_name: "",
      region: "Dimapur",
      crest: "/api/forms/uploads/abc/?t=x",
      entries: {
        [TT_SINGLES]: { teams: 2, names: ["Holy Cross TT-1", "Holy Cross TT-2"] },
        [TT_DOUBLES]: { teams: 1, names: ["Holy Cross TT-3"] },
      },
      team_count: 3,
      competition_count: 2,
      uncategorized: 0,
    },
    {
      id: "i2",
      name: "Riverbelt School",
      short_name: "",
      region: "",
      crest: "",
      entries: {
        [TT_SINGLES]: { teams: 1, names: ["Riverbelt TT-1"] },
        [SEPAK_BOYS]: { teams: 1, names: ["Riverbelt ST-1"] },
      },
      team_count: 2,
      competition_count: 2,
      uncategorized: 0,
    },
  ],
  totals: { schools: 2, competitions: 3, teams: 5 },
};

function renderPage(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/t/cup/t1/schools"]}>
        <Routes>
          <Route path="/t/:slug/:id/schools" element={<PublicEntriesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PublicEntriesPage", () => {
  beforeEach(() => {
    vi.mocked(tournamentsApi.publicEntries).mockResolvedValue(PAYLOAD);
  });

  it("is a grid: a sport band over its own columns, one row per school", async () => {
    renderPage();
    const table = await screen.findByTestId("entries-matrix");

    // The band spans exactly its own competitions — that colSpan is what makes
    // the two-row header readable as "these columns belong to this sport".
    expect(
      within(table).getByTestId("entries-band-table_tennis"),
    ).toHaveAttribute("colspan", "2");
    expect(
      within(table).getByTestId("entries-band-sepak_takraw"),
    ).toHaveAttribute("colspan", "1");

    expect(within(table).getByTestId("entries-row-i1")).toBeInTheDocument();
    expect(within(table).getByTestId("entries-row-i2")).toBeInTheDocument();
  });

  it("shows the entry COUNT when a school entered a competition twice", async () => {
    renderPage();
    const row = await screen.findByTestId("entries-row-i1");
    // Two pairs in one event is not the same fact as one, so the cell must
    // carry the number rather than an identical tick.
    expect(row).toHaveTextContent("2");
    expect(
      within(row).getByTitle("Holy Cross TT-1, Holy Cross TT-2"),
    ).toBeInTheDocument();
  });

  it("names the empty cells for a screen reader instead of leaving a gap", async () => {
    renderPage();
    const row = await screen.findByTestId("entries-row-i1");
    expect(
      within(row).getByText("Holy Cross is not entered in Sepak Takraw U-14 · Boys"),
    ).toBeInTheDocument();
  });

  it("links each school to its public profile", async () => {
    renderPage();
    const row = await screen.findByTestId("entries-row-i1");
    expect(within(row).getByRole("link", { name: /Holy Cross/ })).toHaveAttribute(
      "href",
      "/t/cup/t1/school/i1",
    );
  });

  it("filters to one sport, dropping the schools that are not in it", async () => {
    renderPage();
    await screen.findByTestId("entries-matrix");
    await userEvent.click(screen.getByTestId("entries-sport-pick-sepak_takraw"));

    // Holy Cross entered no sepak event, so it leaves the board entirely.
    expect(screen.queryByTestId("entries-row-i1")).not.toBeInTheDocument();
    expect(screen.getByTestId("entries-row-i2")).toBeInTheDocument();
    expect(
      screen.queryByTestId("entries-band-table_tennis"),
    ).not.toBeInTheDocument();
  });

  it("counts a filtered row by the visible columns only", async () => {
    renderPage();
    await screen.findByTestId("entries-matrix");
    await userEvent.click(screen.getByTestId("entries-sport-pick-sepak_takraw"));
    const row = screen.getByTestId("entries-row-i2");
    // Riverbelt has 2 entries overall but 1 in sepak: showing 2 beside a
    // single tick would make the filtered board contradict itself.
    expect(within(row).getByText("1 event")).toBeInTheDocument();
  });

  it("searches by school name", async () => {
    renderPage();
    await screen.findByTestId("entries-matrix");
    await userEvent.type(screen.getByTestId("entries-search"), "river");
    expect(screen.queryByTestId("entries-row-i1")).not.toBeInTheDocument();
    expect(screen.getByTestId("entries-row-i2")).toBeInTheDocument();
    expect(screen.getByTestId("entries-row-count")).toHaveTextContent("1 school");
  });

  it("spells every column code out in a legend", async () => {
    renderPage();
    const legend = await screen.findByTestId("entries-legend");
    expect(within(legend).getByText("OBS")).toBeInTheDocument();
    expect(
      within(legend).getByText("Open Category · Boys · Singles"),
    ).toBeInTheDocument();
  });

  it("footers each column with the number of schools entered", async () => {
    renderPage();
    const table = await screen.findByTestId("entries-matrix");
    expect(
      within(table).getByTestId(`entries-total-${TT_SINGLES}`),
    ).toHaveTextContent("2");
  });

  it("says so plainly when no school has registered", async () => {
    vi.mocked(tournamentsApi.publicEntries).mockResolvedValue({
      ...PAYLOAD,
      institutions: [],
      totals: { schools: 0, competitions: 3, teams: 0 },
    });
    renderPage();
    expect(await screen.findByText("No schools yet.")).toBeInTheDocument();
  });
});
