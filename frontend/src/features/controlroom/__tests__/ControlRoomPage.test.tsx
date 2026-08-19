import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { liveApi } from "@/api/live";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type ControlRoomPayload,
  type StagePayload,
} from "@/api/tournaments";
import { useAuthStore } from "@/features/auth/authStore";
import type { User } from "@/types/user";
import { ControlRoomPage } from "../ControlRoomPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      controlRoom: vi.fn(),
      stage: vi.fn(),
      scheduleChanges: vi.fn(),
      score: vi.fn(),
      scoreSets: vi.fn(),
    },
  };
});

vi.mock("@/api/live", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/live")>();
  return {
    ...actual,
    liveApi: {
      ...actual.liveApi,
      callMatch: vi.fn(),
      uncallMatch: vi.fn(),
      transition: vi.fn(),
    },
  };
});

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

function row(
  over: Partial<ControlRoomMatch> & { id: string },
): ControlRoomMatch {
  return {
    stage: "group",
    group_label: "Group A",
    round_no: 1,
    match_no: 1,
    status: "scheduled",
    home_team: { id: "tmh", name: "Alpha FC", short_name: "ALP" },
    away_team: { id: "tma", name: "Bravo FC", short_name: "BRA" },
    home_score: null,
    away_score: null,
    sport: "",
    set_scores: [],
    leaf_key: "football.u15",
    venue: "Main Ground",
    scoring: null,
    scheduled_at: "2026-06-20T03:30:00Z",
    locked_at: null,
    home_pens: null,
    away_pens: null,
    current_period: "",
    called_at: null,
    leaf_label: "Football · U15",
    scorer: null,
    officials: [],
    ...over,
  };
}

const M1 = row({
  id: "m1",
  status: "live",
  current_period: "first_half",
  home_score: 1,
  away_score: 0,
});
const M2 = row({
  id: "m2",
  scheduled_at: "2026-06-20T05:30:00Z",
  called_at: "2026-06-20T05:20:00Z",
});
const M3 = row({
  id: "m3",
  status: "completed",
  home_score: 2,
  away_score: 1,
  venue: "Side Pitch",
});
const M4 = row({
  id: "m4",
  scheduled_at: "2026-06-20T06:30:00Z",
  venue: "Side Pitch",
});

const ROOM: ControlRoomPayload = {
  tournament: {
    id: "t1",
    name: "Nagaland Schools Cup",
    slug: "nagaland-cup",
    status: "scheduled",
    time_zone: "Asia/Kolkata",
  },
  days: [
    { date: "2026-06-20", counts: { total: 4, completed: 1, live: 1 } },
    { date: "2026-06-21", counts: { total: 2, completed: 0, live: 0 } },
  ],
  day: "2026-06-20",
  venues: [
    { venue: "Main Ground", matches: [M1, M2] },
    { venue: "Side Pitch", matches: [M3, M4] },
  ],
  queue: [M2, M4],
};

const STAGE_BASE: StagePayload = {
  stage: "ready",
  status: "scheduled",
  order: ["setup", "fixtures", "ready"],
  allowed_to: [],
  can_manage: false,
  modules: [],
  rules_frozen_at: null,
  stages: [],
};
const MANAGER: StagePayload = { ...STAGE_BASE, can_manage: true };
const VIEWER: StagePayload = {
  ...STAGE_BASE,
  modules: ["match.center_admin_view"],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/control"]}>
          <Routes>
            <Route
              path="/tournaments/:id/control"
              element={<ControlRoomPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  vi.mocked(tournamentsApi.controlRoom).mockResolvedValue(ROOM);
  vi.mocked(tournamentsApi.stage).mockResolvedValue(MANAGER);
  vi.mocked(tournamentsApi.scheduleChanges).mockResolvedValue({ results: [] });
  vi.mocked(tournamentsApi.score).mockResolvedValue(M3);
  vi.mocked(tournamentsApi.scoreSets).mockResolvedValue(M3);
  vi.mocked(liveApi.callMatch).mockResolvedValue({ match: M4 });
  vi.mocked(liveApi.uncallMatch).mockResolvedValue({ match: M2 });
  vi.mocked(liveApi.transition).mockResolvedValue({});
  // Default to a signed-out viewer; the My-matches test sets a scorer.
  useAuthStore.setState({ user: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ControlRoomPage", () => {
  it("renders the day board: day chips + one combined tabbed section", async () => {
    mount();

    // Day chips with progress counts; the server-defaulted day is selected.
    const chip = await screen.findByTestId("day-chip-2026-06-20");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    expect(chip).toHaveTextContent("1/4");
    expect(screen.getByTestId("day-chip-2026-06-21")).toBeInTheDocument();

    // Everything lives in ONE board with five tabs (redesign 2026-07-14).
    const board = screen.getByTestId("day-board");
    for (const tab of [
      "Run of play",
      "Courts today",
      "Leaders",
      "Competition progress",
      "Change history",
    ]) {
      expect(within(board).getByRole("tab", { name: new RegExp(tab) })).toBeInTheDocument();
    }

    // Run of play is the default tab, on its "Now & next" filter: the in-play
    // match's row is there with its actions, the finished one is not.
    expect(screen.getByTestId("board-tab-play")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(board).getByTestId("tile-m1")).toBeInTheDocument();
    expect(within(board).queryByTestId("tile-m3")).toBeNull();

    // And a jump to the full matches board (where every action lives).
    expect(
      screen.getByRole("link", { name: "Matches board" }),
    ).toBeInTheDocument();
  });

  it("the run-of-play filters swap the feed: results, then needs-attention", async () => {
    mount();
    const board = await screen.findByTestId("day-board");

    // Results: only the finished match, with its score.
    await userEvent.click(screen.getByTestId("feed-filter-results"));
    expect(within(board).getByTestId("tile-m3")).toBeInTheDocument();
    expect(within(board).getByText("2 - 1")).toBeInTheDocument();
    expect(within(board).queryByTestId("tile-m1")).toBeNull();
    // The board reads as a sheet — named columns, winner among them (owner
    // 2026-08-15) — and a settled match names the side that won.
    expect(within(board).getByTestId("match-sheet-header")).toHaveTextContent(
      "Winner",
    );
    expect(within(board).getByTestId("winner-m3")).toHaveTextContent("Alpha FC");

    // The ops band's "Needs you" cell jumps back to the exceptions filter.
    await userEvent.click(screen.getByTestId("ops-needs-you"));
    expect(screen.getByTestId("feed-filter-attention")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // m2 is called-but-not-started; the live and finished ones are not exceptions.
    expect(within(board).getByTestId("tile-m2")).toBeInTheDocument();
    expect(within(board).queryByTestId("tile-m3")).toBeNull();
  });

  // --- crests -------------------------------------------------------------
  // A school's badge is how an operator matches a row to the shirts in front
  // of them, so it rides the name everywhere a team is named in operations.
  const ALPHA = {
    id: "tmh",
    name: "Alpha FC",
    short_name: "ALP",
    crest: "https://cdn.test/alpha.png",
  };
  const CRESTED = row({ id: "c-live", status: "live", home_team: ALPHA });
  const SETTLED = row({
    id: "c-done",
    status: "completed",
    home_score: 2,
    away_score: 1,
    home_team: ALPHA,
  });
  const QUEUED = row({
    id: "c-next",
    scheduled_at: "2026-06-20T08:30:00Z",
    home_team: ALPHA,
  });
  const PLACEHOLDER = row({
    id: "c-tbd",
    scheduled_at: "2026-06-20T09:30:00Z",
    venue: "Side Pitch",
    home_team: null,
    away_team: null,
  });
  const CREST_ROOM: ControlRoomPayload = {
    ...ROOM,
    venues: [
      { venue: "Main Ground", matches: [CRESTED, SETTLED, QUEUED] },
      { venue: "Side Pitch", matches: [PLACEHOLDER] },
    ],
    queue: [QUEUED, PLACEHOLDER],
  };

  it("puts each team's crest beside its name on the sheet, winner included", async () => {
    vi.mocked(tournamentsApi.controlRoom).mockResolvedValue(CREST_ROOM);
    mount();
    const board = await screen.findByTestId("day-board");
    await userEvent.click(screen.getByTestId("feed-filter-all"));

    // An uploaded badge is a real <img>; a team with none still gets a badge,
    // its initials, so the row never shows a gap where a crest should be.
    const line = within(board).getByTestId("tile-c-live");
    expect(within(line).getByTestId("team-crest")).toHaveAttribute(
      "src",
      "https://cdn.test/alpha.png",
    );
    expect(within(line).getAllByTestId("team-crest-fallback")).toHaveLength(1);

    // The Winner cell names the winning side, so it carries that side's crest.
    const winner = within(board).getByTestId("winner-c-done");
    expect(within(winner).getByTestId("team-crest")).toBeInTheDocument();
    expect(winner).toHaveTextContent("Alpha FC");

    // An unresolved bracket slot has no school behind it: no crest, and no
    // initials of the word "TBD" pretending to be one.
    const placeholder = within(board).getByTestId("tile-c-tbd");
    expect(within(placeholder).queryByTestId("team-crest")).toBeNull();
    expect(within(placeholder).queryByTestId("team-crest-fallback")).toBeNull();
  });

  it("carries the crest into the ops band, the courts tab and the printed sheet", async () => {
    vi.mocked(tournamentsApi.controlRoom).mockResolvedValue(CREST_ROOM);
    mount();

    // Up next: the glance cell, where a badge beats a three-letter short name.
    const band = await screen.findByTestId("ops-band");
    expect(within(band).getByTestId("team-crest")).toHaveAttribute(
      "src",
      "https://cdn.test/alpha.png",
    );
    expect(within(band).getByTestId("team-crest-fallback")).toBeInTheDocument();

    // The day sheet is a printed deliverable, and an <img> prints where a CSS
    // background would not — so the crest is on the paper too.
    const printed = screen.getByTestId("day-sheet");
    expect(within(printed).getAllByTestId("team-crest").length).toBeGreaterThan(
      0,
    );

    // A court's now/next line names two teams, so it badges them both.
    await userEvent.click(screen.getByTestId("board-tab-courts"));
    const court = screen.getByTestId("court-row-Main Ground");
    expect(within(court).getByTestId("team-crest")).toBeInTheDocument();
    expect(within(court).getByTestId("team-crest-fallback")).toBeInTheDocument();
  });

  it("the Ongoing tab shows only what is being played right now", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("board-tab-live"));

    const board = screen.getByTestId("day-board");
    // m1 is live; the scheduled and completed ones are not.
    expect(within(board).getByTestId("tile-m1")).toBeInTheDocument();
    expect(within(board).queryByTestId("tile-m2")).toBeNull();
    expect(within(board).queryByTestId("tile-m3")).toBeNull();
    // And it keeps its actions, so you can act on a live match from here.
    expect(within(board).getByTestId("actions-m1")).toBeInTheDocument();
  });

  it("the Ongoing tab says so when nothing is in play", async () => {
    vi.mocked(tournamentsApi.controlRoom).mockResolvedValue({
      ...ROOM,
      venues: [
        { venue: "Main Ground", matches: [M2] },
        { venue: "Side Pitch", matches: [M3, M4] },
      ],
    });
    mount();
    await userEvent.click(await screen.findByTestId("board-tab-live"));
    expect(
      screen.getByText("Nothing is being played right now."),
    ).toBeInTheDocument();
  });

  it("the courts tab lists every venue, and a court opens its own day", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("board-tab-courts"));

    const board = screen.getByTestId("day-board");
    expect(within(board).getByText("Main Ground")).toBeInTheDocument();
    expect(within(board).getByText("Side Pitch")).toBeInTheDocument();
    // Courts start closed: the run-of-play feed is gone with the tab switch,
    // and no court's matches are on screen yet.
    expect(within(board).queryByTestId("tile-m1")).toBeNull();

    // Opening a court reveals every match on it that day (m1 + m2 on Main),
    // and only those — Side Pitch's matches stay closed.
    await userEvent.click(screen.getByTestId("court-row-Main Ground"));
    expect(screen.getByTestId("court-row-Main Ground")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(board).getByTestId("tile-m1")).toBeInTheDocument();
    expect(within(board).getByTestId("tile-m2")).toBeInTheDocument();
    expect(within(board).queryByTestId("tile-m3")).toBeNull();

    // And they are the full action rows, not a read-only list.
    expect(within(board).getByTestId("actions-m2")).toBeInTheDocument();

    // Clicking again closes it.
    await userEvent.click(screen.getByTestId("court-row-Main Ground"));
    expect(within(board).queryByTestId("tile-m1")).toBeNull();
  });

  it("shows the operations band with the day's live + progress counts", async () => {
    mount();
    const band = await screen.findByTestId("ops-band");
    // Today cell: 1 of 4 done; On-now cell: 1 live.
    expect(band).toHaveTextContent("1/4");
    expect(band).toHaveTextContent(/on now/i);
    expect(band).toHaveTextContent(/up next/i);
  });

  it("selecting another day re-fetches the aggregate for it", async () => {
    mount();
    await screen.findByTestId("day-chip-2026-06-21");

    await userEvent.click(screen.getByTestId("day-chip-2026-06-21"));

    await waitFor(() =>
      expect(tournamentsApi.controlRoom).toHaveBeenCalledWith(
        "t1",
        "2026-06-21",
      ),
    );
    expect(screen.getByTestId("day-chip-2026-06-21")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("a plain member assigned as scorer gets a focused 'My matches' lane", async () => {
    useAuthStore.setState({ user: { id: "u-me" } as unknown as User });
    vi.mocked(tournamentsApi.stage).mockResolvedValue(VIEWER);
    const mine = row({ id: "mine", scorer: { id: "u-me", name: "Me" } });
    vi.mocked(tournamentsApi.controlRoom).mockResolvedValue({
      ...ROOM,
      venues: [
        { venue: "Main Ground", matches: [mine, M2] },
        { venue: "Side Pitch", matches: [M3, M4] },
      ],
    });
    mount();

    expect(await screen.findByTestId("my-matches")).toBeInTheDocument();
    expect(screen.getByTestId("tile-mine")).toBeInTheDocument();
    // The full venue board + ops band are replaced by the focused lane.
    expect(screen.queryByTestId("lane-Side Pitch")).toBeNull();
    expect(screen.queryByTestId("ops-band")).toBeNull();
    // And the member can score it — the console is the promoted action.
    expect(screen.getByTestId("console-mine")).toBeInTheDocument();
  });

  it("subscribes to the public SSE stream and refetches on a tick", async () => {
    mount();
    await screen.findByText("Now & next");

    await waitFor(() =>
      expect(MockEventSource.instances.length).toBeGreaterThan(0),
    );
    const es = MockEventSource.instances[0];
    expect(es.url).toBe("/api/public/tournaments/nagaland-cup/t1/stream/");

    es.open();
    await waitFor(() =>
      expect(screen.getByTestId("stream-status")).toHaveTextContent(
        "Live",
      ),
    );

    const calls = vi.mocked(tournamentsApi.controlRoom).mock.calls.length;
    es.emit("tick", { tournament_id: "t1", match_id: "m1", kind: "score" });
    // Tick → debounced invalidation → the aggregate refetches.
    await waitFor(
      () =>
        expect(
          vi.mocked(tournamentsApi.controlRoom).mock.calls.length,
        ).toBeGreaterThan(calls),
      { timeout: 2000 },
    );
  });

  it("degrades to the polling indicator when the stream errors", async () => {
    mount();
    await screen.findByText("Now & next");
    await waitFor(() =>
      expect(MockEventSource.instances.length).toBeGreaterThan(0),
    );
    const es = MockEventSource.instances[0];

    es.open();
    await waitFor(() =>
      expect(screen.getByTestId("stream-status")).toHaveTextContent(
        "Live",
      ),
    );

    es.onerror?.();
    await waitFor(() =>
      expect(screen.getByTestId("stream-status")).toHaveTextContent(
        "Polling",
      ),
    );
  });

  it("renders an empty state when nothing is scheduled yet", async () => {
    vi.mocked(tournamentsApi.controlRoom).mockResolvedValue({
      ...ROOM,
      days: [],
      day: null,
      venues: [],
      queue: [],
    });
    mount();
    expect(
      await screen.findByText("Nothing is on the calendar yet"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("queue-rail")).toBeNull();
  });
});
