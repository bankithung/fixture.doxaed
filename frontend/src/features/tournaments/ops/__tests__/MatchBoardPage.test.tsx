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
import { MatchesBoardPage } from "../MatchBoardPage";

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
    leaf_key: "football.u15",
    venue: "Main",
    scoring: null,
    scheduled_at: "2026-06-20T03:30:00Z",
    locked_at: null,
    leaf_label: "Football U15",
    scorer: null,
    officials: [],
    ...over,
  };
}

// M1 Day 1, has a scorer. M2 Day 1, no crew. M3 Day 2, completed, U17.
const M1 = row({ id: "m1", match_no: 1, scorer: { id: "u1", name: "Scott" } });
const M2 = row({ id: "m2", match_no: 2, scheduled_at: "2026-06-20T05:30:00Z" });
const M3 = row({
  id: "m3",
  match_no: 3,
  scheduled_at: "2026-06-21T04:00:00Z",
  leaf_key: "football.u17",
  leaf_label: "Football U17",
  venue: "Court B",
  status: "completed",
  home_team: { id: "tg", name: "Gamma", short_name: "GAM" },
  away_team: { id: "td", name: "Delta", short_name: "DEL" },
  home_score: 2,
  away_score: 1,
});

const TOURNAMENT = {
  id: "t1",
  slug: "cup",
  name: "Cup",
  status: "scheduled",
  time_zone: "Asia/Kolkata",
} as Tournament;

const MANAGER: StagePayload = {
  stage: "ready",
  status: "scheduled",
  order: ["setup", "fixtures", "ready"],
  allowed_to: [],
  can_manage: true,
  modules: [],
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
        <MemoryRouter initialEntries={["/tournaments/t1/matches"]}>
          <Routes>
            <Route path="/tournaments/:id/matches" element={<MatchesBoardPage />} />
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
  useAuthStore.setState({ user: { id: "u-me" } as unknown as User });
  vi.mocked(tournamentsApi.matchesEnriched).mockResolvedValue([M1, M2, M3]);
  vi.mocked(tournamentsApi.stage).mockResolvedValue(MANAGER);
  vi.mocked(tournamentsApi.get).mockResolvedValue(TOURNAMENT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAuthStore.setState({ user: null });
});

describe("MatchesBoardPage", () => {
  it("lists every match with headline counts and manager actions", async () => {
    mount();
    expect(await screen.findByTestId("tile-m1")).toBeInTheDocument();
    expect(screen.getByTestId("tile-m2")).toBeInTheDocument();
    expect(screen.getByTestId("tile-m3")).toBeInTheDocument();

    // Counts over the whole fixture: 1 completed, 2 missing a scorer.
    expect(screen.getByText("Completed").parentElement).toHaveTextContent("1");
    expect(screen.getByText("No scorer").parentElement).toHaveTextContent("2");

    // Manager: the row's action menu offers assign + inline result on a
    // scheduled match; the completed match offers no result entry.
    await userEvent.click(screen.getByTestId("actions-m1"));
    expect(screen.getByTestId("assign-m1")).toBeInTheDocument();
    expect(screen.getByTestId("quick-result-m1")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("actions-m3"));
    expect(screen.queryByTestId("quick-result-m3")).toBeNull();
  });

  it("filters to matches needing a scorer", async () => {
    mount();
    await screen.findByTestId("tile-m1");
    await userEvent.click(screen.getByTestId("board-needs-scorer"));
    expect(screen.queryByTestId("tile-m1")).toBeNull(); // has a scorer
    expect(screen.getByTestId("tile-m2")).toBeInTheDocument();
    expect(screen.getByTestId("tile-m3")).toBeInTheDocument();
  });

  it("filters by status and by free-text search", async () => {
    mount();
    await screen.findByTestId("tile-m1");

    await userEvent.click(screen.getByTestId("board-status-done"));
    expect(screen.queryByTestId("tile-m1")).toBeNull();
    expect(screen.getByTestId("tile-m3")).toBeInTheDocument();

    // Reset status, then search narrows to the U17 competition.
    await userEvent.click(screen.getByTestId("board-status-all"));
    await userEvent.type(screen.getByTestId("board-search"), "u17");
    expect(screen.queryByTestId("tile-m1")).toBeNull();
    expect(screen.queryByTestId("tile-m2")).toBeNull();
    expect(screen.getByTestId("tile-m3")).toBeInTheDocument();
  });
});

describe("MatchesBoardPage pagination", () => {
  it("slices long fixtures into 20-row pages with prev and next", async () => {
    vi.mocked(tournamentsApi.matchesEnriched).mockResolvedValue(
      Array.from({ length: 45 }, (_, i) =>
        row({
          id: `pm${i}`,
          match_no: i + 1,
          scheduled_at: `2026-06-20T0${(i % 9) + 1}:30:00Z`,
        }),
      ),
    );
    mount();
    await screen.findByTestId("board-next");
    // Page 1: exactly 20 rows.
    expect(screen.getAllByTestId(/^tile-pm/)).toHaveLength(20);
    expect(screen.getByText("1 to 20 of 45")).toBeInTheDocument();
    expect(screen.getByTestId("board-prev")).toBeDisabled();

    await userEvent.click(screen.getByTestId("board-next"));
    expect(screen.getAllByTestId(/^tile-pm/)).toHaveLength(20);
    expect(screen.getByText("21 to 40 of 45")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("board-next"));
    expect(screen.getAllByTestId(/^tile-pm/)).toHaveLength(5);
    expect(screen.getByTestId("board-next")).toBeDisabled();

    // Changing a filter snaps back to page one.
    await userEvent.click(screen.getByTestId("board-status-upcoming"));
    expect(screen.getByText("1 to 20 of 45")).toBeInTheDocument();
  });
});
