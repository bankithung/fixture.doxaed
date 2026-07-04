import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

const TEAM = {
  team_id: "team-1",
  team_name: "Alpha U14 Boys",
  leaf_key: "football.u14.boys",
  played: 4, wins: 3, draws: 0, losses: 1,
  scored: 9, conceded: 3, difference: 6,
  form: ["W", "W", "L", "W"],
  matches: [], institution: null, roster: [], badges: [],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/t/cup/t1/school/inst-1"]}>
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
    tournament_id: "t1",
    totals: {
      played: 4, wins: 3, draws: 0, losses: 1,
      scored: 9, conceded: 3, difference: 6,
    },
    teams: [TEAM],
    badges: [
      { id: "b1", badge_key: "champions", name: "Champions", evidence: {} },
    ],
    history: [
      {
        season: "2026",
        tournaments: [
          {
            tournament_id: "t0",
            tournament_name: "Last Year Cup",
            tournament_slug: "last-year-cup",
            season: "2026",
            starts_at: null,
            status: "completed",
            totals: {
              played: 3, wins: 2, draws: 0, losses: 1,
              scored: 5, conceded: 2, difference: 3,
            },
            teams: [],
          },
        ],
      },
    ],
  });
});

describe("PublicSchoolPage", () => {
  it("renders totals, team cards with form, badges and history", async () => {
    mount();
    expect(await screen.findByText("Alpha School")).toBeInTheDocument();
    expect(screen.getByTestId("school-totals")).toHaveTextContent("Played");

    const card = screen.getByTestId("school-team-team-1");
    expect(card).toHaveTextContent("Alpha U14 Boys");
    expect(card).toHaveTextContent("3-0-1");
    expect(card.getAttribute("href")).toBe("/t/cup/t1/team/team-1");

    expect(screen.getByText("Champions")).toBeInTheDocument();
    const history = screen.getByTestId("school-history");
    expect(history).toHaveTextContent("Last Year Cup");
    expect(history).toHaveTextContent("3 played, 2 won");
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
