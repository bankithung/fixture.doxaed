import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LiveViewerPage } from "../LiveViewerPage";
import { liveApi } from "@/api/live";

vi.mock("@/api/live", () => ({ liveApi: { snapshot: vi.fn() } }));

function renderAt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/m/m1"]}>
        <Routes>
          <Route path="/m/:matchId" element={<LiveViewerPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LiveViewerPage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("renders the public scoreboard + event timeline", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue({
      match: {
        id: "m1",
        status: "live",
        current_period: "first_half",
        home_team: { id: "a", name: "Alpha", short_name: "ALP", players: [] },
        away_team: { id: "b", name: "Beta", short_name: "BET", players: [] },
        home_score: 2,
        away_score: 1,
      },
      events: [
        { sequence_no: 1, type: "goal", team_id: "a", player: "Striker", minute: 12, period: "first_half" },
      ],
    });
    renderAt();
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    // event timeline shows the goal attributed to the player
    expect(await screen.findByText(/striker/i)).toBeInTheDocument();
  });

  it("shows an error when the match cannot be loaded", async () => {
    vi.mocked(liveApi.snapshot).mockRejectedValue(new Error("nope"));
    renderAt();
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be loaded/i);
  });
});
