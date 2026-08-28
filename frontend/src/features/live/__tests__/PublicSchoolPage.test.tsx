import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { publicRecordsApi } from "@/api/publicRecords";
import { PublicSchoolPage } from "../PublicSchoolPage";

vi.mock("@/api/publicRecords", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/publicRecords")>();
  return {
    ...actual,
    publicRecordsApi: { ...actual.publicRecordsApi, school: vi.fn() },
  };
});

const CREST = "/api/public/teams/team-2/crest.png?sig=beta";
const SCHOOL_CREST = "/api/public/institutions/inst-1/crest.png?sig=alpha";

const TEAM = {
  team_id: "team-1",
  team_name: "Alpha U14 Boys",
  leaf_key: "football.u14.boys",
  leaf_label: "Football · U-14 · Boys",
  played: 4, wins: 3, draws: 0, losses: 1,
  scored: 9, conceded: 3, difference: 6,
  form: ["W", "W", "L", "W"] as ("W" | "D" | "L")[],
  matches: [], institution: null, roster: [], badges: [],
};

const LAST_YEAR = {
  tournament_id: "t0",
  tournament_name: "Last Year Cup",
  tournament_slug: "last-year-cup",
  season: "2025",
  starts_at: "2025-08-01T00:00:00Z",
  status: "completed",
  totals: {
    played: 3, wins: 2, draws: 0, losses: 1,
    scored: 5, conceded: 2, difference: 3,
  },
  teams: [
    {
      team_id: "team-old",
      team_name: "Alpha U14 Boys",
      leaf_key: "football.u14.boys",
      leaf_label: "Football · U-14 · Boys",
      played: 3, wins: 2, draws: 0, losses: 1,
      form: ["W", "L", "W"] as ("W" | "D" | "L")[],
    },
  ],
};

function mount(path = "/t/cup/t1/school/inst-1") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/t/:slug/:id/school/:instId"
            element={<PublicSchoolPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(publicRecordsApi.school).mockResolvedValue({
    institution_id: "inst-1",
    institution_name: "Alpha School",
    crest: SCHOOL_CREST,
    tournament_id: "t1",
    tournament_name: "This Year Cup",
    tournament_slug: "cup",
    season: "2026",
    totals: {
      played: 4, wins: 3, draws: 0, losses: 1,
      scored: 9, conceded: 3, difference: 6,
    },
    teams: [TEAM, { ...TEAM, team_id: "team-2", team_name: "Alpha U16 Girls", crest: CREST }],
    badges: [
      { id: "b1", badge_key: "champions", name: "Champions", evidence: {} },
    ],
    history: [
      // The current tournament comes back in the history too (same school
      // name) — it must not be listed twice.
      {
        season: "2026",
        tournaments: [
          {
            ...LAST_YEAR,
            tournament_id: "t1",
            tournament_name: "This Year Cup",
            tournament_slug: "cup",
            season: "2026",
            starts_at: "2026-08-01T00:00:00Z",
          },
        ],
      },
      { season: "2025", tournaments: [LAST_YEAR] },
      // A tournament the school entered but never played in.
      {
        season: "undated",
        tournaments: [
          {
            ...LAST_YEAR,
            tournament_id: "t-empty",
            tournament_name: "Empty Cup",
            tournament_slug: "empty-cup",
            season: "",
            starts_at: null,
            totals: { played: 0, wins: 0, draws: 0, losses: 0, scored: 0, conceded: 0, difference: 0 },
            teams: [],
          },
        ],
      },
    ],
  });
});

describe("PublicSchoolPage", () => {
  it("opens on the CURRENT tournament only: its totals, its teams, its badges, in one card", async () => {
    mount();
    expect(await screen.findByText("Alpha School")).toBeInTheDocument();
    // The school's own badge, not a generic icon.
    const header = screen.getByRole("heading", { level: 1 }).closest("header")!;
    expect(within(header).getByTestId("team-crest")).toHaveAttribute("src", SCHOOL_CREST);
    expect(header).toHaveTextContent("2 teams in This Year Cup");

    const card = screen.getByTestId("school-record");
    const totals = within(card).getByTestId("school-totals");
    expect(totals).toHaveTextContent("4");
    expect(totals).toHaveTextContent("Played");

    const row = within(card).getByTestId("school-team-team-1");
    expect(row).toHaveTextContent("Alpha U14 Boys");
    expect(row).toHaveTextContent("3-0-1");
    expect(row.getAttribute("href")).toBe("/t/cup/t1/team/team-1");
    // The competition as people say it, never the raw key.
    expect(row).toHaveTextContent("Football");
    expect(row).not.toHaveTextContent("football.u14.boys");

    expect(within(card).getByTestId("school-badges")).toHaveTextContent("Champions");
    // Nothing from another year leaks into the default view.
    expect(card).not.toHaveTextContent("Last Year Cup");
    expect(screen.queryByText("Season unknown")).toBeNull();
    expect(screen.queryByText("History")).toBeNull();
  });

  it("filters to another tournament, whose teams link into THAT tournament", async () => {
    mount();
    await screen.findByText("Alpha School");
    const filter = screen.getByTestId("school-tournament-filter");
    await userEvent.click(within(filter).getByRole("button", { name: /tournament/i }));
    await userEvent.click(screen.getByRole("option", { name: "Last Year Cup · 2025" }));

    const card = screen.getByTestId("school-record");
    expect(within(card).getByTestId("school-totals")).toHaveTextContent("3");
    const old = within(card).getByTestId("school-team-team-old");
    expect(old.getAttribute("href")).toBe("/t/last-year-cup/t0/team/team-old");
    expect(within(card).queryByTestId("school-team-team-1")).toBeNull();
    // Badges are this tournament's; they do not travel to another year.
    expect(within(card).queryByTestId("school-badges")).toBeNull();
  });

  it("sums every tournament under 'All tournaments', each named inside the card", async () => {
    mount("/t/cup/t1/school/inst-1?t=all");
    await screen.findByText("Alpha School");
    const card = screen.getByTestId("school-record");
    // 4 + 3 + 0 played
    expect(within(card).getByTestId("school-totals")).toHaveTextContent("7");
    expect(within(card).getByTestId("school-entry-t1")).toHaveTextContent("This Year Cup");
    expect(within(card).getByTestId("school-entry-t0")).toHaveTextContent("Last Year Cup");
    expect(within(card).getByTestId("school-entry-t-empty")).toHaveTextContent(
      "No teams in this tournament.",
    );
    expect(within(card).getAllByTestId(/^school-team-/)).toHaveLength(3);
    expect(within(card).getByTestId("school-badges")).toBeInTheDocument();
  });

  it("falls back to the current tournament for an unknown ?t=", async () => {
    mount("/t/cup/t1/school/inst-1?t=nope");
    await screen.findByText("Alpha School");
    expect(screen.getByTestId("school-team-team-1")).toBeInTheDocument();
  });

  it("badges each team row, initials when the team has no crest", async () => {
    mount();
    const withCrest = await screen.findByTestId("school-team-team-2");
    expect(within(withCrest).getByTestId("team-crest")).toHaveAttribute(
      "src",
      CREST,
    );
    const without = screen.getByTestId("school-team-team-1");
    expect(within(without).getByTestId("team-crest-fallback")).toHaveTextContent(
      "AU",
    );
  });

  it("shows the error state with a way back", async () => {
    vi.mocked(publicRecordsApi.school).mockRejectedValue(new Error("nope"));
    mount();
    expect(
      await screen.findByText("Could not load this school."),
    ).toBeInTheDocument();
    expect(screen.getByText("Back to the schedule")).toBeInTheDocument();
  });
});
