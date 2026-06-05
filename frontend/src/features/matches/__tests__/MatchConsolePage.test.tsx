import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MatchConsolePage } from "../MatchConsolePage";
import { liveApi, type LiveSnapshot } from "@/api/live";

vi.mock("@/api/live");

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/tournaments/t1/matches/m1"]}>
        <Routes>
          <Route
            path="/tournaments/:id/matches/:matchId"
            element={<MatchConsolePage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function snap(status: string): LiveSnapshot {
  return {
    match: {
      id: "m1",
      status,
      current_period: status === "live" ? "first_half" : "",
      home_team: { id: "a", name: "Alpha", short_name: "ALP" },
      away_team: { id: "b", name: "Beta", short_name: "BET" },
      home_score: 0,
      away_score: 0,
    },
    events: [],
  };
}

describe("MatchConsolePage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("records a goal event for the home side", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap("live"));
    vi.mocked(liveApi.recordEvent).mockResolvedValue({} as never);
    renderConsole();
    await screen.findByText("Alpha");

    await userEvent.click(screen.getAllByRole("button", { name: /^goal$/i })[0]);

    await waitFor(() => expect(liveApi.recordEvent).toHaveBeenCalled());
    const [mid, payload] = vi.mocked(liveApi.recordEvent).mock.calls[0];
    expect(mid).toBe("m1");
    expect(payload.event_type).toBe("goal");
    expect(payload.side).toBe("home");
    expect(payload.event_id).toBeTruthy();
  });

  it("starts the match from scheduled", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap("scheduled"));
    vi.mocked(liveApi.transition).mockResolvedValue({} as never);
    renderConsole();
    const startBtn = await screen.findByRole("button", { name: /start match/i });

    await userEvent.click(startBtn);
    await waitFor(() =>
      expect(liveApi.transition).toHaveBeenCalledWith("m1", "live"),
    );
  });
});
