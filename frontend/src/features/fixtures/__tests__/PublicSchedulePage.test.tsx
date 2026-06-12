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

/** §2.d live-points fields every public match row now carries. */
const LIVE_FIELDS = {
  home_pens: null as number | null,
  away_pens: null as number | null,
  sport: "",
  set_scores: [] as number[][],
  current_period: "",
};

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
      id: "m1", leaf_key: "football.u15", leaf_label: "Football · U15",
      stage: "group", group_label: "Group A", round_no: 1, match_no: 1,
      status: "completed", day: "2026-06-20",
      scheduled_at: "2026-06-20T03:30:00Z", venue: "Main Ground",
      home: { id: "tm1", name: "Alpha FC", short_name: "A", school: "Alpha" },
      away: { id: "tm2", name: "Bravo FC", short_name: "B", school: "Bravo" },
      home_score: 2, away_score: 1,
      ...LIVE_FIELDS, home_pens: 4, away_pens: 3,
    },
    {
      id: "m2", leaf_key: "football.u15", leaf_label: "Football · U15",
      stage: "group", group_label: "Group A", round_no: 1, match_no: 2,
      status: "live", day: "2026-06-20",
      scheduled_at: "2026-06-20T05:30:00Z", venue: "Main Ground",
      home: { id: "tm3", name: "Carol FC", short_name: "C", school: "Carol" },
      away: { id: "tm4", name: "Delta FC", short_name: "D", school: "Delta" },
      home_score: 0, away_score: 0,
      ...LIVE_FIELDS, current_period: "first_half",
    },
    {
      id: "m3", leaf_key: "football.u17", leaf_label: "Football · U17",
      stage: "knockout", group_label: "", round_no: 1, match_no: 3,
      status: "scheduled", day: "2026-06-21",
      scheduled_at: "2026-06-21T04:00:00Z", venue: "Side Pitch",
      home: null, away: null, home_score: null, away_score: null,
      ...LIVE_FIELDS,
    },
    {
      id: "m4", leaf_key: "football.u17", leaf_label: "Football · U17",
      stage: "knockout", group_label: "", round_no: 2, match_no: 4,
      status: "scheduled", day: null, scheduled_at: null, venue: "",
      home: null, away: null, home_score: null, away_score: null,
      ...LIVE_FIELDS,
    },
    {
      // Set sport mid-match: home/away_score = sets won, per-set points along.
      id: "m5", leaf_key: "tt.open", leaf_label: "Table Tennis · Open",
      stage: "group", group_label: "Group T", round_no: 1, match_no: 5,
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
      group_label: "Group A",
      rows: [
        { team_id: "tm1", name: "Alpha FC", school: "Alpha",
          P: 1, W: 1, D: 0, L: 0, GF: 2, GA: 1, GD: 1, Pts: 3 },
        { team_id: "tm2", name: "Bravo FC", school: "Bravo",
          P: 1, W: 0, D: 0, L: 1, GF: 1, GA: 2, GD: -1, Pts: 0 },
      ],
    },
    { group_label: "", rows: [] }, // empty groups never render
  ],
};

/** Minimal EventSource double: registry + manual open/tick/error firing. */
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
  it("renders the read-only schedule grouped by day, in tournament-local time", async () => {
    mount();
    expect(
      await screen.findByTestId("public-day-2026-06-20"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("public-day-2026-06-21")).toBeInTheDocument();
    expect(
      tournamentsApi.publicSchedule,
    ).toHaveBeenCalledWith("nagaland-cup", "t1");

    // 03:30Z in Asia/Kolkata = 09:00 wall clock (invariant 14)
    const m1 = screen.getByTestId("public-match-m1");
    expect(m1).toHaveTextContent("09:00");
    expect(m1).toHaveTextContent("Main Ground");
    expect(m1).toHaveTextContent("2 – 1"); // final score shown
    expect(m1).toHaveTextContent("Full time");

    // competition chip + TBD sides for the unresolved knockout match
    const m3 = screen.getByTestId("public-match-m3");
    expect(m3).toHaveTextContent("Football · U17");
    expect(within(m3).getAllByText("TBD")).toHaveLength(2);

    // no auth chrome: it is a standalone page, not the app shell
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("shows the live pulse on in-flight matches", async () => {
    mount();
    const m2 = await screen.findByTestId("public-match-m2");
    expect(within(m2).getByTestId("live-pulse")).toBeInTheDocument();
    expect(m2).toHaveTextContent("Live");
  });

  it("collects unscheduled matches under 'Time to be announced'", async () => {
    mount();
    const bucket = await screen.findByTestId("public-unscheduled");
    expect(within(bucket).getByTestId("public-match-m4")).toBeInTheDocument();
  });

  it("shows live match points: period chip, set scores and a shootout result", async () => {
    mount();
    // live football: the running period rides next to the status pill
    const m2 = await screen.findByTestId("public-match-m2");
    expect(within(m2).getByTestId("period-m2")).toHaveTextContent("first half");
    // set sport: sets won as the score + per-set points underneath
    const m5 = screen.getByTestId("public-match-m5");
    expect(m5).toHaveTextContent("1 – 1");
    expect(within(m5).getByTestId("points-m5")).toHaveTextContent("11-7 · 8-11");
    expect(within(m5).getByTestId("period-m5")).toHaveTextContent("set 3");
    // decided on penalties: the shootout result tags the final score
    const m1 = screen.getByTestId("public-match-m1");
    expect(within(m1).getByTestId("points-m1")).toHaveTextContent("(4–3 pens)");
    // a plain scheduled match carries no points line
    expect(
      within(screen.getByTestId("public-match-m3")).queryByTestId("points-m3"),
    ).toBeNull();
  });

  it("renders collapsible standings per group from the public endpoint", async () => {
    mount();
    const section = await screen.findByTestId("public-standings");
    expect(tournamentsApi.publicStandings).toHaveBeenCalledWith(
      "nagaland-cup",
      "t1",
    );
    // collapsed by default — no rows on screen yet
    expect(within(section).queryByTestId("standing-tm1")).toBeNull();
    // empty groups never render a toggle
    expect(within(section).queryByTestId("standings-toggle-Overall")).toBeNull();

    await userEvent.click(
      within(section).getByTestId("standings-toggle-Group A"),
    );
    expect(within(section).getByTestId("standing-tm1")).toHaveTextContent(
      "Alpha FC",
    );
    expect(within(section).getByTestId("standing-tm1")).toHaveTextContent("3");
  });

  it("stays on the polling indicator when SSE is unavailable", async () => {
    // jsdom has no EventSource — the page keeps today's 60 s poll behavior.
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    expect(screen.getByTestId("stream-indicator")).toHaveTextContent(
      "updates automatically",
    );
  });

  it("renders a friendly error when the schedule is not public", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockRejectedValue(
      new Error("404"),
    );
    mount();
    expect(
      await screen.findByText("This schedule is not available."),
    ).toBeInTheDocument();
  });

  it("print sheet: first day by default, grouped by venue, time-ordered", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");

    const sheet = screen.getByTestId("print-sheet");
    // page-per-venue order-of-play for the default (first) day
    const venue = within(sheet).getByTestId("print-venue-Main Ground");
    expect(venue.className).toContain("break-after-page");
    expect(venue).toHaveTextContent("Nagaland Schools Cup - Order of play");
    const rows = within(venue).getAllByRole("row").slice(1); // skip header
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("09:00"); // time-ordered
    expect(rows[0]).toHaveTextContent("Alpha FC vs Bravo FC");
    expect(rows[1]).toHaveTextContent("11:00");
    // day 2's venue is not on day 1's sheet
    expect(within(sheet).queryByTestId("print-venue-Side Pitch")).toBeNull();
  });

  it("the day picker re-targets the print sheet; Print calls window.print", async () => {
    const print = vi.fn();
    window.print = print;
    mount();
    await screen.findByTestId("public-day-2026-06-20");

    await userEvent.click(screen.getByRole("button", { name: "Day to print" }));
    await userEvent.click(screen.getByRole("option", { name: /June 21/ }));
    const sheet = screen.getByTestId("print-sheet");
    expect(
      within(sheet).getByTestId("print-venue-Side Pitch"),
    ).toBeInTheDocument();
    expect(
      within(sheet).queryByTestId("print-venue-Main Ground"),
    ).toBeNull();

    await userEvent.click(screen.getByTestId("print-button"));
    expect(print).toHaveBeenCalled();
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

      const scheduleCalls =
        vi.mocked(tournamentsApi.publicSchedule).mock.calls.length;
      const standingsCalls =
        vi.mocked(tournamentsApi.publicStandings).mock.calls.length;
      es.emit("tick", { tournament_id: "t1", match_id: "m2", kind: "score" });
      // tick → debounced invalidation → schedule AND standings refetch
      await waitFor(
        () => {
          expect(
            vi.mocked(tournamentsApi.publicSchedule).mock.calls.length,
          ).toBeGreaterThan(scheduleCalls);
          expect(
            vi.mocked(tournamentsApi.publicStandings).mock.calls.length,
          ).toBeGreaterThan(standingsCalls);
        },
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
      // graceful fallback: exactly the pre-SSE page (60 s poll + plain copy)
      await waitFor(() =>
        expect(screen.getByTestId("stream-indicator")).toHaveTextContent(
          "updates automatically",
        ),
      );
    });
  });
});
