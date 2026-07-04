import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { liveApi, type LiveSnapshot } from "@/api/live";
import { SepakConsole } from "../SepakConsole";
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
      players: [{ id: "p1", name: "Spiker", jersey_no: 7, position: "" }],
    },
    away_team: { id: "b", name: "Beta", short_name: "BET", players: [] },
    home_score: 0,
    away_score: 0,
    sport: "sepak_takraw",
    sport_meta: {
      key: "sepak_takraw",
      name: "Sepak takraw",
      family: "target",
      terms: { period: "Set", score_unit: "Points" },
      version: 1,
    },
    set_scores: [],
    scoring: {
      type: "sets",
      best_of: 3,
      points: 21,
      win_by: 2,
      cap: 25,
      deciding: { points: 15, win_by: 2, cap: 17 },
      serve: {
        serves_per_turn: 3,
        alternate_every_point: false,
        change_ends_at: { regular: 11, deciding: 8 },
      },
    },
    ...extra,
  };
}

function renderSepak(extra: Partial<LiveSnapshot["match"]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const match = makeMatch(extra);
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SepakConsole
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

describe("SepakConsole", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    vi.mocked(liveApi.recordEvent).mockResolvedValue({} as never);
    vi.mocked(liveApi.recordSetProgress).mockResolvedValue({} as never);
  });

  it("registers as the native sepak_takraw console", () => {
    expect(resolveConsole("sepak_takraw", "target")?.Console).toBe(SepakConsole);
  });

  it("point tap bumps the current set, saves progress, and a reason chip logs the annotation", async () => {
    renderSepak();

    await userEvent.click(screen.getByTestId("point-home"));
    // The tap shows up instantly on the big scoreboard...
    expect(screen.getByTestId("set-scoreboard")).toHaveTextContent("1-0");

    // ...and opens the transient reason chips; picking one logs the
    // scoresheet annotation with its detail.
    await userEvent.click(screen.getByTestId("reason-net"));
    await waitFor(() => expect(liveApi.recordEvent).toHaveBeenCalled());
    const [mid, payload] = vi.mocked(liveApi.recordEvent).mock.calls[0];
    expect(mid).toBe("m1");
    expect(payload.event_type).toBe("point");
    expect(payload.side).toBe("home");
    expect(payload.detail).toEqual({ reason: "net", scoring_side: "home" });
    expect(payload.event_id).toBeTruthy();
    // The chips are consumed by the pick.
    expect(screen.queryByTestId("reason-net")).toBeNull();

    // The debounced live push carries the running points (progress, never
    // a completion).
    await waitFor(() =>
      expect(liveApi.recordSetProgress).toHaveBeenLastCalledWith("m1", {
        set_scores: [[1, 0]],
        event_id: expect.any(String),
      }),
    );
    expect(liveApi.recordSetScores).not.toHaveBeenCalled();
  });

  it("skipping the reason logs nothing extra", async () => {
    renderSepak();

    await userEvent.click(screen.getByTestId("point-away"));
    expect(screen.getByTestId("set-scoreboard")).toHaveTextContent("0-1");
    await userEvent.click(screen.getByRole("button", { name: /skip reason/i }));

    expect(screen.queryByTestId("reason-net")).toBeNull();
    expect(liveApi.recordEvent).not.toHaveBeenCalled();
  });

  it("serve indicator follows the three-serve rotation and the first-server toggle", async () => {
    renderSepak();

    const indicator = screen.getByTestId("serve-indicator");
    expect(indicator).toHaveTextContent("Serving: Alpha");
    expect(indicator).toHaveTextContent("Serve 1 of 3");

    // Three points hand the service turn to the other regu.
    await userEvent.click(screen.getByTestId("point-home"));
    expect(screen.getByTestId("serve-indicator")).toHaveTextContent("Serve 2 of 3");
    await userEvent.click(screen.getByTestId("point-home"));
    await userEvent.click(screen.getByTestId("point-home"));
    expect(screen.getByTestId("serve-indicator")).toHaveTextContent("Serving: Beta");
    expect(screen.getByTestId("serve-indicator")).toHaveTextContent("Serve 1 of 3");

    // Flipping the first server flips the whole rotation and persists on
    // this phone for the match.
    await userEvent.click(screen.getByRole("button", { name: /first server/i }));
    expect(screen.getByTestId("serve-indicator")).toHaveTextContent("Serving: Alpha");
    expect(localStorage.getItem("fixture.first-server.m1")).toBe("1");
  });

  it("timeout logs once per side per set, then disables", async () => {
    renderSepak();

    await userEvent.click(screen.getByTestId("timeout-home"));
    await waitFor(() => expect(liveApi.recordEvent).toHaveBeenCalled());
    const [, payload] = vi.mocked(liveApi.recordEvent).mock.calls[0];
    expect(payload.event_type).toBe("timeout");
    expect(payload.side).toBe("home");
    expect(payload.event_id).toBeTruthy();

    expect(screen.getByTestId("timeout-home")).toBeDisabled();
    expect(screen.getByTestId("timeout-home")).toHaveTextContent("1/1");
    expect(screen.getByTestId("timeout-away")).toBeEnabled();
  });

  it("a stat button logs an attributed annotation via the player pick", async () => {
    renderSepak();

    await userEvent.click(screen.getByTestId("stat-ace"));
    await userEvent.click(screen.getByRole("button", { name: /home player/i }));
    await userEvent.click(screen.getByRole("option", { name: /spiker/i }));

    await waitFor(() => expect(liveApi.recordEvent).toHaveBeenCalled());
    const [, payload] = vi.mocked(liveApi.recordEvent).mock.calls[0];
    expect(payload.event_type).toBe("ace");
    expect(payload.side).toBe("home");
    expect(payload.player_id).toBe("p1");
    expect(payload.event_id).toBeTruthy();
  });

  it("prompts a change of ends when a side first reaches 11", async () => {
    renderSepak({ set_scores: [[10, 5]] });
    expect(screen.queryByTestId("change-ends")).toBeNull();

    await userEvent.click(screen.getByTestId("point-home"));
    expect(await screen.findByTestId("change-ends")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
    expect(screen.queryByTestId("change-ends")).toBeNull();
  });

  it("records the final set result through the confirm dialog", async () => {
    vi.mocked(liveApi.recordSetScores).mockResolvedValue({} as never);
    renderSepak({
      set_scores: [
        [21, 15],
        [21, 10],
      ],
    });

    await userEvent.click(screen.getByRole("button", { name: /record result/i }));
    await userEvent.click(screen.getByTestId("confirm-sets"));

    await waitFor(() =>
      expect(liveApi.recordSetScores).toHaveBeenCalledWith("m1", {
        set_scores: [
          [21, 15],
          [21, 10],
        ],
        event_id: expect.any(String),
      }),
    );
  });
});
