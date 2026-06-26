import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  tournamentsApi,
  type PublicSchedulePayload,
} from "@/api/tournaments";
import { PublicSchedulePage } from "../PublicSchedulePage";

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

const LIVE_FIELDS = {
  home_pens: null as number | null,
  away_pens: null as number | null,
  sport: "",
  set_scores: [] as number[][],
  current_period: "",
};

// leaf_labels carry the joined EM DASH on purpose — the page must never render
// the dashed string; it splits into chips.
const PAYLOAD: PublicSchedulePayload = {
  tournament: {
    id: "t1",
    slug: "nagaland-cup",
    name: "Nagaland Schools Cup",
    status: "live",
    time_zone: "Asia/Kolkata",
  },
  matches: [
    {
      id: "m1", leaf_key: "football.u15", leaf_label: "Football — U-15 — Boys",
      stage: "group", group_label: "Football — U-15 — Boys — Group A", round_no: 1, match_no: 1,
      status: "completed", day: "2026-06-20",
      scheduled_at: "2026-06-20T03:30:00Z", venue: "Main Ground",
      home: { id: "tm1", name: "Alpha FC", short_name: "A", school: "Alpha" },
      away: { id: "tm2", name: "Bravo FC", short_name: "B", school: "Bravo" },
      home_score: 2, away_score: 1,
      ...LIVE_FIELDS, home_pens: 4, away_pens: 3,
    },
    {
      id: "m2", leaf_key: "football.u15", leaf_label: "Football — U-15 — Boys",
      stage: "group", group_label: "Football — U-15 — Boys — Group A", round_no: 1, match_no: 2,
      status: "live", day: "2026-06-20",
      scheduled_at: "2026-06-20T05:30:00Z", venue: "Main Ground",
      home: { id: "tm3", name: "Carol FC", short_name: "C", school: "Carol" },
      away: { id: "tm4", name: "Delta FC", short_name: "D", school: "Delta" },
      home_score: 0, away_score: 0,
      ...LIVE_FIELDS, current_period: "first_half",
    },
    {
      id: "m3", leaf_key: "football.u17", leaf_label: "Football — U-17 — Boys",
      stage: "knockout", group_label: "", round_no: 1, match_no: 3,
      status: "scheduled", day: "2026-06-21",
      scheduled_at: "2026-06-21T04:00:00Z", venue: "Side Pitch",
      home: null, away: null, home_score: null, away_score: null,
      ...LIVE_FIELDS,
    },
    {
      id: "m4", leaf_key: "football.u17", leaf_label: "Football — U-17 — Boys",
      stage: "knockout", group_label: "", round_no: 2, match_no: 4,
      status: "scheduled", day: null, scheduled_at: null, venue: "",
      home: null, away: null, home_score: null, away_score: null,
      ...LIVE_FIELDS,
    },
    {
      id: "m5", leaf_key: "tt.open", leaf_label: "Table Tennis — Open — Boys",
      stage: "group", group_label: "Table Tennis — Open — Boys — Group T", round_no: 1, match_no: 5,
      status: "live", day: "2026-06-20",
      scheduled_at: "2026-06-20T06:30:00Z", venue: "Table Hall",
      home: { id: "tm5", name: "Echo TT", short_name: "E", school: "Echo" },
      away: { id: "tm6", name: "Foxtrot TT", short_name: "F", school: "Fox" },
      home_score: 1, away_score: 1,
      ...LIVE_FIELDS, sport: "table_tennis",
      set_scores: [[11, 7], [8, 11]], current_period: "set_3",
    },
  ],
};

const STANDINGS = {
  groups: [
    {
      group_label: "Football — U-15 — Boys — Group A",
      rows: [
        { team_id: "tm1", name: "Alpha FC", school: "Alpha",
          P: 1, W: 1, D: 0, L: 0, GF: 2, GA: 1, GD: 1, Pts: 3 },
        { team_id: "tm2", name: "Bravo FC", school: "Bravo",
          P: 1, W: 0, D: 0, L: 1, GF: 1, GA: 2, GD: -1, Pts: 0 },
      ],
    },
    { group_label: "", rows: [] },
  ],
};

class MockEventSource {
  static instances: MockEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  close(): void {
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(type: string, data: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/t/nagaland-cup/t1/schedule"]}>
        <Routes>
          <Route path="/t/:slug/:id/schedule" element={<PublicSchedulePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(PAYLOAD);
  vi.mocked(tournamentsApi.publicStandings).mockResolvedValue(STANDINGS);
});

describe("PublicSchedulePage", () => {
  it("defaults to a Today overview with chip labels and ZERO dashes", async () => {
    const { container } = mount();
    // smart default day = nearest >= today, else first day → 2026-06-20
    const day = await screen.findByTestId("public-day-2026-06-20");
    expect(tournamentsApi.publicSchedule).toHaveBeenCalledWith("nagaland-cup", "t1");

    // grouped under competition headers, rendered as chips (never the dashed blob)
    expect(within(day).getByText("Football")).toBeInTheDocument();
    expect(within(day).getByText("U15")).toBeInTheDocument(); // "U-14" hyphen stripped
    expect(screen.queryByText(/Football — U-15 — Boys/)).toBeNull();
    // the en/em dash is the #1 tell: it must appear NOWHERE on the page
    expect(container.textContent).not.toMatch(/[—–]/);

    // a completed match shows an ASCII scoreboard hyphen, not a dash
    const m1 = within(day).getByTestId("public-match-m1");
    expect(m1).toHaveTextContent("09:00"); // 03:30Z in Asia/Kolkata (invariant 14)
    expect(m1).toHaveTextContent("2 - 1");
    expect(m1).toHaveTextContent("Full time");
    expect(within(m1).getByTestId("points-m1")).toHaveTextContent("(4-3 pens)");

    // standalone page: viewer tabs, no app shell; a competition panel is NOT
    // open by default (you pick one from the rail)
    expect(screen.queryByTestId("app-sidebar")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Tournament views" })).toBeInTheDocument();
    expect(screen.queryByTestId("public-competition-football.u15")).toBeNull();
  });

  it("pins live matches in the Now-playing band and pulses only live rows", async () => {
    mount();
    const band = await screen.findByTestId("live-band");
    expect(within(band).getByTestId("live-tile-m2")).toBeInTheDocument();
    expect(within(band).getByTestId("live-tile-m5")).toBeInTheDocument();
    // inline live row still carries the pulse + period for context
    const m2 = screen.getByTestId("public-match-m2");
    expect(within(m2).getByTestId("live-pulse")).toBeInTheDocument();
    expect(m2).toHaveTextContent("Live");
  });

  it("shows live points: period chip, set scores, shootout result (ASCII)", async () => {
    mount();
    const m2 = await screen.findByTestId("public-match-m2");
    expect(within(m2).getByTestId("period-m2")).toHaveTextContent("first half");
    const m5 = screen.getByTestId("public-match-m5");
    expect(m5).toHaveTextContent("1 - 1");
    expect(within(m5).getByTestId("points-m5")).toHaveTextContent("11-7 · 8-11");
    expect(within(m5).getByTestId("period-m5")).toHaveTextContent("set 3");
  });

  it("rail → competition reveals the standings hero + fixtures in one click", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await userEvent.click(screen.getByTestId("rail-comp-football.u15"));

    const panel = await screen.findByTestId("public-competition-football.u15");
    // inline FIFA-style group table
    expect(within(panel).getByTestId("group-standing-tm1")).toHaveTextContent("Alpha FC");
    expect(within(panel).getByTestId("group-standing-tm1")).toHaveTextContent("3");
    // its fixtures sit under the table
    expect(within(panel).getByTestId("public-match-m1")).toBeInTheDocument();
    expect(within(panel).getByTestId("public-match-m2")).toBeInTheDocument();
  });

  it("filters the active scope by a team search and clears", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    // today scope = 3 matches on 2026-06-20 (m1, m2, m5)
    expect(screen.getByTestId("filter-count")).toHaveTextContent("3 matches");

    await userEvent.type(screen.getByTestId("filter-team"), "Echo");
    await waitFor(() =>
      expect(screen.getByTestId("filter-count")).toHaveTextContent("1 of 3"),
    );
    expect(screen.getByTestId("public-match-m5")).toBeInTheDocument();
    expect(screen.queryByTestId("public-match-m1")).toBeNull();

    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() =>
      expect(screen.getByTestId("public-match-m1")).toBeInTheDocument(),
    );
  });

  it("competition → Order of play: day sections, unscheduled bucket, print", async () => {
    const print = vi.fn();
    window.print = print;
    mount();
    await screen.findByTestId("public-day-2026-06-20");

    await userEvent.click(screen.getByTestId("rail-comp-football.u17"));
    await userEvent.click(screen.getByTestId("view-day"));

    expect(await screen.findByTestId("public-day-2026-06-21")).toBeInTheDocument();
    const bucket = screen.getByTestId("public-unscheduled");
    expect(within(bucket).getByTestId("public-match-m4")).toBeInTheDocument();

    // print sheet renders the chosen day's per-venue order of play
    const sheet = screen.getByTestId("print-sheet");
    expect(within(sheet).getByTestId("print-venue-Side Pitch")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("print-button"));
    expect(print).toHaveBeenCalled();
  });

  it("stays on the polling indicator when SSE is unavailable", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    expect(screen.getByTestId("stream-indicator")).toHaveTextContent(
      "updates automatically",
    );
  });

  it("renders a friendly error when the schedule is not public", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockRejectedValue(new Error("404"));
    mount();
    expect(
      await screen.findByText("This schedule is not available."),
    ).toBeInTheDocument();
  });

  describe("live over SSE", () => {
    beforeEach(() => {
      MockEventSource.instances = [];
      vi.stubGlobal("EventSource", MockEventSource);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("subscribes to the public stream and refetches on a tick", async () => {
      mount();
      await screen.findByTestId("public-day-2026-06-20");
      await waitFor(() =>
        expect(MockEventSource.instances.length).toBeGreaterThan(0),
      );
      const es = MockEventSource.instances[0];
      expect(es.url).toBe("/api/public/tournaments/nagaland-cup/t1/stream/");

      es.open();
      await waitFor(() =>
        expect(screen.getByTestId("stream-indicator")).toHaveTextContent(
          "live updates",
        ),
      );

      const scheduleCalls = vi.mocked(tournamentsApi.publicSchedule).mock.calls.length;
      es.emit("tick", { tournament_id: "t1", match_id: "m2", kind: "score" });
      await waitFor(
        () =>
          expect(
            vi.mocked(tournamentsApi.publicSchedule).mock.calls.length,
          ).toBeGreaterThan(scheduleCalls),
        { timeout: 2000 },
      );
    });

    it("drops back to the poll indicator when the stream errors", async () => {
      mount();
      await screen.findByTestId("public-day-2026-06-20");
      await waitFor(() =>
        expect(MockEventSource.instances.length).toBeGreaterThan(0),
      );
      const es = MockEventSource.instances[0];
      es.open();
      await waitFor(() =>
        expect(screen.getByTestId("stream-indicator")).toHaveTextContent(
          "live updates",
        ),
      );
      es.onerror?.();
      await waitFor(() =>
        expect(screen.getByTestId("stream-indicator")).toHaveTextContent(
          "updates automatically",
        ),
      );
    });
  });
});
