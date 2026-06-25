import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tournamentsApi, type PublicSchedulePayload } from "@/api/tournaments";
import { PublicLiveScoreboardPage } from "../PublicLiveScoreboardPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, publicSchedule: vi.fn() },
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

const LIVE_MATCH = {
  id: "m-live", leaf_key: "tt.u14", leaf_label: "Table Tennis · U14",
  stage: "knockout", group_label: "", round_no: 1, match_no: 1,
  status: "live", day: "2026-06-25", scheduled_at: "2026-06-25T04:00:00Z",
  venue: "Court A",
  home: { id: "h", name: "Asen", short_name: "A", school: "North" },
  away: { id: "a", name: "Ben", short_name: "B", school: "South" },
  home_score: 1, away_score: 0, ...FIELDS, current_period: "first_half",
};

const UPCOMING = {
  id: "m-next", leaf_key: "tt.u14", leaf_label: "Table Tennis · U14",
  stage: "knockout", group_label: "", round_no: 1, match_no: 2,
  status: "scheduled", day: "2026-06-25", scheduled_at: "2026-06-25T06:00:00Z",
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
      <MemoryRouter initialEntries={["/t/cup/t1/live"]}>
        <Routes>
          <Route path="/t/:slug/:id/live" element={<PublicLiveScoreboardPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("PublicLiveScoreboardPage", () => {
  it("shows in-play matches as live score cards + an Up next list", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([LIVE_MATCH, UPCOMING]),
    );
    wrap();
    expect(await screen.findByTestId("live-card-m-live")).toBeInTheDocument();
    const card = screen.getByTestId("live-card-m-live");
    expect(card).toHaveTextContent("Asen");
    expect(card).toHaveTextContent("Ben");
    // Up next lists the scheduled match (not the live one).
    expect(await screen.findByText("Up next")).toBeInTheDocument();
    expect(screen.getByText(/Cara/)).toBeInTheDocument();
    // The bracket tab is reachable from here.
    expect(screen.getByTestId("viewer-tab-bracket")).toBeInTheDocument();
  });

  it("renders an empty state when nothing is live", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([UPCOMING]),
    );
    wrap();
    expect(
      await screen.findByText("No matches are live right now."),
    ).toBeInTheDocument();
    // Still surfaces the upcoming match.
    await waitFor(() => expect(screen.getByText("Up next")).toBeInTheDocument());
  });
});
