import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
    },
  };
});

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
    },
    {
      id: "m2", leaf_key: "football.u15", leaf_label: "Football · U15",
      stage: "group", group_label: "Group A", round_no: 1, match_no: 2,
      status: "live", day: "2026-06-20",
      scheduled_at: "2026-06-20T05:30:00Z", venue: "Main Ground",
      home: { id: "tm3", name: "Carol FC", short_name: "C", school: "Carol" },
      away: { id: "tm4", name: "Delta FC", short_name: "D", school: "Delta" },
      home_score: 0, away_score: 0,
    },
    {
      id: "m3", leaf_key: "football.u17", leaf_label: "Football · U17",
      stage: "knockout", group_label: "", round_no: 1, match_no: 3,
      status: "scheduled", day: "2026-06-21",
      scheduled_at: "2026-06-21T04:00:00Z", venue: "Side Pitch",
      home: null, away: null, home_score: null, away_score: null,
    },
    {
      id: "m4", leaf_key: "football.u17", leaf_label: "Football · U17",
      stage: "knockout", group_label: "", round_no: 2, match_no: 4,
      status: "scheduled", day: null, scheduled_at: null, venue: "",
      home: null, away: null, home_score: null, away_score: null,
    },
  ],
};

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

  it("collects slotless matches under 'Awaiting a slot'", async () => {
    mount();
    const bucket = await screen.findByTestId("public-unscheduled");
    expect(within(bucket).getByTestId("public-match-m4")).toBeInTheDocument();
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
});
