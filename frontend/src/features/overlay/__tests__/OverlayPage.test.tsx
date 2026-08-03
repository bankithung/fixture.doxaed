import { act, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveApi, type LiveSnapshot } from "@/api/live";
import { tournamentsApi, type PublicSchedulePayload } from "@/api/tournaments";
import { OverlayPage } from "../OverlayPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, publicSchedule: vi.fn() },
  };
});
vi.mock("@/api/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/live")>();
  return { ...actual, liveApi: { ...actual.liveApi, snapshot: vi.fn() } };
});

const FIELDS = {
  home_pens: null as number | null,
  away_pens: null as number | null,
  stage: "group",
  stage_no: 0,
  group_label: "",
  round_no: 1,
  match_no: 1,
  day: "2026-08-03",
  leaf_key: "table_tennis.u16",
};

type Row = PublicSchedulePayload["matches"][number];

function row(over: Partial<Row> = {}): Row {
  return {
    id: "m1",
    leaf_label: "Table Tennis · U-16 · Boys",
    status: "live",
    scheduled_at: "2026-08-03T04:00:00Z",
    venue: "Court2 · T3",
    home: { id: "h", name: "Alpha School", short_name: "ALP", school: "N" },
    away: { id: "a", name: "Bravo School", short_name: "BRA", school: "S" },
    home_score: 0,
    away_score: 0,
    sport: "table_tennis",
    set_scores: [],
    current_period: "game_1",
    ...FIELDS,
    ...over,
  } as Row;
}

function payload(matches: Row[]): PublicSchedulePayload {
  return {
    tournament: {
      id: "t1",
      slug: "cup",
      name: "Nagaland Schools Cup",
      status: "live",
      time_zone: "Asia/Kolkata",
    },
    matches,
  };
}

const TT_RULES = {
  type: "sets",
  best_of: 3,
  points: 11,
  win_by: 2,
  cap: null,
  serve: { serves_per_turn: 2, alternate_every_point: true },
};

function snapshot(over: Partial<LiveSnapshot["match"]> = {}): LiveSnapshot {
  return {
    server_time: new Date().toISOString(),
    match: {
      id: "m1",
      status: "live",
      current_period: "game_1",
      home_team: { id: "h", name: "Alpha School", short_name: "ALP", players: [] },
      away_team: { id: "a", name: "Bravo School", short_name: "BRA", players: [] },
      home_score: 0,
      away_score: 0,
      started_at: null,
      sport: "table_tennis",
      set_scores: [],
      scoring: TT_RULES,
      sport_meta: {
        key: "table_tennis",
        name: "Table Tennis",
        family: "target",
        terms: { period: "Game", score_unit: "Points" },
        version: 1,
      },
      ...over,
    },
    events: [],
  } as LiveSnapshot;
}

const COURT = "Court2 · T3";

function mount(search = "") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const url = `/overlay/t/cup/t1/court/${encodeURIComponent(COURT)}${search}`;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/overlay/t/:slug/:id/court/:court"
            element={<OverlayPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(liveApi.snapshot).mockResolvedValue(snapshot());
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe("OverlayPage — the six broadcast states", () => {
  it("1. idle: names the tournament and the court, quietly", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ id: "elsewhere", venue: "Court 9" })]),
    );
    mount();
    expect(await screen.findByTestId("overlay-idle")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-court")).toHaveTextContent(COURT);
    // Nothing on this court, so the board names the event and stays quiet.
    expect(await screen.findByText("Nagaland Schools Cup")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-root")).toHaveAttribute("data-state", "idle");
    expect(screen.queryByTestId("overlay-scorebug")).toBeNull();
  });

  it("2. up-next: the next scheduled match on this court, with its time", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([
        row({ id: "later", status: "scheduled", scheduled_at: "2026-08-03T09:00:00Z" }),
        row({ id: "sooner", status: "scheduled", scheduled_at: "2026-08-03T07:00:00Z" }),
      ]),
    );
    mount();
    expect(await screen.findByTestId("overlay-up-next")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-home-name")).toHaveTextContent("ALP");
    expect(screen.getByTestId("overlay-away-name")).toHaveTextContent("BRA");
    // 07:00Z is 12:30 in the tournament's own wall clock (invariant 14).
    expect(screen.getByTestId("overlay-kickoff")).toHaveTextContent("12:30");
  });

  it("3. live: the scorebug, with the running game score large", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ set_scores: [[11, 7], [4, 2]], home_score: 1, away_score: 0 })]),
    );
    mount();
    expect(await screen.findByTestId("overlay-scorebug")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("4");
    expect(screen.getByTestId("overlay-away-score")).toHaveTextContent("2");
    // Games won and the finished game's history sit beside it.
    expect(screen.getByTestId("overlay-home-games")).toHaveTextContent("1");
    expect(screen.getByTestId("overlay-home-history")).toHaveTextContent("11");
    expect(screen.getByTestId("overlay-away-history")).toHaveTextContent("7");
    await waitFor(() =>
      expect(screen.getByTestId("overlay-period")).toHaveTextContent("Game 2"),
    );
    expect(screen.getByTestId("overlay-live-dot")).toBeInTheDocument();
  });

  it("4. between-games: holds the completed game score and says so", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ set_scores: [[11, 7]], home_score: 1, away_score: 0 })]),
    );
    mount();
    await screen.findByTestId("overlay-scorebug");
    await waitFor(() =>
      expect(screen.getByTestId("overlay-root")).toHaveAttribute(
        "data-state",
        "between-games",
      ),
    );
    expect(screen.getByTestId("overlay-period")).toHaveTextContent("Game 1 complete");
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("11");
    expect(screen.getByTestId("overlay-away-score")).toHaveTextContent("7");
  });

  it("5. final: the result card, winning side emphasised", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([
        row({
          id: "done",
          status: "completed",
          home_score: 2,
          away_score: 1,
          set_scores: [[11, 7], [9, 11], [11, 8]],
        }),
      ]),
    );
    vi.mocked(liveApi.snapshot).mockResolvedValue(
      snapshot({ id: "done", status: "completed" }),
    );
    mount();
    expect(await screen.findByTestId("overlay-final")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-final-label")).toHaveTextContent("Final");
    // Games won become the headline; the loser's row recedes.
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("2");
    expect(screen.getByTestId("overlay-away-score")).toHaveTextContent("1");
    expect(screen.getByTestId("overlay-away-row").className).toContain("ovA__row--lost");
    expect(screen.getByTestId("overlay-home-row").className).not.toContain("--lost");
  });

  it("6. stale: keeps the last score behind an amber dot — never blank, never 0-0", async () => {
    // One good fetch, then the server goes away — a backend deploy, a dropped
    // uplink. This is the failure that must NOT blank a live broadcast.
    vi.mocked(tournamentsApi.publicSchedule)
      .mockResolvedValueOnce(payload([row({ set_scores: [[17, 14]] })]))
      .mockRejectedValue(new Error("network down"));
    vi.mocked(liveApi.snapshot).mockRejectedValue(new Error("network down"));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    expect(await screen.findByTestId("overlay-scorebug")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("17");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    const root = screen.getByTestId("overlay-root");
    expect(root).toHaveAttribute("data-state", "stale");
    expect(screen.getByTestId("overlay-stale-dot")).toBeInTheDocument();
    expect(screen.queryByTestId("overlay-live-dot")).toBeNull();
    // The whole point: the last known score is STILL on screen.
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("17");
    expect(screen.getByTestId("overlay-away-score")).toHaveTextContent("14");
  });
});

describe("OverlayPage — layout selection", () => {
  it("picks the target layout from sport_meta.family", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ set_scores: [[6, 4]] })]),
    );
    mount();
    await screen.findByTestId("overlay-scorebug");
    await waitFor(() =>
      expect(screen.getByTestId("overlay-root")).toHaveAttribute(
        "data-family",
        "target",
      ),
    );
    expect(screen.getByTestId("overlay-home-games")).toBeInTheDocument();
    expect(screen.queryByTestId("overlay-clock")).toBeNull();
  });

  it("picks the timed layout from sport_meta.family, with a running clock", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([
        row({
          leaf_label: "Football · U-15 · Boys",
          sport: "football",
          set_scores: [],
          home_score: 2,
          away_score: 1,
          current_period: "first_half",
        }),
      ]),
    );
    vi.mocked(liveApi.snapshot).mockResolvedValue(
      snapshot({
        sport: "football",
        current_period: "first_half",
        home_score: 2,
        away_score: 1,
        set_scores: [],
        scoring: null,
        started_at: new Date(Date.now() - 125_000).toISOString(),
        sport_meta: {
          key: "football",
          name: "Football",
          family: "timed",
          terms: { period: "Half", score_unit: "Goals" },
          version: 1,
        },
      }),
    );
    mount();
    await screen.findByTestId("overlay-scorebug");
    await waitFor(() =>
      expect(screen.getByTestId("overlay-root")).toHaveAttribute(
        "data-family",
        "timed",
      ),
    );
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("2");
    expect(screen.getByTestId("overlay-away-score")).toHaveTextContent("1");
    expect(screen.getByTestId("overlay-period")).toHaveTextContent("first half");
    // Codes, not full names, on the timed board.
    expect(screen.getByTestId("overlay-home-name")).toHaveTextContent("ALP");
    // The clock runs off started_at + the server's own time.
    await waitFor(() =>
      expect(screen.getByTestId("overlay-clock").textContent).toMatch(/^0[23]:\d\d$/),
    );
    // Target-only furniture must not appear.
    expect(screen.queryByTestId("overlay-home-games")).toBeNull();
  });
});

describe("OverlayPage — serve indicator", () => {
  it("marks the serving side for table tennis (rules-derived)", async () => {
    // 4-3 = 7 points played in 2-serve blocks -> away is serving.
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ set_scores: [[4, 3]] })]),
    );
    mount();
    await screen.findByTestId("overlay-scorebug");
    await waitFor(() =>
      expect(screen.getByTestId("overlay-serving-away")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("overlay-serving-home")).toBeNull();
    expect(screen.getByTestId("overlay-away-row").className).toContain(
      "ovA__row--serving",
    );
  });

  it("marks the serving side for sepak takraw (3-serve blocks)", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ sport: "sepak_takraw", set_scores: [[5, 2]] })]),
    );
    vi.mocked(liveApi.snapshot).mockResolvedValue(
      snapshot({
        sport: "sepak_takraw",
        scoring: {
          type: "sets", best_of: 3, points: 21, win_by: 2, cap: 25,
          deciding: { points: 15, win_by: 2, cap: 17 },
          serve: {
            serves_per_turn: 3,
            alternate_every_point: false,
            change_ends_at: { regular: 11, deciding: 8 },
          },
        },
        sport_meta: {
          key: "sepak_takraw", name: "Sepak Takraw", family: "target",
          terms: { period: "Set", score_unit: "Points" }, version: 1,
        },
      }),
    );
    mount();
    await screen.findByTestId("overlay-scorebug");
    // 5-2 = 7 points in blocks of 3 -> third block -> home serves.
    await waitFor(() =>
      expect(screen.getByTestId("overlay-serving-home")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("overlay-serving-away")).toBeNull();
  });

  it("shows NO serve indicator for a rally-scored sport on a cold start", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ sport: "badminton", set_scores: [[12, 9]] })]),
    );
    vi.mocked(liveApi.snapshot).mockResolvedValue(
      snapshot({
        sport: "badminton",
        // BWF ships no `serve` block: service follows the last rally.
        scoring: {
          type: "sets", best_of: 3, points: 21, win_by: 2, cap: 30,
          deciding: { points: 21, win_by: 2, cap: 30 },
        },
        sport_meta: {
          key: "badminton", name: "Badminton", family: "target",
          terms: { period: "Game", score_unit: "Points" }, version: 1,
        },
      }),
    );
    mount();
    await screen.findByTestId("overlay-scorebug");
    await waitFor(() =>
      expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("12"),
    );
    expect(screen.queryByTestId("overlay-serving-home")).toBeNull();
    expect(screen.queryByTestId("overlay-serving-away")).toBeNull();
  });
});

describe("OverlayPage — robustness on air", () => {
  it("re-serving the identical payload never blanks or re-runs the board", async () => {
    // The 10 s poll floor re-fetches constantly. An unchanged answer must be a
    // no-op on screen: same score, same nodes, no repaint churn.
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ set_scores: [[7, 5]] })]),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await screen.findByTestId("overlay-scorebug");
    await waitFor(() =>
      expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("7"),
    );
    const before = screen.getByTestId("overlay-home-row");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("7");
    expect(screen.getByTestId("overlay-home-row")).toBe(before);
    expect(screen.getByTestId("overlay-root")).toHaveAttribute("data-state", "live");
  });

  it("APPLIES a correction that lowers the score (VOID events must reach air)", async () => {
    // The platform is event-sourced so scores CAN be corrected downwards. A
    // guard that blocked that would silently keep a wrong score on the stream.
    vi.mocked(tournamentsApi.publicSchedule)
      .mockResolvedValueOnce(payload([row({ set_scores: [[7, 5]] })]))
      .mockResolvedValue(payload([row({ set_scores: [[6, 5]] })]));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await screen.findByTestId("overlay-scorebug");
    await waitFor(() =>
      expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("7"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await waitFor(() =>
      expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("6"),
    );
  });

  it("keeps THIS court's match when several courts are live", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([
        row({ id: "c1", venue: "Court 1", set_scores: [[3, 1]],
          home: { id: "x", name: "Wrong Court A", short_name: "WCA", school: "N" } }),
        row({ id: "mine", venue: COURT, set_scores: [[9, 6]] }),
        row({ id: "c3", venue: "Court 3", set_scores: [[1, 8]],
          home: { id: "y", name: "Wrong Court B", short_name: "WCB", school: "N" } }),
      ]),
    );
    mount();
    await screen.findByTestId("overlay-scorebug");
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("9");
    expect(screen.getByTestId("overlay-away-score")).toHaveTextContent("6");
    expect(screen.getByTestId("overlay-home-name")).toHaveTextContent("ALP");
    expect(screen.queryByText("WCA")).toBeNull();
    expect(screen.queryByText("WCB")).toBeNull();
  });

  it("boots from the disk cache instead of a blank frame after an OBS restart", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ set_scores: [[9, 6]] })]),
    );
    const first = mount();
    await screen.findByTestId("overlay-scorebug");
    await waitFor(() =>
      expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("9"),
    );
    first.unmount();

    // OBS restarts: same court, network still coming up (fetch never settles).
    vi.mocked(tournamentsApi.publicSchedule).mockReturnValue(
      new Promise<PublicSchedulePayload>(() => {}),
    );
    mount();
    // The first frame shows the last known score, flagged as unconfirmed —
    // not a blank bug and not 0-0.
    expect(screen.getByTestId("overlay-home-score")).toHaveTextContent("9");
    expect(screen.getByTestId("overlay-away-score")).toHaveTextContent("6");
    expect(screen.getByTestId("overlay-stale-dot")).toBeInTheDocument();
  });

  it("respects ?scale and ?side, and strips the app background while mounted", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([row({ set_scores: [[2, 2]] })]),
    );
    const { unmount } = mount("?scale=0.667&side=right");
    const root = await screen.findByTestId("overlay-root");
    expect(root.className).toContain("ov--right");
    expect(root.getAttribute("style")).toContain("--ov-scale: 0.667");
    expect(document.documentElement.hasAttribute("data-obs-overlay")).toBe(true);
    // Nothing to click, nothing to follow: no links at all on a broadcast page.
    expect(within(root).queryAllByRole("link")).toHaveLength(0);
    unmount();
    expect(document.documentElement.hasAttribute("data-obs-overlay")).toBe(false);
  });
});
