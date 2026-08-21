import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tournamentsApi, type PublicSchedulePayload } from "@/api/tournaments";
import { PublicSchedulePage } from "../PublicSchedulePage";
import { PublicBracketRedirect } from "@/features/live/PublicBracketRedirect";

/** The knockout draw used to be its own page at /t/:slug/:id/bracket. It is a
 * SCOPE of the match centre now (owner 2026-08-21) — same bookmarked board,
 * same FifaBracket trees, no page load. These are the old page's tests, moved
 * onto the merged page, plus the redirect that keeps shared links alive. */

vi.mock("@/api/live", async () => {
  const actual = await vi.importActual<typeof import("@/api/live")>("@/api/live");
  return {
    ...actual,
    liveApi: {
      snapshot: vi.fn().mockResolvedValue(null),
      streamUrl: (s: string, i: string) =>
        `/api/public/tournaments/${s}/${i}/stream/`,
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
      publicRosters: vi.fn(),
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

function payload(
  matches: PublicSchedulePayload["matches"],
): PublicSchedulePayload {
  return {
    tournament: {
      id: "t1",
      slug: "cup",
      name: "Demo Cup",
      status: "live",
      time_zone: "Asia/Kolkata",
    },
    matches,
  };
}

const SEMI = {
  id: "sf1",
  leaf_key: "tt.u14",
  leaf_label: "Table Tennis · U14",
  stage: "knockout",
  group_label: "",
  round_no: 1,
  match_no: 1,
  status: "completed",
  day: "2026-06-25",
  scheduled_at: "2026-06-25T04:00:00Z",
  venue: "Court A",
  home: { id: "h", name: "Asen", short_name: "A", school: "North" },
  away: { id: "a", name: "Ben", short_name: "B", school: "South" },
  home_score: 3,
  away_score: 1,
  ...FIELDS,
};

const GROUP_MATCH = {
  id: "g1",
  leaf_key: "sepak.u14",
  leaf_label: "Sepak Takraw · U14",
  stage: "group",
  group_label: "Group A",
  round_no: 1,
  match_no: 1,
  status: "scheduled",
  day: "2026-06-25",
  scheduled_at: "2026-06-25T05:00:00Z",
  venue: "Court B",
  home: { id: "c", name: "Cara", short_name: "C", school: "East" },
  away: { id: "d", name: "Dan", short_name: "D", school: "West" },
  home_score: null as number | null,
  away_score: null as number | null,
  ...FIELDS,
};

function mount(entry = "/t/cup/t1/schedule?comp=knockout") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/t/:slug/:id/schedule" element={<PublicSchedulePage />} />
          <Route path="/t/:slug/:id/bracket" element={<PublicBracketRedirect />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.publicStandings).mockResolvedValue({ groups: [] });
  vi.mocked(tournamentsApi.publicRosters).mockResolvedValue({
    teams: [
      {
        id: "h",
        name: "Asen",
        school: "North",
        players: [
          { id: "p1", name: "Asen Jamir", jersey_no: null, captain: false },
        ],
      },
    ],
  });
});

describe("the knockout draw inside the match centre", () => {
  it("renders a knockout tree per competition and ignores group matches", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([SEMI, GROUP_MATCH]),
    );
    mount();
    // The bookmarked board opens on the first sport's first category.
    expect(await screen.findByTestId("bracket-board")).toBeInTheDocument();
    expect(screen.getByTestId("bracket-tt.u14")).toBeInTheDocument();
    expect(screen.getByTestId("bracket-sport-pick-Table Tennis")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Asen won the only match → appears in the final card AND the champion box.
    expect(screen.getAllByText("Asen").length).toBeGreaterThan(0);
    // The group-stage competition never becomes a bracket.
    expect(screen.queryByTestId("bracket-sepak.u14")).not.toBeInTheDocument();
  });

  it("carries a side's crest through the public schedule adapter", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([
        { ...SEMI, home: { ...SEMI.home, crest: "https://cdn.example/asen.png" } },
      ]),
    );
    mount();
    const board = await screen.findByTestId("bracket-tt.u14");
    // The public payload names the side; without the adapter passing `crest`
    // the public bracket would be the only bare one.
    expect(within(board).getByTestId("team-crest")).toHaveAttribute(
      "src",
      "https://cdn.example/asen.png",
    );
  });

  it("switches brackets from the category bookmarks (one bracket at a time)", async () => {
    const SECOND = {
      ...SEMI,
      id: "k2",
      leaf_key: "tt.u17",
      leaf_label: "Table Tennis · U17",
    };
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([SEMI, SECOND]),
    );
    mount();
    // Opens on the first category only; the other is a bookmark away.
    expect(await screen.findByTestId("bracket-tt.u14")).toBeInTheDocument();
    expect(screen.queryByTestId("bracket-tt.u17")).toBeNull();

    await userEvent.click(screen.getByTestId("bracket-comp-pick-tt.u17"));
    expect(await screen.findByTestId("bracket-tt.u17")).toBeInTheDocument();
    expect(screen.queryByTestId("bracket-tt.u14")).toBeNull();
  });

  it("is one click from the matches, and never offered when there is none", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([SEMI, GROUP_MATCH]),
    );
    mount("/t/cup/t1/schedule");
    // The rail pins it beside Today: no second page, no second fetch.
    await screen.findByTestId("rail-today");
    await userEvent.click(screen.getByTestId("rail-knockout"));
    expect(await screen.findByTestId("bracket-board")).toBeInTheDocument();
    expect(tournamentsApi.publicSchedule).toHaveBeenCalledTimes(1);
  });

  it("hides the knockout scope entirely when nothing has reached a bracket", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([GROUP_MATCH]),
    );
    mount("/t/cup/t1/schedule");
    await screen.findByTestId("rail-today");
    expect(screen.queryByTestId("rail-knockout")).toBeNull();
    // ...and asking for it by URL falls back to the day board rather than an
    // empty scope.
    expect(screen.queryByTestId("bracket-board")).toBeNull();
  });

  it("puts a competition's own bracket BELOW its page, never in a second tab", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([SEMI, GROUP_MATCH]),
    );
    mount("/t/cup/t1/schedule");
    await screen.findByTestId("rail-today");
    await userEvent.click(screen.getByTestId("rail-comp-tt.u14"));
    // A knockout-only competition has no group stage to sheet: the tree alone.
    expect(await screen.findByTestId("bracket-tt.u14")).toBeInTheDocument();
    expect(screen.queryByTestId("public-competition-tt.u14")).toBeNull();
    // ...and there is no view to switch to; the page is the whole competition.
    expect(screen.queryByTestId("view-bracket")).toBeNull();

    // A group-stage competition sheets its groups and grows no bracket.
    await userEvent.click(screen.getByTestId("rail-comp-sepak.u14"));
    expect(
      await screen.findByTestId("public-competition-sepak.u14"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("bracket-sepak.u14")).toBeNull();
  });

  it("opens a bracket card IN PLACE, without reloading the page", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([SEMI, GROUP_MATCH]),
    );
    mount("/t/cup/t1/schedule?comp=tt.u14");
    const card = await screen.findByTestId("bracket-card-sf1");
    // A bare <a href> would reload the whole app; jsdom does not navigate for
    // one at all, so the drawer would never appear. A router link does.
    expect(card.getAttribute("href")).toContain("match=sf1");
    // A bare <a href> reloads the whole app; the href would also still be the
    // raw relative "?comp=..." rather than a path the router resolved.
    expect(card.getAttribute("href")).toBe(
      "/t/cup/t1/schedule?comp=tt.u14&match=sf1",
    );
    await userEvent.click(card);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // ...and the bracket behind it is still mounted, never re-fetched.
    expect(screen.getByTestId("bracket-tt.u14")).toBeInTheDocument();
    expect(tournamentsApi.publicSchedule).toHaveBeenCalledTimes(1);
  });

  it("prints the SELECTED draw as the tree, and nothing else", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([SEMI, { ...SEMI, id: "k2", leaf_key: "tt.u17", leaf_label: "Table Tennis · U17" }]),
    );
    mount("/t/cup/t1/schedule?comp=knockout&kosport=Table%20Tennis&kocomp=tt.u17");
    await screen.findByTestId("bracket-tt.u17");

    const doc = screen.getByTestId("fixture-print-doc");
    // The tree, and ONLY the tree: a knockout is read as a flow chart, so the
    // order-of-play table that used to print beside it is gone (owner
    // 2026-08-21).
    expect(
      within(doc).getByTestId("print-page-knockout-teams"),
    ).toBeInTheDocument();
    expect(
      within(doc).queryByTestId("print-page-knockout-sheet-teams"),
    ).toBeNull();
    // The tree that prints is the one on screen, not another competition's.
    expect(
      within(doc).getByTestId("print-teams-bracket-card-k2"),
    ).toBeInTheDocument();
    expect(
      within(doc).queryByTestId("print-teams-bracket-card-sf1"),
    ).toBeNull();
    // And again with the names.
    expect(
      within(doc).getByTestId("print-page-knockout-detailed"),
    ).toBeInTheDocument();
  });

  it("names the players on the board itself, behind one switch", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(payload([SEMI]));
    mount();
    await screen.findByTestId("bracket-tt.u14");
    const board = screen.getByTestId("bracket-board");
    // A draw names TEAMS until you ask otherwise, and the roster read is not
    // made at all until then.
    expect(board).not.toHaveTextContent("Asen Jamir");
    expect(tournamentsApi.publicRosters).not.toHaveBeenCalled();

    const toggle = screen.getByTestId("bracket-names-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);

    // Scoped to the board: the print document holds a second, hidden copy.
    await waitFor(() =>
      expect(screen.getByTestId("bracket-board")).toHaveTextContent(
        "Asen Jamir",
      ),
    );
    expect(tournamentsApi.publicRosters).toHaveBeenCalledWith("cup", "t1");
    // It rides the URL, so a board showing who is playing is a shareable link.
    expect(screen.getByTestId("bracket-names-toggle")).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps old /bracket links alive, selection and all", async () => {
    vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(
      payload([SEMI, { ...SEMI, id: "k2", leaf_key: "tt.u17", leaf_label: "Table Tennis · U17" }]),
    );
    mount("/t/cup/t1/bracket?sport=Table%20Tennis&comp=tt.u17");
    expect(await screen.findByTestId("bracket-tt.u17")).toBeInTheDocument();
    expect(screen.queryByTestId("bracket-tt.u14")).toBeNull();
  });
});
