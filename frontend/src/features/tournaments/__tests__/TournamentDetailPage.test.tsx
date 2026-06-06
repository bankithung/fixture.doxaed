import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TournamentDetailPage } from "../TournamentDetailPage";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type MatchRow } from "@/api/tournaments";

vi.mock("@/api/tournaments");

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1"]}>
          <Routes>
            <Route path="/tournaments/:id" element={<TournamentDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const MATCH: MatchRow = {
  id: "m1",
  stage: "group",
  group_label: "Group A",
  round_no: 1,
  match_no: 1,
  status: "scheduled",
  home_team: { id: "tm1", name: "Alpha", short_name: "ALP" },
  away_team: { id: "tm2", name: "Beta", short_name: "BET" },
  home_score: null,
  away_score: null,
  scheduled_at: null,
};

describe("TournamentDetailPage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("shows teams + matches and records a score", async () => {
    vi.mocked(tournamentsApi.teams).mockResolvedValue([
      { id: "tm1", name: "Alpha", short_name: "ALP", school: "S", pool: "Group A", status: "registered", player_count: 11 },
      { id: "tm2", name: "Beta", short_name: "BET", school: "S", pool: "Group A", status: "registered", player_count: 11 },
    ]);
    vi.mocked(tournamentsApi.matches).mockResolvedValue([MATCH]);
    vi.mocked(tournamentsApi.standings).mockResolvedValue({
      groups: [
        {
          group_label: "Group A",
          rows: [
            { team_id: "tm1", name: "Alpha", school: "S", P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0 },
          ],
        },
      ],
    });
    vi.mocked(tournamentsApi.score).mockResolvedValue({ ...MATCH, status: "completed", home_score: 2, away_score: 1 });

    renderPage();
    expect(await screen.findAllByText("Alpha")).not.toHaveLength(0);

    await userEvent.type(screen.getByLabelText(/home score/i), "2");
    await userEvent.type(screen.getByLabelText(/away score/i), "1");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(tournamentsApi.score).toHaveBeenCalled());
    const [mid, payload] = vi.mocked(tournamentsApi.score).mock.calls[0];
    expect(mid).toBe("m1");
    expect(payload.home_score).toBe(2);
    expect(payload.away_score).toBe(1);
    expect(payload.event_id).toBeTruthy();
  });

  it("generates fixtures when there are none", async () => {
    vi.mocked(tournamentsApi.teams).mockResolvedValue([
      { id: "tm1", name: "Alpha", short_name: "", school: "S", pool: "", status: "registered", player_count: 0 },
      { id: "tm2", name: "Beta", short_name: "", school: "S", pool: "", status: "registered", player_count: 0 },
    ]);
    vi.mocked(tournamentsApi.matches).mockResolvedValue([]);
    vi.mocked(tournamentsApi.standings).mockResolvedValue({ groups: [] });
    vi.mocked(tournamentsApi.generateFixtures).mockResolvedValue({ generated: 1 });

    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /round-robin/i }),
    );

    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        format: "round_robin",
      }),
    );
  });

  it("can generate a knockout bracket", async () => {
    vi.mocked(tournamentsApi.teams).mockResolvedValue([
      { id: "tm1", name: "Alpha", short_name: "", school: "S", pool: "", status: "registered", player_count: 0 },
      { id: "tm2", name: "Beta", short_name: "", school: "S", pool: "", status: "registered", player_count: 0 },
    ]);
    vi.mocked(tournamentsApi.matches).mockResolvedValue([]);
    vi.mocked(tournamentsApi.standings).mockResolvedValue({ groups: [] });
    vi.mocked(tournamentsApi.generateFixtures).mockResolvedValue({ generated: 1 });

    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /knockout/i }),
    );

    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        format: "knockout",
      }),
    );
  });
});
