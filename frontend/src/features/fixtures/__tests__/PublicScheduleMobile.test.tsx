import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tournamentsApi, type PublicSchedulePayload } from "@/api/tournaments";
import { PublicSchedulePage } from "../PublicSchedulePage";

/** The phone shell. A twenty-category horizontal pill scroller is not a map,
 * so on a phone the scope becomes ONE button that opens the same list the
 * desktop rail shows, in the house bottom drawer. */

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

const FIELDS = {
  home_pens: null as number | null,
  away_pens: null as number | null,
  sport: "",
  set_scores: [] as number[][],
  current_period: "",
};

function match(
  id: string,
  leaf: string,
  label: string,
  venue: string,
): PublicSchedulePayload["matches"][number] {
  return {
    id,
    leaf_key: leaf,
    leaf_label: label,
    stage: "group",
    group_label: `${label} · Group A`,
    round_no: 1,
    match_no: 1,
    status: "scheduled",
    day: "2026-08-17",
    scheduled_at: "2026-08-17T04:00:00Z",
    venue,
    home: { id: `${id}h`, name: "Holy Cross Higher Secondary School", short_name: "HC", school: "HC" },
    away: { id: `${id}a`, name: "Lampstand Higher Secondary School", short_name: "LM", school: "LM" },
    home_score: null,
    away_score: null,
    ...FIELDS,
  };
}

const PAYLOAD: PublicSchedulePayload = {
  tournament: {
    id: "t1",
    slug: "cup",
    name: "Dimapur District Meet",
    status: "live",
    time_zone: "Asia/Kolkata",
  },
  matches: [
    match("m1", "tt.u14.boys", "Table Tennis · U-14 · Boys", "Audi · T1"),
    match("m2", "sepak.u14.girls", "Sepak Takraw · U-14 · Girls", "Mph · T1"),
  ],
  courts: [
    { id: "c1", name: "Audi · T1", watch_url: null, is_streaming: false },
    { id: "c2", name: "Mph · T1", watch_url: null, is_streaming: false },
  ],
};

const REAL_WIDTH = window.innerWidth;

function setWidth(px: number): void {
  act(() => {
    Object.defineProperty(window, "innerWidth", {
      value: px,
      configurable: true,
      writable: true,
    });
    window.dispatchEvent(new Event("resize"));
  });
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/t/cup/t1/schedule"]}>
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
  vi.mocked(tournamentsApi.publicStandings).mockResolvedValue({ groups: [] });
  setWidth(390);
});

afterEach(() => setWidth(REAL_WIDTH));

describe("PublicSchedulePage on a phone", () => {
  it("replaces the rail with one scope button that opens the whole map", async () => {
    mount();
    await screen.findByTestId("public-day-2026-08-17");

    // No rail, and no list of every competition burning screen height.
    expect(screen.getByTestId("scope-picker")).toHaveTextContent("Today");
    expect(screen.queryByTestId("rail-comp-tt.u14.boys")).toBeNull();

    await userEvent.click(screen.getByTestId("scope-picker"));
    const sheet = await screen.findByRole("dialog");
    // The SAME list the desktop rail renders, so the two can never drift.
    expect(within(sheet).getByTestId("rail-today")).toBeInTheDocument();
    expect(
      within(sheet).getByTestId("rail-comp-sepak.u14.girls"),
    ).toBeInTheDocument();

    await userEvent.click(within(sheet).getByTestId("rail-comp-tt.u14.boys"));
    // Picking closes the drawer and the panel is that competition's: its own
    // fixtures, no court lanes, and the other sport's match gone.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("scope-picker")).toHaveTextContent("Table Tennis");
    const fixtures = await screen.findByTestId("public-day-2026-08-17");
    expect(within(fixtures).getByTestId("public-match-m1")).toBeInTheDocument();
    expect(within(fixtures).queryByTestId("public-match-m2")).toBeNull();
    expect(screen.queryByTestId("court-lane-Audi · T1")).toBeNull();
  });

  it("keeps the search behind a toggle so the control bar stays one row", async () => {
    mount();
    await screen.findByTestId("public-day-2026-08-17");
    // Two courts, so the day still opens on the lanes on a phone.
    expect(screen.getByTestId("view-courts")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getAllByTestId("filter-team")).toHaveLength(1); // sm-only copy is hidden, not absent

    await userEvent.click(
      screen.getAllByRole("button", { name: "Search teams" })[0]!,
    );
    const boxes = screen.getAllByTestId("filter-team");
    expect(boxes.length).toBe(2);
    await userEvent.type(boxes[1]!, "Holy");
    expect(screen.getByTestId("filter-count")).toHaveTextContent("2 of 2");
  });
});
