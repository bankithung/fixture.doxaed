import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type ControlRoomMatch,
  type ControlRoomPayload,
  type StagePayload,
} from "@/api/tournaments";
import { CrewPage } from "../CrewPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      controlRoom: vi.fn(),
      stage: vi.fn(),
      scheduleChanges: vi.fn(),
      members: vi.fn(),
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

const M1 = row({ id: "m1", scorer: { id: "u1", name: "Scott" } });
const M2 = row({
  id: "m2",
  scheduled_at: "2026-06-20T05:30:00Z",
  officials: [
    { id: "o1", user_id: "u9", name: "Ref Roy", role: "referee", status: "assigned" },
  ],
});

const ROOM: ControlRoomPayload = {
  tournament: { id: "t1", name: "Cup", slug: "cup", status: "scheduled", time_zone: "Asia/Kolkata" },
  days: [{ date: "2026-06-20", counts: { total: 2, completed: 0, live: 0 } }],
  day: "2026-06-20",
  venues: [{ venue: "Main", matches: [M1, M2] }],
  queue: [M1, M2],
};

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/crew"]}>
          <Routes>
            <Route path="/tournaments/:id/crew" element={<CrewPage />} />
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
  vi.mocked(tournamentsApi.members).mockResolvedValue([]);
});

afterEach(() => vi.unstubAllGlobals());

describe("CrewPage", () => {
  it("shows coverage, rows, and per-match assign", async () => {
    mount();
    // Both matches listed.
    expect(await screen.findByTestId("crew-row-m1")).toBeInTheDocument();
    expect(screen.getByTestId("crew-row-m2")).toBeInTheDocument();
    // Coverage: 1 of 2 scored, 1 of 2 officiated.
    expect(screen.getByText("Scorer coverage").parentElement).toHaveTextContent("1/2");
    expect(screen.getByText("Official coverage").parentElement).toHaveTextContent("1/2");
    // Manager gets the assign action.
    expect(screen.getByTestId("crew-assign-m1")).toBeInTheDocument();
  });

  it("filters to matches needing a scorer", async () => {
    mount();
    await screen.findByTestId("crew-row-m1");
    await userEvent.click(screen.getByTestId("crew-filter-needs_scorer"));
    // M1 has a scorer → hidden; M2 has none → shown.
    expect(screen.queryByTestId("crew-row-m1")).toBeNull();
    expect(screen.getByTestId("crew-row-m2")).toBeInTheDocument();
  });
});
