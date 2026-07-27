import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type StagePayload,
  type Tournament,
} from "@/api/tournaments";
import { useAuthStore } from "@/features/auth/authStore";
import type { User } from "@/types/user";
import { MyTasksPage } from "../MyTasksPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      matchesEnriched: vi.fn(),
      stage: vi.fn(),
      get: vi.fn(),
    },
  };
});

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {}
}

const ME = "u-me";

function row(over: Partial<ControlRoomMatch> & { id: string }): ControlRoomMatch {
  return {
    stage: "group",
    group_label: "Group A",
    round_no: 1,
    match_no: 1,
    status: "scheduled",
    home_team: { id: "th", name: "Alpha", short_name: "ALP" },
    away_team: { id: "ta", name: "Bravo", short_name: "BRA" },
    home_score: null,
    away_score: null,
    sport: "",
    set_scores: [],
    leaf_key: "table_tennis.u19",
    venue: "Court2 · T3",
    scoring: null,
    scheduled_at: "2026-08-29T04:00:00Z",
    locked_at: null,
    leaf_label: "Table Tennis U19",
    scorer: null,
    officials: [],
    ...over,
  };
}

// MINE_SCORING: I hold the scoring seat. MINE_REF: I am an official (the case
// the board's old scorer-only "My matches" toggle missed). MINE_DONE: mine and
// finished, on another day/competition. NOT_MINE: someone else's entirely.
const MINE_SCORING = row({ id: "m1", scorer: { id: ME, name: "Me" } });
const MINE_REF = row({
  id: "m2",
  scheduled_at: "2026-08-29T06:00:00Z",
  status: "live",
  venue: "Court · T1",
  officials: [
    { id: "o1", user_id: ME, name: "Me", role: "referee", status: "accepted" },
  ],
});
const MINE_DONE = row({
  id: "m3",
  scheduled_at: "2026-08-30T04:00:00Z",
  status: "completed",
  leaf_key: "sepak_takraw.u14",
  leaf_label: "Sepak Takraw U14",
  home_score: 2,
  away_score: 1,
  scorer: { id: ME, name: "Me" },
});
const NOT_MINE = row({
  id: "m4",
  scorer: { id: "u-other", name: "Other" },
  officials: [
    {
      id: "o2",
      user_id: "u-other",
      name: "Other",
      role: "umpire",
      status: "assigned",
    },
  ],
  home_team: { id: "tx", name: "Zulu", short_name: "ZUL" },
});

const TOURNAMENT = {
  id: "t1",
  slug: "cup",
  name: "Cup",
  status: "scheduled",
  time_zone: "Asia/Kolkata",
} as Tournament;

const MEMBER: StagePayload = {
  stage: "ready",
  status: "scheduled",
  order: ["setup", "fixtures", "ready"],
  allowed_to: [],
  can_manage: false,
  modules: ["match.center_admin_view", "match.scoring_console"],
  rules_frozen_at: null,
  stages: [],
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/my-tasks"]}>
          <Routes>
            <Route path="/tournaments/:id/my-tasks" element={<MyTasksPage />} />
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
  useAuthStore.setState({ user: { id: ME } as unknown as User });
  vi.mocked(tournamentsApi.matchesEnriched).mockResolvedValue([
    MINE_SCORING,
    MINE_REF,
    MINE_DONE,
    NOT_MINE,
  ]);
  vi.mocked(tournamentsApi.stage).mockResolvedValue(MEMBER);
  vi.mocked(tournamentsApi.get).mockResolvedValue(TOURNAMENT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ user: null });
});

describe("MyTasksPage", () => {
  it("shows only my matches — either seat — and never anyone else's", async () => {
    mount();
    await screen.findByTestId("mytasks-list");

    expect(screen.getByTestId("tile-m1")).toBeInTheDocument(); // scoring seat
    expect(screen.getByTestId("tile-m2")).toBeInTheDocument(); // officiating
    expect(screen.getByTestId("tile-m3")).toBeInTheDocument(); // mine, finished
    expect(screen.queryByTestId("tile-m4")).toBeNull(); // someone else's
    // The count states the scope, not the whole fixture.
    expect(screen.getByTestId("mytasks-stat-all")).toHaveTextContent("3");
  });

  it("labels what I am on each match (scoring vs officiating)", async () => {
    mount();
    await screen.findByTestId("mytasks-list");

    expect(screen.getByTestId("myrole-m1")).toHaveTextContent(/scoring/i);
    expect(screen.getByTestId("myrole-m2")).toHaveTextContent(/referee/i);
    expect(screen.getByTestId("myrole-m2")).not.toHaveTextContent(/scoring/i);
  });

  it("the role filter splits scoring from officiating", async () => {
    mount();
    await screen.findByTestId("mytasks-list");

    await userEvent.click(screen.getByRole("button", { name: /my role/i }));
    await userEvent.click(screen.getByRole("option", { name: /i am officiating/i }));
    expect(screen.getByTestId("tile-m2")).toBeInTheDocument();
    expect(screen.queryByTestId("tile-m1")).toBeNull();
    expect(screen.queryByTestId("tile-m3")).toBeNull();
  });

  it("stat cells filter the list to exactly what they count", async () => {
    mount();
    await screen.findByTestId("mytasks-list");

    expect(screen.getByTestId("mytasks-stat-live")).toHaveTextContent("1");
    await userEvent.click(screen.getByTestId("mytasks-stat-live"));
    expect(screen.getByTestId("tile-m2")).toBeInTheDocument();
    expect(screen.queryByTestId("tile-m1")).toBeNull();

    await userEvent.click(screen.getByTestId("mytasks-stat-done"));
    expect(screen.getByTestId("tile-m3")).toBeInTheDocument();
    expect(screen.queryByTestId("tile-m2")).toBeNull();
  });

  it("search narrows within my matches only", async () => {
    mount();
    await screen.findByTestId("mytasks-list");

    await userEvent.type(screen.getByTestId("mytasks-search"), "sepak");
    expect(screen.getByTestId("tile-m3")).toBeInTheDocument();
    expect(screen.queryByTestId("tile-m1")).toBeNull();
    // A team that only exists on someone else's match stays invisible.
    await userEvent.clear(screen.getByTestId("mytasks-search"));
    await userEvent.type(screen.getByTestId("mytasks-search"), "zulu");
    expect(screen.queryByTestId("tile-m4")).toBeNull();
  });

  it("groups by day out of the box and regroups on demand", async () => {
    mount();
    await screen.findByTestId("mytasks-list");
    // Two assigned days -> two day bands.
    expect(screen.getByText(/Sat, Aug 29/i)).toBeInTheDocument();
    expect(screen.getByText(/Sun, Aug 30/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /group by/i }));
    await userEvent.click(
      screen.getByRole("option", { name: /group by competition/i }),
    );
    // Scope to the band headings — the labels also appear inside each row.
    expect(
      screen.getByRole("heading", { name: "Sepak Takraw U14" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Table Tennis U19" }),
    ).toBeInTheDocument();
  });

  describe("on a phone", () => {
    // useBreakpoint reads window.innerWidth through useSyncExternalStore, so a
    // narrow viewport is all it takes to get the mobile shell under test.
    beforeEach(() => {
      vi.stubGlobal("innerWidth", 390);
    });

    it("puts the filters behind a bottom bar, not an inline bar", async () => {
      mount();
      await screen.findByTestId("mytasks-list");

      expect(screen.getByTestId("mytasks-bottom-bar")).toBeInTheDocument();
      // The controls are NOT on the page until the drawer is opened.
      expect(screen.queryByTestId("mytasks-search")).toBeNull();
      expect(screen.queryByTestId("mytasks-role")).toBeNull();
      expect(screen.queryByTestId("mytasks-filter-sheet")).toBeNull();
    });

    it("opens the drawer, filters from it, and closes on apply", async () => {
      mount();
      await screen.findByTestId("mytasks-list");

      await userEvent.click(screen.getByTestId("mytasks-filters-open"));
      const sheet = await screen.findByTestId("mytasks-filter-sheet");
      expect(sheet).toBeInTheDocument();
      // A real dialog: focus-trapped and Escape-dismissable.
      expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");

      await userEvent.click(screen.getByTestId("mytasks-status-live"));
      await userEvent.click(screen.getByTestId("mytasks-sheet-apply"));
      expect(screen.queryByTestId("mytasks-filter-sheet")).toBeNull();
      expect(screen.getByTestId("tile-m2")).toBeInTheDocument();
      expect(screen.queryByTestId("tile-m1")).toBeNull();
    });

    it("surfaces what is applied as removable chips + a count badge", async () => {
      mount();
      await screen.findByTestId("mytasks-list");
      // Nothing applied yet: no chip row, no badge.
      expect(screen.queryByTestId("mytasks-active-filters")).toBeNull();
      expect(screen.queryByTestId("mytasks-filter-count")).toBeNull();

      await userEvent.click(screen.getByTestId("mytasks-stat-live"));
      expect(await screen.findByTestId("mytasks-active-filters")).toHaveTextContent(
        /live/i,
      );
      expect(screen.getByTestId("mytasks-filter-count")).toHaveTextContent("1");

      // The chip clears its own filter without opening the drawer.
      await userEvent.click(screen.getByTestId("mytasks-clear-status"));
      expect(screen.queryByTestId("mytasks-active-filters")).toBeNull();
      expect(screen.getByTestId("tile-m1")).toBeInTheDocument();
    });

    it("Clear drops every filter at once", async () => {
      mount();
      await screen.findByTestId("mytasks-list");

      await userEvent.click(screen.getByTestId("mytasks-stat-done"));
      await userEvent.click(screen.getByTestId("mytasks-filters-open"));
      await userEvent.click(screen.getByRole("button", { name: /my role/i }));
      await userEvent.click(screen.getByRole("option", { name: /i am scoring/i }));
      await userEvent.click(screen.getByTestId("mytasks-sheet-apply"));
      expect(screen.getByTestId("mytasks-filter-count")).toHaveTextContent("2");

      await userEvent.click(screen.getByTestId("mytasks-reset"));
      expect(screen.queryByTestId("mytasks-active-filters")).toBeNull();
      expect(screen.getByTestId("tile-m1")).toBeInTheDocument();
      expect(screen.getByTestId("tile-m2")).toBeInTheDocument();
      expect(screen.getByTestId("tile-m3")).toBeInTheDocument();
    });
  });

  it("nothing assigned: a real empty state, with the noise stripped out", async () => {
    vi.mocked(tournamentsApi.matchesEnriched).mockResolvedValue([NOT_MINE]);
    mount();

    const empty = await screen.findByTestId("mytasks-empty");
    expect(empty).toHaveTextContent(/no matches assigned to you yet/i);
    // It says WHO assigns the work, not just that there is none.
    expect(empty).toHaveTextContent(/an organizer assigns/i);
    // And offers the one useful way onward.
    expect(
      screen.getByRole("link", { name: /browse the full schedule/i }),
    ).toBeInTheDocument();

    // No list, and none of the all-zero furniture above it.
    expect(screen.queryByTestId("mytasks-list")).toBeNull();
    expect(screen.queryByTestId("mytasks-stats")).toBeNull();
    expect(screen.queryByTestId("mytasks-search")).toBeNull();
    expect(screen.queryByTestId("mytasks-status-all")).toBeNull();
  });

  it("filters hiding everything is a DIFFERENT state, with a way back", async () => {
    mount();
    await screen.findByTestId("mytasks-list");

    await userEvent.type(screen.getByTestId("mytasks-search"), "nothing matches this");
    const none = screen.getByTestId("mytasks-no-results");
    expect(none).toHaveTextContent(/no matches fit these filters/i);
    // It states the real total so the scope is never in doubt.
    expect(none).toHaveTextContent(/you have 3 assigned matches/i);
    // Not the "nothing assigned" state — the controls stay put.
    expect(screen.queryByTestId("mytasks-empty")).toBeNull();
    expect(screen.getByTestId("mytasks-stats")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("mytasks-no-results-reset"));
    expect(screen.getByTestId("tile-m1")).toBeInTheDocument();
  });
});
