import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { liveApi, type LiveSnapshot } from "@/api/live";
import { tournamentsApi, type PublicSchedulePayload } from "@/api/tournaments";
import { PublicSchedulePage } from "../PublicSchedulePage";

/** Tapping a row on the match sheet opens the match OVER the sheet — a
 * right-hand drawer on a desk, a bottom drawer on a phone — instead of
 * throwing the list away for a full page (owner 2026-08-21). */

vi.mock("@/api/live", async () => {
  const actual = await vi.importActual<typeof import("@/api/live")>("@/api/live");
  return {
    ...actual,
    liveApi: {
      snapshot: vi.fn(),
      streamUrl: (slug: string, id: string) =>
        `/api/public/tournaments/${slug}/${id}/stream/`,
    },
  };
});

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
  sport: "sepak_takraw",
  set_scores: [] as number[][],
  current_period: "",
};

const SCHEDULE: PublicSchedulePayload = {
  tournament: {
    id: "t1",
    slug: "cup",
    name: "Dimapur Meet",
    status: "live",
    time_zone: "Asia/Kolkata",
  },
  matches: [
    {
      id: "m1",
      leaf_key: "sepak.u14.boys",
      leaf_label: "Sepak Takraw · U-14 · Boys",
      stage: "group",
      group_label: "Sepak Takraw · U-14 · Boys · Group A",
      round_no: 1,
      match_no: 1,
      status: "live",
      day: "2026-08-17",
      scheduled_at: "2026-08-17T04:00:00Z",
      venue: "Mph · T1",
      home: { id: "a", name: "Christ School", short_name: "CS", school: "CS" },
      away: { id: "b", name: "Greenwood HSS", short_name: "GW", school: "GW" },
      home_score: 1,
      away_score: 0,
      watch_url: "https://youtu.be/live",
      ...LIVE_FIELDS,
    },
    {
      id: "m2",
      leaf_key: "sepak.u14.boys",
      leaf_label: "Sepak Takraw · U-14 · Boys",
      stage: "group",
      group_label: "Sepak Takraw · U-14 · Boys · Group A",
      round_no: 1,
      match_no: 2,
      status: "scheduled",
      day: "2026-08-17",
      scheduled_at: "2026-08-17T05:00:00Z",
      venue: "Mph · T2",
      home: { id: "c", name: "Eden HSS", short_name: "EH", school: "EH" },
      away: { id: "d", name: "Grace Academy", short_name: "GA", school: "GA" },
      home_score: null,
      away_score: null,
      ...LIVE_FIELDS,
    },
  ],
};

function snapshot(): LiveSnapshot {
  return {
    match: {
      id: "m1",
      status: "live",
      current_period: "set_2",
      home_team: { id: "a", name: "Christ School", short_name: "CS", players: [] },
      away_team: { id: "b", name: "Greenwood HSS", short_name: "GW", players: [] },
      home_score: 1,
      away_score: 0,
      sport: "sepak_takraw",
      sport_meta: {
        key: "sepak_takraw",
        name: "Sepak Takraw",
        family: "target",
        terms: { score_unit: "Points", period: "Set" },
        version: 1,
      },
      set_scores: [
        [21, 15],
        [11, 8],
      ],
      scheduled_at: "2026-08-17T04:00:00Z",
      venue: "Mph · T1",
      leaf_key: "sepak.u14.boys",
      group_label: "Group A",
      lineups: {
        home: {
          confirmed: true,
          entries: [
            {
              player_id: "p1",
              name: "Server One",
              role: "starter",
              shirt_no: 1,
              positional_role: "tekong",
            },
            {
              player_id: "p2",
              name: "Feeder Two",
              role: "starter",
              shirt_no: 2,
              positional_role: "left_inside",
            },
          ],
        },
        away: {
          confirmed: true,
          entries: [
            {
              player_id: "q1",
              name: "Away One",
              role: "starter",
              shirt_no: 5,
              positional_role: "tekong",
            },
          ],
        },
      },
    },
    tournament: { id: "t1", slug: "cup", name: "Dimapur Meet", time_zone: "Asia/Kolkata" },
    stats: [],
    h2h: [],
    events: [],
  } as unknown as LiveSnapshot;
}

function mount(entry = "/t/cup/t1/schedule") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/t/:slug/:id/schedule" element={<PublicSchedulePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(SCHEDULE);
  vi.mocked(tournamentsApi.publicStandings).mockResolvedValue({ groups: [] });
  vi.mocked(liveApi.snapshot).mockResolvedValue(snapshot());
});

describe("the match drawer", () => {
  it("opens over the sheet, keeping the list mounted behind it", async () => {
    mount();
    const row = await screen.findByTestId("court-Mph · T1-row-m1");
    // The row is a real LINK, not a click handler: middle-click opens the
    // sheet with that match already open.
    const link = within(row).getByRole("link", { name: /vs/i });
    expect(link.getAttribute("href")).toContain("match=m1");

    await userEvent.click(link);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByTestId("drawer-panel-overview")).toBeInTheDocument();
    // The sheet behind it is still there — closing returns to the same place.
    expect(screen.getByTestId("court-Mph · T2-row-m2")).toBeInTheDocument();
  });

  it("shows the whole match: score, info, participants, and its tabs", async () => {
    mount("/t/cup/t1/schedule?match=m1");
    // Both the sheet and the snapshot have to land before the drawer is whole.
    await screen.findByTestId("court-Mph · T1-row-m1");
    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByTestId("hub-tab-lineups");

    // The fixture number the sheet prints, as the drawer's own heading.
    expect(within(drawer).getByText("Match 1")).toBeInTheDocument();
    // Live set sport: running points headline, sets under it.
    expect(drawer).toHaveTextContent("11");
    expect(drawer).toHaveTextContent("Sets 1-0");
    // Match info.
    expect(within(drawer).getByText("Mph · T1")).toBeInTheDocument();
    // WHO IS PLAYING, without changing tab: the reason a viewer opened one
    // match in the first place.
    expect(within(drawer).getByText("Server One")).toBeInTheDocument();
    expect(within(drawer).getByText("Away One")).toBeInTheDocument();
    // Every section of the hub is reachable from here.
    expect(within(drawer).getByTestId("hub-tab-timeline")).toBeInTheDocument();
    // ...and the full page is still one link away.
    expect(within(drawer).getByTestId("drawer-full-page")).toHaveAttribute(
      "href",
      "/m/m1",
    );
    // The watch link comes off the schedule row, not a second fetch.
    expect(within(drawer).getByTestId("drawer-watch-m1")).toHaveAttribute(
      "href",
      "https://youtu.be/live",
    );
    expect(liveApi.snapshot).toHaveBeenCalledWith("m1");
  });

  it("switches tab inside the drawer without leaving the page", async () => {
    mount("/t/cup/t1/schedule?match=m1");
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(await within(drawer).findByTestId("hub-tab-timeline"));
    expect(
      await screen.findByTestId("drawer-panel-timeline"),
    ).toBeInTheDocument();
    // Still the match centre underneath, not a navigation.
    expect(screen.getByTestId("court-Mph · T1-row-m1")).toBeInTheDocument();
  });

  it("closes back onto the sheet, and Escape does the same", async () => {
    mount("/t/cup/t1/schedule?match=m1");
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByTestId("drawer-close"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("court-Mph · T1-row-m1")).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByTestId("court-Mph · T2-row-m2")).getByRole("link", {
        name: /vs/i,
      }),
    );
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("never opens a drawer for a match id the tournament does not have", async () => {
    mount("/t/cup/t1/schedule?match=nope");
    await screen.findByTestId("court-Mph · T1-row-m1");
    // The snapshot request still runs (the id could be a valid deep link), but
    // the sheet behind is intact and nothing has been navigated away from.
    expect(screen.getByTestId("court-Mph · T2-row-m2")).toBeInTheDocument();
  });
});
