import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { liveApi, type LiveSnapshot } from "@/api/live";
import { TTConsole } from "../TTConsole";
import { resolveConsole } from "../registry";

vi.mock("@/api/live");

function makeMatch(
  extra: Partial<LiveSnapshot["match"]> = {},
): LiveSnapshot["match"] {
  return {
    id: "m1",
    status: "live",
    current_period: "",
    home_team: {
      id: "a",
      name: "Alpha",
      short_name: "ALP",
      players: [{ id: "p1", name: "Looper", jersey_no: null, position: "" }],
    },
    away_team: { id: "b", name: "Beta", short_name: "BET", players: [] },
    home_score: 0,
    away_score: 0,
    sport: "table_tennis",
    sport_meta: {
      key: "table_tennis",
      name: "Table tennis",
      family: "target",
      terms: { period: "Game", score_unit: "Points" },
      version: 1,
    },
    set_scores: [],
    scoring: {
      type: "sets",
      best_of: 5,
      points: 11,
      win_by: 2,
      cap: null,
      deciding: null,
      serve: {
        serves_per_turn: 2,
        alternate_every_point: true,
        change_ends_at: { deciding: 5 },
      },
    },
    ...extra,
  };
}

function renderTT(extra: Partial<LiveSnapshot["match"]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const match = makeMatch(extra);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <TTConsole
          matchId="m1"
          match={match}
          homeName="Alpha"
          awayName="Beta"
          live={match.status === "live"}
          isFinal={false}
          refresh={vi.fn()}
          onError={vi.fn()}
          actions={null}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("TTConsole", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    vi.mocked(liveApi.recordEvent).mockResolvedValue({} as never);
    vi.mocked(liveApi.recordSetProgress).mockResolvedValue({} as never);
  });

  it("registers as the native table_tennis console", () => {
    expect(resolveConsole("table_tennis", "target")?.Console).toBe(TTConsole);
  });

  it("point tap bumps the game, logs the rally, and speaks Game not Set", async () => {
    renderTT();

    await userEvent.click(screen.getByTestId("point-home"));
    expect(screen.getByTestId("points-home")).toHaveTextContent("1");
    expect(screen.getByTestId("points-away")).toHaveTextContent("0");
    // Game vocabulary from sport_meta.terms.period, with the best-of rule
    // always on the board.
    expect(screen.getByText(/game 1 of 5 · games 0-0/i)).toBeInTheDocument();

    // A TT point is just a point: the tap itself logs the annotation.
    await waitFor(() => expect(liveApi.recordEvent).toHaveBeenCalled());
    const [mid, payload] = vi.mocked(liveApi.recordEvent).mock.calls[0];
    expect(mid).toBe("m1");
    expect(payload.event_type).toBe("point");
    expect(payload.side).toBe("home");
    expect(payload.detail).toEqual({ scoring_side: "home" });
    expect(payload.event_id).toBeTruthy();

    // The debounced live push carries the running points.
    await waitFor(() =>
      expect(liveApi.recordSetProgress).toHaveBeenLastCalledWith("m1", {
        set_scores: [[1, 0]],
        event_id: expect.any(String),
      }),
    );
    expect(liveApi.recordSetScores).not.toHaveBeenCalled();
  });

  it("service alternates every two points and honors the first-server toggle", async () => {
    renderTT();

    expect(screen.getByTestId("serve-indicator")).toHaveTextContent("Service: Alpha");
    await userEvent.click(screen.getByTestId("point-home"));
    expect(screen.getByTestId("serve-indicator")).toHaveTextContent("Service: Alpha");
    await userEvent.click(screen.getByTestId("point-away"));
    expect(screen.getByTestId("serve-indicator")).toHaveTextContent("Service: Beta");

    await userEvent.click(screen.getByRole("button", { name: /first server/i }));
    expect(screen.getByTestId("serve-indicator")).toHaveTextContent("Service: Alpha");
    expect(localStorage.getItem("fixture.first-server.m1")).toBe("1");
  });

  it("timeout is once per MATCH per side and survives a new game", async () => {
    renderTT();

    await userEvent.click(screen.getByTestId("timeout-home"));
    await waitFor(() => expect(liveApi.recordEvent).toHaveBeenCalled());
    const [, payload] = vi.mocked(liveApi.recordEvent).mock.calls[0];
    expect(payload.event_type).toBe("timeout");
    expect(payload.side).toBe("home");
    expect(screen.getByTestId("timeout-home")).toBeDisabled();

    // Start another game via the corrections editor: the timeout stays spent.
    await userEvent.click(screen.getByText(/adjust games/i));
    await userEvent.click(screen.getByRole("button", { name: /add game/i }));
    expect(screen.getByText(/game 2 of 5 · games 0-0/i)).toBeInTheDocument();
    expect(screen.getByTestId("timeout-home")).toBeDisabled();
    expect(screen.getByTestId("timeout-away")).toBeEnabled();
  });

  it("nudges a towel break every six points and clears on the next", async () => {
    renderTT({ set_scores: [[3, 2]] });

    await userEvent.click(screen.getByTestId("point-home"));
    expect(screen.getByTestId("towel-break")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("point-home"));
    expect(screen.queryByTestId("towel-break")).toBeNull();
  });

  it("prompts the deciding-game switch when a side first reaches 5", async () => {
    renderTT({
      set_scores: [
        [11, 5],
        [5, 11],
        [11, 5],
        [5, 11],
        [4, 0],
      ],
    });
    expect(screen.queryByTestId("change-ends")).toBeNull();

    await userEvent.click(screen.getByTestId("point-home"));
    const banner = await screen.findByTestId("change-ends");
    expect(banner).toHaveTextContent(/change ends/i);
  });

  it("a finished game shows the next-game step and starting it resets the pad", async () => {
    renderTT({ set_scores: [[10, 7]] });

    await userEvent.click(screen.getByTestId("point-home"));
    const prompt = await screen.findByTestId("next-game");
    expect(prompt).toHaveTextContent(/game 1 done 11-7/i);
    // Points lock while the step is pending (no stray 12-5s).
    expect(screen.getByTestId("point-home")).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /start game 2/i }));
    expect(screen.queryByTestId("next-game")).toBeNull();
    expect(screen.getByTestId("points-home")).toHaveTextContent("0");
    expect(screen.getByTestId("point-home")).toBeEnabled();
    expect(screen.getByText(/game 2 of 5 · games 1-0/i)).toBeInTheDocument();
  });

  it("scoring continues into the started game and auto-saves the rows", async () => {
    renderTT({ set_scores: [[10, 7]] });

    await userEvent.click(screen.getByTestId("point-home"));
    await userEvent.click(screen.getByTestId("start-next"));
    await userEvent.click(screen.getByTestId("point-home"));

    expect(screen.getByTestId("points-home")).toHaveTextContent("1");
    expect(screen.getByTestId("points-away")).toHaveTextContent("0");
    await waitFor(() =>
      expect(liveApi.recordSetProgress).toHaveBeenLastCalledWith("m1", {
        set_scores: [
          [11, 7],
          [1, 0],
        ],
        event_id: expect.any(String),
      }),
    );
  });

  it("Record result exists only from the clinch, then completes via confirm", async () => {
    vi.mocked(liveApi.recordSetScores).mockResolvedValue({} as never);
    renderTT({
      set_scores: [
        [11, 5],
        [11, 5],
        [10, 3],
      ],
    });
    // 2-0 up, game 3 at 10-3: not decided, so no completion button yet.
    expect(screen.queryByTestId("record-result")).toBeNull();

    await userEvent.click(screen.getByTestId("point-home"));
    expect(await screen.findByText(/alpha wins 3-0/i)).toBeInTheDocument();
    // The clinch closes the tap zones (extra points would be illegal).
    expect(screen.getByTestId("point-home")).toBeDisabled();

    await userEvent.click(screen.getByTestId("record-result"));
    await userEvent.click(screen.getByTestId("confirm-sets"));
    await waitFor(() =>
      expect(liveApi.recordSetScores).toHaveBeenCalledWith("m1", {
        set_scores: [
          [11, 5],
          [11, 5],
          [11, 3],
        ],
        event_id: expect.any(String),
      }),
    );
  });
});
