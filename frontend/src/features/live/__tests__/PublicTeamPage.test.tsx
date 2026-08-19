import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { publicRecordsApi } from "@/api/publicRecords";
import { PublicTeamPage } from "../PublicTeamPage";

vi.mock("@/api/publicRecords", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/publicRecords")>();
  return {
    ...actual,
    publicRecordsApi: { ...actual.publicRecordsApi, team: vi.fn() },
  };
});

/** Signed capability URL: it loads with no session, which is what lets a
 * crest render on a page nobody logged into. */
const CREST = "/api/public/teams/team-1/crest.png?sig=alpha";
const OPPONENT_CREST = "/api/public/teams/team-9/crest.png?sig=bravo";

const RECORD = {
  team_id: "team-1",
  team_name: "Alpha U14 Boys",
  crest: CREST,
  leaf_key: "football.u14.boys",
  played: 2,
  wins: 1,
  draws: 0,
  losses: 1,
  scored: 3,
  conceded: 2,
  difference: 1,
  form: ["W", "L"] as ("W" | "D" | "L")[],
  matches: [
    {
      match_id: "m1",
      opponent: "Bravo School",
      opponent_crest: OPPONENT_CREST,
      home: true,
      score: "2 - 1",
      set_scores: [] as number[][],
      result: "W" as const,
      status: "completed",
      stage: "group",
      group_label: "Group A",
      scheduled_at: "2026-06-20T03:30:00Z",
      venue: "Main Ground",
    },
    {
      match_id: "m2",
      opponent: "Charlie Academy",
      home: false,
      score: null,
      set_scores: [] as number[][],
      result: "L" as const,
      status: "scheduled",
      stage: "group",
      group_label: "Group A",
      scheduled_at: null,
      venue: "",
    },
  ],
  institution: null,
  roster: [],
  badges: [],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/t/cup/t1/team/team-1"]}>
        <Routes>
          <Route
            path="/t/:slug/:id/team/:teamId"
            element={<PublicTeamPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(publicRecordsApi.team).mockResolvedValue(RECORD);
});

describe("PublicTeamPage crests", () => {
  it("puts the team's own badge in the identity strip, at profile size", async () => {
    mount();
    expect(await screen.findByText("Alpha U14 Boys")).toBeInTheDocument();
    const crests = screen.getAllByTestId("team-crest");
    expect(crests[0]).toHaveAttribute("src", CREST);
    // The identity slot the generic shield used to hold.
    expect(crests[0]!.className).toContain("h-14");
  });

  it("badges every opponent, initials when they have no crest", async () => {
    mount();
    const list = await screen.findByText("Fixtures and results");
    const section = list.closest("section")!;
    const played = within(section).getByTestId("team-crest");
    expect(played).toHaveAttribute("src", OPPONENT_CREST);
    // "Academy" is not a noise word, so Charlie Academy initials to "CA".
    expect(
      within(section).getByTestId("team-crest-fallback"),
    ).toHaveTextContent("CA");
  });

  it("falls back to initials when the team itself has no crest", async () => {
    vi.mocked(publicRecordsApi.team).mockResolvedValue({
      ...RECORD,
      crest: "",
      matches: [],
    });
    mount();
    expect(await screen.findByText("Alpha U14 Boys")).toBeInTheDocument();
    expect(screen.getByTestId("team-crest-fallback")).toHaveTextContent("AU");
    expect(screen.queryByTestId("team-crest")).toBeNull();
  });
});
