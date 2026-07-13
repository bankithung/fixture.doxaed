import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tournamentsApi, type PublicSchedulePayload } from "@/api/tournaments";
import { PublicBracketPage } from "../PublicBracketPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      publicSchedule: vi.fn(),
      publicStandings: vi.fn(),
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

const SEMI = {
  id: "sf1", leaf_key: "tt.u14", leaf_label: "Table Tennis · U14",
  stage: "knockout", group_label: "", round_no: 1, match_no: 1,
  status: "completed", day: "2026-06-25", scheduled_at: "2026-06-25T04:00:00Z",
  venue: "Court A",
  home: { id: "h", name: "Asen", short_name: "A", school: "North" },
  away: { id: "a", name: "Ben", short_name: "B", school: "South" },
  home_score: 3, away_score: 1, ...FIELDS,
};

const GROUP_MATCH = {
  id: "g1", leaf_key: "sepak.u14", leaf_label: "Sepak Takraw · U14",
  stage: "group", group_label: "Group A", round_no: 1, match_no: 1,
  status: "scheduled", day: "2026-06-25", scheduled_at: "2026-06-25T05:00:00Z",
  venue: "Court B",
  home: { id: "c", name: "Cara", short_name: "C", school: "East" },
  away: { id: "d", name: "Dan", short_name: "D", school: "West" },
  home_score: null as number | null, away_score: null as number | null, ...FIELDS,
};

function wrap() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/t/cup/t1/bracket"]}>
        <Routes>
          <Route path="/t/:slug/:id/bracket" element={<PublicBracketPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.publicStandings).mockResolvedValue({ groups: [] });
});

describe("PublicBracketPage", () => {
  it("renders a knockout tree per competition and ignores group matches", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([SEMI, GROUP_MATCH]),
    );
    wrap();
    // The bookmarked board opens on the first sport's first category.
    expect(await screen.findByTestId("bracket-board")).toBeInTheDocument();
    expect(screen.getByTestId("bracket-tt.u14")).toBeInTheDocument();
    expect(screen.getByTestId("bracket-sport-pick-Table Tennis")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Asen won the only match → appears in the final card AND the champion box.
    expect(screen.getAllByText("Asen").length).toBeGreaterThan(0);
    // The group-stage competition never becomes a bracket.
    expect(screen.queryByTestId("bracket-sepak.u14")).not.toBeInTheDocument();
  });

  it("switches brackets from the category bookmarks (one bracket at a time)", async () => {
    const SECOND = {
      ...SEMI,
      id: "k2",
      leaf_key: "tt.u17",
      leaf_label: "Table Tennis · U17",
    };
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([SEMI, SECOND]),
    );
    wrap();
    // Opens on the first category only; the other is a bookmark away.
    expect(await screen.findByTestId("bracket-tt.u14")).toBeInTheDocument();
    expect(screen.queryByTestId("bracket-tt.u17")).toBeNull();

    await userEvent.click(screen.getByTestId("bracket-comp-pick-tt.u17"));
    expect(await screen.findByTestId("bracket-tt.u17")).toBeInTheDocument();
    expect(screen.queryByTestId("bracket-tt.u14")).toBeNull();
  });

  it("shows an empty state when no knockout matches exist yet", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([GROUP_MATCH]),
    );
    wrap();
    expect(
      await screen.findByText(
        "The knockout bracket appears here once the group stage finishes.",
      ),
    ).toBeInTheDocument();
  });
});
