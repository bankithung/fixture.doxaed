import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MatchConsolePage } from "../MatchConsolePage";
import { ToastProvider } from "@/components/ui/toast";
import { liveApi, type LiveSnapshot } from "@/api/live";
import { clearWrites, pendingWrites } from "@/lib/offlineQueue";
import { ApiError } from "@/types/api";

vi.mock("@/api/live");

function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/matches/m1"]}>
          <Routes>
            <Route
              path="/tournaments/:id/matches/:matchId"
              element={<MatchConsolePage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function snap(status: string, extra: Partial<LiveSnapshot["match"]> = {}): LiveSnapshot {
  return {
    match: {
      id: "m1",
      status,
      current_period: status === "live" ? "first_half" : "",
      home_team: {
        id: "a",
        name: "Alpha",
        short_name: "ALP",
        players: [{ id: "p1", name: "Striker", jersey_no: 9, position: "ST" }],
      },
      away_team: { id: "b", name: "Beta", short_name: "BET", players: [] },
      home_score: 0,
      away_score: 0,
      ...extra,
    },
    events: [],
  };
}

describe("MatchConsolePage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearWrites();
  });

  it("parks a tap offline (queued, not lost, no error toast) when the server is unreachable", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap("live"));
    vi.mocked(liveApi.recordEvent).mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    renderConsole();
    await screen.findAllByText("Alpha");

    await userEvent.click(screen.getAllByRole("button", { name: /^goal$/i })[0]);

    // The tap lands in the replay queue with its original event_id...
    await waitFor(() => expect(pendingWrites()).toBe(1));
    const queued = JSON.parse(
      localStorage.getItem("fixture.offline-writes.v1") ?? "[]",
    );
    expect(queued[0].path).toBe("/api/matches/m1/events/");
    expect(queued[0].body.event_type).toBe("goal");
    expect(queued[0].id).toBe(queued[0].body.event_id);
    // ...the header shows the offline chip, and no error alert fires.
    expect(await screen.findByTestId("offline-queued")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("records a goal event for the home side", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap("live"));
    vi.mocked(liveApi.recordEvent).mockResolvedValue({} as never);
    renderConsole();
    // Team name renders in both the scoreboard and the per-side recorder.
    await screen.findAllByText("Alpha");

    await userEvent.click(screen.getAllByRole("button", { name: /^goal$/i })[0]);

    await waitFor(() => expect(liveApi.recordEvent).toHaveBeenCalled());
    const [mid, payload] = vi.mocked(liveApi.recordEvent).mock.calls[0];
    expect(mid).toBe("m1");
    expect(payload.event_type).toBe("goal");
    expect(payload.side).toBe("home");
    expect(payload.event_id).toBeTruthy();
  });

  it("attributes a goal to the selected player", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap("live"));
    vi.mocked(liveApi.recordEvent).mockResolvedValue({} as never);
    renderConsole();
    // Team name renders in both the scoreboard and the per-side recorder.
    await screen.findAllByText("Alpha");

    // Custom <Select> (button-triggered listbox): open it, then pick the player.
    await userEvent.click(screen.getByRole("button", { name: /home player/i }));
    await userEvent.click(screen.getByRole("option", { name: /striker/i }));
    await userEvent.click(screen.getAllByRole("button", { name: /^goal$/i })[0]);

    await waitFor(() => expect(liveApi.recordEvent).toHaveBeenCalled());
    const [, payload] = vi.mocked(liveApi.recordEvent).mock.calls[0];
    expect(payload.player_id).toBe("p1");
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

  it("requires a confirm before completing (P7a mistake-proofing)", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap("live"));
    vi.mocked(liveApi.transition).mockResolvedValue({} as never);
    renderConsole();
    await screen.findAllByText("Alpha");

    await userEvent.click(screen.getByRole("button", { name: /^complete$/i }));
    // No transition yet — the confirm dialog intercepts.
    expect(liveApi.transition).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("confirm-complete"));
    await waitFor(() =>
      expect(liveApi.transition).toHaveBeenCalledWith("m1", "completed"),
    );
  });

  it("surfaces a rejected event as a visible error (no silent failures)", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(snap("live"));
    vi.mocked(liveApi.recordEvent).mockRejectedValue(
      new ApiError(403, { detail: "not_allowed_to_score" }),
    );
    renderConsole();
    await screen.findAllByText("Alpha");

    await userEvent.click(screen.getAllByRole("button", { name: /^goal$/i })[0]);
    await screen.findByText(/not allowed to score/i);
  });

  it("undoes the last event via a void referencing its sequence", async () => {
    const s = snap("live");
    s.events = [
      { sequence_no: 2, type: "goal", team_id: "a", player: null, minute: 12, period: "first_half" },
      { sequence_no: 1, type: "shot", team_id: "a", player: null, minute: 10, period: "first_half" },
    ];
    vi.mocked(liveApi.snapshot).mockResolvedValue(s);
    vi.mocked(liveApi.recordEvent).mockResolvedValue({} as never);
    renderConsole();
    await screen.findAllByText("Alpha");

    await userEvent.click(screen.getByRole("button", { name: /undo last event/i }));
    await waitFor(() => expect(liveApi.recordEvent).toHaveBeenCalled());
    const [, payload] = vi.mocked(liveApi.recordEvent).mock.calls[0];
    expect(payload.event_type).toBe("void");
    expect(payload.voids_seq).toBe(2);
  });

  it("opens the shootout entry when completion needs one, then completes", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(
      snap("live", { home_score: 1, away_score: 1 }),
    );
    vi.mocked(liveApi.transition)
      .mockRejectedValueOnce(
        new ApiError(400, { detail: "knockout_draw_needs_shootout" }),
      )
      .mockResolvedValue({} as never);
    vi.mocked(liveApi.scoreShootout).mockResolvedValue({} as never);
    renderConsole();
    await screen.findAllByText("Alpha");

    await userEvent.click(screen.getByRole("button", { name: /^complete$/i }));
    await userEvent.click(screen.getByTestId("confirm-complete"));

    // The rejection opens the shootout dialog instead of failing silently.
    const homePens = await screen.findByLabelText("Alpha");
    await userEvent.type(homePens, "4");
    await userEvent.type(screen.getByLabelText("Beta"), "3");
    await userEvent.click(screen.getByTestId("confirm-shootout"));

    await waitFor(() =>
      expect(liveApi.scoreShootout).toHaveBeenCalledWith("m1", {
        home_pens: 4,
        away_pens: 3,
        event_id: expect.any(String),
      }),
    );
    // After the shootout records, completion is retried automatically.
    await waitFor(() =>
      expect(liveApi.transition).toHaveBeenLastCalledWith("m1", "completed"),
    );
  });

  it("shows set entry instead of the goal palette for set sports", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(
      snap("live", {
        sport: "table_tennis",
        scoring: { type: "sets", best_of: 5, points: 11, win_by: 2 },
        set_scores: [],
      }),
    );
    vi.mocked(liveApi.recordSetScores).mockResolvedValue({} as never);
    renderConsole();
    await screen.findAllByText("Alpha");

    // No goal button for a set sport (the server would reject it).
    expect(screen.queryByRole("button", { name: /^goal$/i })).toBeNull();
    expect(screen.getByText(/set scores/i)).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Set 1 Alpha"), "11");
    await userEvent.type(screen.getByLabelText("Set 1 Beta"), "7");
    await userEvent.click(screen.getByRole("button", { name: /record result/i }));
    await userEvent.click(screen.getByTestId("confirm-sets"));

    await waitFor(() =>
      expect(liveApi.recordSetScores).toHaveBeenCalledWith("m1", {
        set_scores: [[11, 7]],
        event_id: expect.any(String),
      }),
    );
  });

  it("tap scoring: +/- moves points by the chosen step and auto-saves live", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(
      snap("live", {
        sport: "table_tennis",
        scoring: { type: "sets", best_of: 3, points: 11, win_by: 2 },
        set_scores: [],
      }),
    );
    vi.mocked(liveApi.recordSetProgress).mockResolvedValue({} as never);
    renderConsole();
    await screen.findAllByText("Alpha");

    // One tap adds 1 by default, and the BIG scoreboard tracks the current
    // set's points instantly (sets-won stays 0-0 mid-set).
    await userEvent.click(screen.getByTestId("set-0-home-plus"));
    expect(screen.getByLabelText("Set 1 Alpha")).toHaveValue("1");
    expect(screen.getByTestId("set-scoreboard")).toHaveTextContent("1-0");
    expect(screen.getByText(/set 1 · sets 0-0/i)).toBeInTheDocument();

    // Choose +5: the next tap adds 5; minus steps the same amount back.
    await userEvent.click(screen.getByTestId("tap-step-5"));
    await userEvent.click(screen.getByTestId("set-0-home-plus"));
    expect(screen.getByLabelText("Set 1 Alpha")).toHaveValue("6");
    await userEvent.click(screen.getByTestId("set-0-home-minus"));
    expect(screen.getByLabelText("Set 1 Alpha")).toHaveValue("1");

    // The debounced auto-save pushes the running points as progress (no
    // completion): away side untouched counts as 0.
    await waitFor(() =>
      expect(liveApi.recordSetProgress).toHaveBeenLastCalledWith("m1", {
        set_scores: [[1, 0]],
        event_id: expect.any(String),
      }),
    );
    expect(liveApi.recordSetScores).not.toHaveBeenCalled();
  });

  it("tap scoring stays local while the match has not started", async () => {
    vi.mocked(liveApi.snapshot).mockResolvedValue(
      snap("scheduled", {
        sport: "table_tennis",
        scoring: { type: "sets", best_of: 3, points: 11, win_by: 2 },
        set_scores: [],
      }),
    );
    renderConsole();
    await screen.findAllByText("Alpha");

    await userEvent.click(screen.getByTestId("set-0-home-plus"));
    expect(screen.getByLabelText("Set 1 Alpha")).toHaveValue("1");
    // No live push before kickoff: the result is recorded at the end.
    await new Promise((r) => setTimeout(r, 700));
    expect(liveApi.recordSetProgress).not.toHaveBeenCalled();
  });
});
