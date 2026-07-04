import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveViewerPage } from "../LiveViewerPage";
import { liveApi, type LiveSnapshot } from "@/api/live";

vi.mock("@/api/live", async () => {
  const actual = await vi.importActual<typeof import("@/api/live")>("@/api/live");
  return {
    ...actual,
    liveApi: {
      snapshot: vi.fn(),
      streamUrl: (slug: string, id: string) =>
        `/api/public/tournaments/${slug}/${id}/stream/`,
    },
  };
});

function renderAt(path = "/m/m1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/m/:matchId" element={<LiveViewerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const TOURNAMENT = {
  id: "t1",
  slug: "cup",
  name: "Nagaland Cup",
  time_zone: "UTC",
};

function footballSnapshot(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    match: {
      id: "m1",
      status: "live",
      current_period: "first_half",
      home_team: { id: "a", name: "Alpha", short_name: "ALP", players: [] },
      away_team: { id: "b", name: "Beta", short_name: "BET", players: [] },
      home_score: 2,
      away_score: 1,
      sport: "football",
      sport_meta: {
        key: "football",
        name: "Football",
        family: "timed",
        terms: { score_unit: "Goals", period: "Half" },
        version: 1,
      },
      scheduled_at: "2026-07-04T10:00:00Z",
      venue: "Local Ground",
      leaf_key: "football.u15.boys",
      group_label: "Group A",
      lineups: null,
    },
    tournament: TOURNAMENT,
    stats: [],
    h2h: [],
    events: [
      {
        sequence_no: 1,
        type: "goal",
        team_id: "a",
        player: "Striker",
        related_player: "Playmaker",
        minute: 12,
        period: "first_half",
      },
    ],
    ...overrides,
  };
}

function sepakSnapshot(): LiveSnapshot {
  return {
    match: {
      id: "m1",
      status: "live",
      current_period: "set_2",
      home_team: { id: "a", name: "Alpha", short_name: "ALP", players: [] },
      away_team: { id: "b", name: "Beta", short_name: "BET", players: [] },
      home_score: 1,
      away_score: 0,
      sport: "sepak_takraw",
      sport_meta: {
        key: "sepak_takraw",
        name: "Sepak Takraw",
        family: "target",
        terms: { score_unit: "Points", period: "Set" },
        version: 1,
      },
      set_scores: [
        [21, 15],
        [11, 8],
      ],
      scheduled_at: "2026-07-04T10:00:00Z",
      venue: "Indoor Hall",
      leaf_key: "sepak_takraw.u17.boys",
      group_label: "",
      lineups: {
        home: {
          confirmed: true,
          entries: [
            { player_id: "p1", name: "Server One", role: "starter", shirt_no: 1, positional_role: "tekong" },
            { player_id: "p2", name: "Feeder Two", role: "starter", shirt_no: 2, positional_role: "left_inside" },
            { player_id: "p3", name: "Killer Three", role: "starter", shirt_no: 3, positional_role: "right_inside" },
            { player_id: "p4", name: "Bench Four", role: "substitute", shirt_no: 4, positional_role: "" },
          ],
        },
        away: {
          confirmed: false,
          entries: [
            { player_id: "q1", name: "Away One", role: "starter", shirt_no: 5, positional_role: "" },
          ],
        },
      },
    },
    tournament: TOURNAMENT,
    stats: [],
    h2h: [],
    events: [],
  };
}

describe("LiveViewerPage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("renders the hub scoreline, overview events and live title", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(footballSnapshot());
    renderAt();
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    // Overview shows the latest events with primary + related attribution.
    expect(await screen.findByText(/striker/i)).toBeInTheDocument();
    expect(screen.getByText(/playmaker/i)).toBeInTheDocument();
    // Tournament chrome links back to the public schedule.
    expect(screen.getByTestId("hub-tournament-link")).toHaveAttribute(
      "href",
      "/t/cup/t1/schedule",
    );
    // Live document title in "Home 2 - 1 Away · Tournament" form.
    expect(document.title).toBe("Alpha 2 - 1 Beta · Nagaland Cup");
  });

  it("shows an error when the match cannot be loaded", async () => {
    vi.mocked(liveApi.snapshot).mockRejectedValue(new Error("nope"));
    renderAt();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
  });

  it("deep links a tab via ?tab= and switches tabs on click", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(footballSnapshot());
    renderAt("/m/m1?tab=timeline");
    expect(await screen.findByTestId("hub-panel-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("hub-tab-timeline")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Period marker + event row render on the timeline.
    const panel = screen.getByTestId("hub-panel-timeline");
    expect(within(panel).getByText(/first half/i)).toBeInTheDocument();
    expect(within(panel).getByText(/striker/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("hub-tab-overview"));
    expect(screen.getByTestId("hub-panel-overview")).toBeInTheDocument();
  });

  it("falls back to Overview when ?tab= names a hidden tab", async () => {
    // Scheduled + no stats: the Stats tab is hidden per the status matrix.
    const snap = footballSnapshot({ events: [] });
    snap.match.status = "scheduled";
    snap.match.home_score = null;
    snap.match.away_score = null;
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap);
    renderAt("/m/m1?tab=stats");
    expect(await screen.findByTestId("hub-panel-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("hub-tab-stats")).not.toBeInTheDocument();
    // H2H is empty, so its tab is hidden too.
    expect(screen.queryByTestId("hub-tab-h2h")).not.toBeInTheDocument();
  });

  it("renders the sepak takraw court with positional roles on the Lineups tab", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(sepakSnapshot());
    renderAt("/m/m1?tab=lineups");
    expect(await screen.findByTestId("sepak-court")).toBeInTheDocument();
    expect(screen.getByTestId("court-slot-tekong")).toHaveTextContent("Server One");
    expect(screen.getByTestId("court-slot-left_inside")).toHaveTextContent("Feeder Two");
    expect(screen.getByTestId("court-slot-right_inside")).toHaveTextContent("Killer Three");
    // Bench renders under the Substitutes label.
    expect(screen.getByText("Substitutes")).toBeInTheDocument();
    expect(screen.getByText("Bench Four")).toBeInTheDocument();
    // The away side has no positional roles: ordered-list fallback.
    expect(screen.getByText("Away One")).toBeInTheDocument();
    // Running set points are the headline while live (11-8 in set 2).
    expect(screen.getByText("Set 2")).toBeInTheDocument();
  });

  it("renders home/away stat bars from the stats array", async () => {
    const snap = footballSnapshot({
      stats: [
        { type: "shot", home: 5, away: 2 },
        { type: "yellow_card", home: 1, away: 0 },
      ],
    });
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap);
    renderAt("/m/m1?tab=stats");
    expect(await screen.findByTestId("hub-panel-stats")).toBeInTheDocument();
    const shots = screen.getByTestId("stat-shot");
    expect(shots).toHaveTextContent("Shot");
    expect(shots).toHaveTextContent("5");
    expect(shots).toHaveTextContent("2");
    expect(screen.getByTestId("stat-yellow_card")).toHaveTextContent("Yellow card");
  });

  it("lists prior meetings on the H2H tab linked to their hubs", async () => {
    const snap = footballSnapshot({
      h2h: [
        {
          id: "old1",
          status: "completed",
          scheduled_at: "2026-06-20T09:00:00Z",
          home_team_id: "b",
          away_team_id: "a",
          home_score: 0,
          away_score: 3,
          set_scores: [],
        },
      ],
    });
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap);
    renderAt("/m/m1?tab=h2h");
    const row = await screen.findByTestId("h2h-row-old1");
    expect(row).toHaveAttribute("href", "/m/old1");
    expect(row).toHaveTextContent("Beta");
    expect(row).toHaveTextContent("0 - 3");
    expect(row).toHaveTextContent("Alpha");
  });
});
