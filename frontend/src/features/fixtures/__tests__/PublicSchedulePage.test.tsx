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
      publicRosters: vi.fn(),
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

/** Signed capability URLs: they load with no session, which is why a crest
 * can appear on a page nobody has logged into. */
const ALPHA_CREST = "/api/public/teams/tm1/crest.png?sig=alpha";
const CAROL_CREST = "/api/public/teams/tm3/crest.png?sig=carol";

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
      id: "m1", leaf_key: "football.u15", leaf_label: "Football · U-15 · Boys",
      stage: "group", group_label: "Football · U-15 · Boys · Group A", round_no: 1, match_no: 1,
      status: "completed", day: "2026-06-20",
      scheduled_at: "2026-06-20T03:30:00Z", venue: "Main Ground",
      home: { id: "tm1", name: "Alpha FC", short_name: "A", school: "Alpha", crest: ALPHA_CREST },
      // Bravo never uploaded one: the row must still carry a badge.
      away: { id: "tm2", name: "Bravo FC", short_name: "B", school: "Bravo" },
      home_score: 2, away_score: 1,
      ...LIVE_FIELDS, home_pens: 4, away_pens: 3,
    },
    {
      id: "m2", leaf_key: "football.u15", leaf_label: "Football · U-15 · Boys",
      stage: "group", group_label: "Football · U-15 · Boys · Group A", round_no: 1, match_no: 2,
      status: "live", day: "2026-06-20",
      scheduled_at: "2026-06-20T05:30:00Z", venue: "Main Ground",
      home: { id: "tm3", name: "Carol FC", short_name: "C", school: "Carol", crest: CAROL_CREST },
      away: { id: "tm4", name: "Delta FC", short_name: "D", school: "Delta" },
      home_score: 0, away_score: 0,
      ...LIVE_FIELDS, current_period: "first_half",
    },
    {
      id: "m3", leaf_key: "football.u17", leaf_label: "Football · U-17 · Boys",
      stage: "knockout", group_label: "", round_no: 1, match_no: 3,
      status: "scheduled", day: "2026-06-21",
      scheduled_at: "2026-06-21T04:00:00Z", venue: "Side Pitch",
      home: null, away: null, home_score: null, away_score: null,
      // typed pointers (invariant 9): the semi waits on two group finishers
      home_source: { type: "group_position", group_label: "Football · U-17 · Boys · Group A", position: 1 },
      away_source: { type: "group_position", group_label: "Football · U-17 · Boys · Group A", position: 2 },
      ...LIVE_FIELDS,
    },
    {
      id: "m6", leaf_key: "football.u17", leaf_label: "Football · U-17 · Boys",
      stage: "knockout", group_label: "", round_no: 2, match_no: 6,
      status: "scheduled", day: "2026-06-21",
      scheduled_at: "2026-06-21T06:00:00Z", venue: "Side Pitch",
      home: null, away: null, home_score: null, away_score: null,
      // the final waits on the winner of m3, which the sheet numbers M1
      home_source: { type: "winner_of", match_id: "m3" },
      away_source: { type: "tbd" },
      ...LIVE_FIELDS,
    },
    {
      id: "m4", leaf_key: "football.u17", leaf_label: "Football · U-17 · Boys",
      stage: "knockout", group_label: "", round_no: 2, match_no: 4,
      status: "scheduled", day: null, scheduled_at: null, venue: "",
      home: null, away: null, home_score: null, away_score: null,
      ...LIVE_FIELDS,
    },
    {
      id: "m5", leaf_key: "tt.open", leaf_label: "Table Tennis · Open · Boys",
      stage: "group", group_label: "Table Tennis · Open · Boys · Group T", round_no: 1, match_no: 5,
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
      group_label: "Football · U-15 · Boys · Group A",
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

/** The second read the PRINT needs and the screen never does: who each team
 * actually fields. */
const ROSTERS = {
  teams: [
    {
      id: "tm1",
      name: "Alpha FC",
      school: "Alpha",
      players: [
        { id: "p1", name: "Asen Jamir", jersey_no: 7, captain: true },
        { id: "p2", name: "Bendang Ao", jersey_no: 3, captain: false },
      ],
    },
    {
      id: "tm2",
      name: "Bravo FC",
      school: "Bravo",
      players: [
        { id: "p3", name: "Chubala Imchen", jersey_no: null, captain: false },
      ],
    },
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

/** Print is a MENU, not a button: open it, then pick which passes to print. */
async function clickPrint(
  pass: "teams" | "detailed" | "both" = "both",
): Promise<void> {
  await userEvent.click(screen.getByTestId("print-menu"));
  await userEvent.click(screen.getByTestId(`print-${pass}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.publicSchedule).mockResolvedValue(PAYLOAD);
  vi.mocked(tournamentsApi.publicStandings).mockResolvedValue(STANDINGS);
  vi.mocked(tournamentsApi.publicRosters).mockResolvedValue(ROSTERS);
});

describe("PublicSchedulePage", () => {
  it("defaults to ONE SHEET PER COURT, with a column for every fact, ZERO dashes", async () => {
    const { container } = mount();
    // smart default day = nearest >= today, else first day → 2026-06-20
    const day = await screen.findByTestId("public-day-2026-06-20");
    expect(tournamentsApi.publicSchedule).toHaveBeenCalledWith("nagaland-cup", "t1");
    expect(screen.getByTestId("view-courts")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // A day is five tables each with its own queue, so that is how it reads:
    // the ground's two games together, the table-tennis game on its own table.
    const ground = within(day).getByTestId("court-lane-Main Ground");
    expect(within(ground).getByTestId("court-Main Ground-row-m1")).toBeInTheDocument();
    expect(within(ground).getByTestId("court-Main Ground-row-m2")).toBeInTheDocument();
    expect(within(ground).queryByTestId("court-Main Ground-row-m5")).toBeNull();
    expect(
      within(within(day).getByTestId("court-lane-Table Hall")).getByTestId(
        "court-Table Hall-row-m5",
      ),
    ).toBeInTheDocument();
    // the lane says how far through its own queue it is
    expect(ground).toHaveTextContent("1/2 played");

    // It is a real sheet: named columns, one row per match, everything aligned.
    const sheet = within(ground).getByTestId("court-Main Ground-table");
    for (const h of ["No", "Time", "Home", "Away", "Score", "Winner", "Status"]) {
      expect(within(sheet).getByRole("columnheader", { name: h })).toBeInTheDocument();
    }

    const m1 = within(ground).getByTestId("court-Main Ground-row-m1");
    // The number the DRAW gave it, counted within its own competition, so a
    // bracket pointer elsewhere can be looked up by eye.
    expect(within(m1).getByTestId("court-Main Ground-no-m1")).toHaveTextContent("M1");
    expect(
      within(ground).getByTestId("court-Main Ground-no-m2"),
    ).toHaveTextContent("M2");
    expect(m1).toHaveTextContent("09:00"); // 03:30Z in Asia/Kolkata (invariant 14)
    // the row still names its game via chips (never the dashed blob)
    expect(within(m1).getByText("Football")).toBeInTheDocument();
    expect(within(m1).getByText("U15")).toBeInTheDocument(); // "U-15" hyphen stripped
    expect(within(m1).getByTestId("sheet-score-m1")).toHaveTextContent("2-1");
    expect(within(m1).getByTestId("sheet-detail-m1")).toHaveTextContent("(4-3 pens)");
    // A winner column, not a bolded name to infer one from.
    expect(
      within(m1).getByTestId("court-Main Ground-winner-m1"),
    ).toHaveTextContent("Alpha FC");
    expect(m1).toHaveTextContent("Full time");
    // Nothing has been played on the live row, so its winner cell says so.
    expect(
      within(ground).queryByTestId("court-Main Ground-winner-m2"),
    ).toBeNull();

    // the en/em dash is the #1 tell: it must appear NOWHERE on the page
    expect(screen.queryByText(/Football · U-15 · Boys/)).toBeNull();
    expect(container.textContent).not.toMatch(/[—–]/);

    // standalone page: viewer tabs, no app shell; a competition panel is NOT
    // open by default (you pick one from the rail)
    expect(screen.queryByTestId("app-sidebar")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Tournament views" })).toBeInTheDocument();
    expect(screen.queryByTestId("public-competition-football.u15")).toBeNull();
  });

  it("says what an empty slot is WAITING ON, never a bare TBD", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await userEvent.click(screen.getByTestId("day-pick-2026-06-21"));
    await userEvent.click(screen.getByTestId("view-courts"));
    const pitch = await screen.findByTestId("court-lane-Side Pitch");

    // The semi waits on two group finishers...
    const semi = within(pitch).getByTestId("court-Side Pitch-row-m3");
    expect(semi).toHaveTextContent("Group A top 1");
    expect(semi).toHaveTextContent("Group A top 2");
    // ...and the final waits on the winner of that semi, named by the SAME
    // number the semi's own row prints.
    expect(within(semi).getByTestId("court-Side Pitch-no-m3")).toHaveTextContent("M1");
    const final = within(pitch).getByTestId("court-Side Pitch-row-m6");
    expect(final).toHaveTextContent("Winner of M1");
    // A pointer with nothing to name is the only thing left saying so.
    expect(final).toHaveTextContent("To be decided");
  });

  it("flags the next match on a court, and drops the lanes on a one-court day", async () => {
    mount();
    const day = await screen.findByTestId("public-day-2026-06-20");
    // m1 is played and m2 is live, so neither is "next"; the ground has no
    // waiting match at all and flags nothing.
    expect(within(day).queryByTestId("flag-m1")).toBeNull();
    expect(within(day).queryByTestId("flag-m2")).toBeNull();

    // Day two runs on ONE pitch: a lane per court is just the day list with an
    // extra heading, so the board opens on the clock reading instead.
    await userEvent.click(screen.getByTestId("day-pick-2026-06-21"));
    await screen.findByTestId("public-day-2026-06-21");
    expect(screen.getByTestId("view-time")).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Ask for the lanes anyway and the pitch names its next match.
    await userEvent.click(screen.getByTestId("view-courts"));
    const next = await screen.findByTestId("court-lane-Side Pitch");
    expect(within(next).getByTestId("flag-m3")).toHaveTextContent("Next up");
  });

  it("switches the day to ONE sheet in clock order, court in its own column", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await userEvent.click(screen.getByTestId("view-time"));

    const day = await screen.findByTestId("public-day-2026-06-20");
    const sheet = within(day).getByTestId("byTime-table");
    // Same columns as a court's sheet plus the court itself, so a row never
    // changes meaning between views.
    expect(
      within(sheet).getByRole("columnheader", { name: "Court" }),
    ).toBeInTheDocument();
    const rows = within(sheet).getAllByTestId(/^byTime-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "byTime-row-m1",
      "byTime-row-m2",
      "byTime-row-m5",
    ]);
    expect(rows[0]!).toHaveTextContent("Main Ground");
    expect(rows[2]!).toHaveTextContent("Table Hall");
    // the clock reading has no lanes
    expect(within(day).queryByTestId("court-lane-Main Ground")).toBeNull();
  });

  it("pins live matches in the Now-playing band and pulses only live rows", async () => {
    mount();
    const band = await screen.findByTestId("live-band");
    expect(within(band).getByTestId("live-tile-m2")).toBeInTheDocument();
    expect(within(band).getByTestId("live-tile-m5")).toBeInTheDocument();
    // inline live row still carries the pulse + period for context
    const m2 = screen.getByTestId("court-Main Ground-row-m2");
    expect(within(m2).getByTestId("live-pulse")).toBeInTheDocument();
    expect(m2).toHaveTextContent("Live");
    expect(screen.getByTestId("court-Main Ground-row-m1")).toHaveTextContent(
      "Full time",
    );
  });

  it("gives Today the live band and a competition its own one-match spotlight", async () => {
    // Today is a LIST, because several courts really are playing at once. A
    // competition is ONE match (owner 2026-08-26), because that is what a
    // spectator at that court is watching — and unlike the band it is never
    // absent, so a category with nothing live still opens on an answer rather
    // than on a wall of finished tables.
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    expect(within(screen.getByTestId("live-band")).getByTestId("live-tile-m5"))
      .toBeInTheDocument();
    expect(screen.queryByTestId("competition-spotlight")).toBeNull();

    // Football U-15 is live (m2); Table Tennis' live game (m5) belongs to a
    // competition the viewer did not open and must not appear.
    await userEvent.click(screen.getByTestId("rail-comp-football.u15"));
    const spot = await screen.findByTestId("competition-spotlight");
    expect(spot).toHaveAttribute("data-kind", "live");
    expect(spot).toHaveTextContent("Carol FC");
    expect(spot).not.toHaveTextContent("Echo TT");
    expect(screen.queryByTestId("live-band")).toBeNull();

    // Football U-17 has nothing live, and still leads with its next match
    // rather than with nothing.
    await userEvent.click(screen.getByTestId("rail-comp-football.u17"));
    await waitFor(() =>
      expect(screen.getByTestId("competition-spotlight")).toHaveAttribute(
        "data-kind",
        "next",
      ),
    );

    // Back to Today and the band returns.
    await userEvent.click(screen.getByTestId("rail-today"));
    const back = await screen.findByTestId("live-band");
    expect(within(back).getByTestId("live-tile-m5")).toBeInTheDocument();
  });

  it("shows live points: period chip, set scores, shootout result (ASCII)", async () => {
    mount();
    const m2 = await screen.findByTestId("court-Main Ground-row-m2");
    expect(within(m2).getByTestId("period-m2")).toHaveTextContent("first half");
    // Live set sport (tap scoring): the HEADLINE is the running set's points
    // and the sub-line says how the SETS stand; the chip derives "Set N" from
    // the set list (football current_period never labels a set sport).
    const m5 = screen.getByTestId("court-Table Hall-row-m5");
    expect(within(m5).getByTestId("sheet-score-m5")).toHaveTextContent("8-11");
    expect(within(m5).getByTestId("sheet-detail-m5")).toHaveTextContent("Sets 1-1");
    // The set-by-set breakdown is NOT in the row: it turned every played match
    // into three lines and made the day unscannable (owner 2026-08-25). It is
    // in the match, one tap away.
    expect(within(m5).getByTestId("sheet-detail-m5")).not.toHaveTextContent("11-7");
    expect(within(m5).getByTestId("period-m5")).toHaveTextContent("Set 2");
  });

  it("a competition is ONE page: its group stage as a sheet, nothing else", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await userEvent.click(screen.getByTestId("rail-comp-football.u15"));

    // The fixtures are a SHEET with columns, under their group heading.
    const panel = await screen.findByTestId("public-competition-football.u15");
    expect(panel).toHaveTextContent("Group stage");
    expect(
      within(panel).getByTestId("comp-football.u15-row-m1"),
    ).toBeInTheDocument();
    expect(
      within(panel).getByTestId("comp-football.u15-row-m2"),
    ).toBeInTheDocument();

    // Standings have their own tab, so the page does not repeat them
    // (owner 2026-08-21), and there is nothing to switch views between.
    expect(screen.queryByTestId("public-tables-football.u15")).toBeNull();
    expect(screen.queryByTestId("group-standing-tm1")).toBeNull();
    expect(screen.queryByTestId("view-day")).toBeNull();
    expect(screen.queryByTestId("panel-standings")).toBeNull();
  });

  it("a knockout-only competition is the BRACKET alone, no fixture table", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await userEvent.click(screen.getByTestId("rail-comp-football.u17"));

    // Every U-17 match is a knockout tie, so there is no group stage to sheet
    // and no table to stand above it: the tree says it all.
    expect(await screen.findByTestId("bracket-football.u17")).toBeInTheDocument();
    expect(screen.queryByTestId("public-competition-football.u17")).toBeNull();
    expect(screen.queryByTestId("public-tables-football.u17")).toBeNull();
    expect(screen.queryByTestId("view-bracket")).toBeNull();
  });

  it("has no Up next band anywhere: the sheet flags its own next match", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    // The day board answers "what is next" per COURT, inside the sheet.
    expect(screen.queryByTestId("upnext-band")).toBeNull();

    // A competition does the same, once, in the Status column of whichever
    // group holds its next match. U-15's two group games are played and live,
    // so nothing there is waiting and nothing is flagged.
    await userEvent.click(screen.getByTestId("rail-comp-football.u15"));
    const panel = await screen.findByTestId("public-competition-football.u15");
    expect(screen.queryByTestId("upnext-band")).toBeNull();
    expect(within(panel).queryByTestId("flag-m1")).toBeNull();
    expect(within(panel).queryByTestId("flag-m2")).toBeNull();

    // A knockout-only competition has no sheet at all, so no band either.
    await userEvent.click(screen.getByTestId("rail-comp-football.u17"));
    await screen.findByTestId("bracket-football.u17");
    expect(screen.queryByTestId("upnext-band")).toBeNull();
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
    expect(screen.getByTestId("court-Table Hall-row-m5")).toBeInTheDocument();
    expect(screen.queryByTestId("court-Main Ground-row-m1")).toBeNull();

    await userEvent.click(screen.getByTestId("filter-clear"));
    await waitFor(() =>
      expect(screen.getByTestId("court-Main Ground-row-m1")).toBeInTheDocument(),
    );
  });

  it("prints the day the reader is on, ONE page per court, in landscape", async () => {
    const print = vi.fn();
    window.print = print;
    mount();
    await screen.findByTestId("public-day-2026-06-20");

    // The paper is the same board: a page per court, exactly the lanes the
    // screen shows, and not the day rolled into one list.
    const doc = screen.getByTestId("fixture-print-doc");
    expect(
      within(doc).getByTestId("print-page-court-Main Ground-teams"),
    ).toBeInTheDocument();
    expect(
      within(doc).getByTestId("print-page-court-Table Hall-teams"),
    ).toBeInTheDocument();
    // ...and then the SAME fixture again, with the names.
    expect(
      within(doc).getByTestId("print-page-court-Main Ground-detailed"),
    ).toBeInTheDocument();

    await clickPrint();
    await waitFor(() => expect(print).toHaveBeenCalled());
    // A fixture sheet is wide; portrait would crop it. The rule is injected
    // for this print only, never left in the stylesheet.
    expect(
      document.getElementById("fixture-print-page")?.textContent,
    ).toContain("landscape");
    // The SAVED FILE is named for what was exported, scope first: every
    // browser takes the PDF's file name from the document title, and the
    // page's own title is the tournament, so four exports used to save four
    // identically-named files (owner 2026-08-21).
    expect(document.title).toBe(
      "Sat, Jun 20 - Order of play - Nagaland Schools Cup",
    );
  });

  it("names the file after the competition when one is open", async () => {
    const print = vi.fn();
    window.print = print;
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await userEvent.click(screen.getByTestId("rail-comp-football.u17"));
    await clickPrint();
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(document.title).toBe(
      "Football U-17 Boys - Nagaland Schools Cup",
    );
  });

  it("the second pass names the players; the first stays by team", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await clickPrint();

    const doc = screen.getByTestId("fixture-print-doc");
    const teams = within(doc).getByTestId("print-page-court-Main Ground-teams");
    const detailed = await within(doc).findByTestId(
      "print-page-court-Main Ground-detailed",
    );
    await waitFor(() =>
      expect(detailed).toHaveTextContent("7. Asen Jamir"),
    );
    expect(detailed).toHaveTextContent("Alpha FC");
    // Captain is marked, a player with no shirt number still reads.
    expect(detailed).toHaveTextContent("(C)");
    expect(detailed).toHaveTextContent("Chubala Imchen");
    // Teams with no published sheet say so instead of printing a blank.
    expect(detailed).toHaveTextContent("No team sheet");
    // The by-team pass is untouched by any of it.
    expect(teams).toHaveTextContent("Alpha FC");
    expect(teams).not.toHaveTextContent("Asen Jamir");
  });

  it("prints ONE pass when the reader asks for one, and names the file for it", async () => {
    // Every export used to be the whole fixture twice over, so an organiser
    // after an order of play binned half the printout (owner 2026-08-22).
    const print = vi.fn();
    window.print = print;
    mount();
    await screen.findByTestId("public-day-2026-06-20");

    await clickPrint("teams");
    await waitFor(() => expect(print).toHaveBeenCalled());
    const doc = screen.getByTestId("fixture-print-doc");
    expect(
      within(doc).getByTestId("print-page-court-Main Ground-teams"),
    ).toBeInTheDocument();
    expect(
      within(doc).queryByTestId("print-page-court-Main Ground-detailed"),
    ).toBeNull();
    // The saved file says which pass it is, so the team sheet and the player
    // sheet of one day are two files a downloads list can tell apart.
    expect(document.title).toBe(
      "Sat, Jun 20 - Order of play - Nagaland Schools Cup",
    );
  });

  it("prints the player pass alone when that is what was asked for", async () => {
    const print = vi.fn();
    window.print = print;
    mount();
    await screen.findByTestId("public-day-2026-06-20");

    await clickPrint("detailed");
    await waitFor(() => expect(print).toHaveBeenCalled());
    const doc = screen.getByTestId("fixture-print-doc");
    expect(
      within(doc).getByTestId("print-page-court-Main Ground-detailed"),
    ).toBeInTheDocument();
    expect(
      within(doc).queryByTestId("print-page-court-Main Ground-teams"),
    ).toBeNull();
    expect(document.title).toBe(
      "Sat, Jun 20 - Order of play - With player names - Nagaland Schools Cup",
    );
  });

  it("names the players on the printed BRACKET too, not only the sheet", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await clickPrint();
    // u15 has Alpha FC in a group match and u17 is the knockout: open the one
    // competition whose bracket carries a resolved team.
    await userEvent.click(screen.getByTestId("rail-comp-football.u15"));

    const doc = await screen.findByTestId("fixture-print-doc");
    const detailed = within(doc).getByTestId("print-page-group-Group A-detailed");
    await waitFor(() => expect(detailed).toHaveTextContent("Asen Jamir"));
    // The teams pass of the same competition names nobody.
    expect(
      within(doc).getByTestId("print-page-group-Group A-teams"),
    ).not.toHaveTextContent("Asen Jamir");
  });

  it("a competition prints its group sheets and then its bracket", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await userEvent.click(screen.getByTestId("rail-comp-football.u17"));

    const doc = await screen.findByTestId("fixture-print-doc");
    // u17 is knockout-only, so there is nothing to table — the tree is the
    // whole page, twice.
    expect(
      within(doc).getByTestId("print-page-comp-knockout-teams"),
    ).toBeInTheDocument();
    expect(
      within(doc).getByTestId("print-page-comp-knockout-detailed"),
    ).toBeInTheDocument();
    expect(within(doc).queryByTestId("print-page-group-Group A-teams")).toBeNull();
    // The tree, and ONLY the tree: a knockout is read as a flow chart, and an
    // order-of-play table beside it says the same thing twice (owner
    // 2026-08-21).
    expect(
      within(doc).queryByTestId("print-page-comp-knockout-sheet-teams"),
    ).toBeNull();

    // A competition with a group stage prints it too, ONE GROUP PER PAGE —
    // never two groups sharing a sheet with nothing to say where one ends.
    await userEvent.click(screen.getByTestId("rail-comp-football.u15"));
    await waitFor(() =>
      expect(
        within(screen.getByTestId("fixture-print-doc")).getByTestId(
          "print-page-group-Group A-teams",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("a group stage prints WHO IS IN each group, ahead of the order of play", async () => {
    // The order of play names a team once per match, scattered down nine
    // columns, so the printout could not answer the first question a group
    // stage is asked (owner 2026-08-22).
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await clickPrint();
    await userEvent.click(screen.getByTestId("rail-comp-football.u15"));

    const doc = await screen.findByTestId("fixture-print-doc");
    const page = within(doc).getByTestId("print-page-groups-teams");
    const card = within(page).getByTestId("print-teams-lineup-group-Group A");
    // Every team drawn into the group, once each — not once per match — in
    // the order the draw put them there.
    const rows = within(card).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Alpha FC"),
      expect.stringContaining("Bravo FC"),
      expect.stringContaining("Carol FC"),
      expect.stringContaining("Delta FC"),
    ]);
    expect(card).toHaveTextContent("4 teams");

    // It LEADS the export: composition, then the order of play, then the tree.
    const sheet = within(doc).getByTestId("print-page-group-Group A-teams");
    expect(
      page.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // The detailed pass names the squad under each team, from the same team
    // sheet the match rows use.
    const detailed = within(doc).getByTestId("print-page-groups-detailed");
    await waitFor(() => expect(detailed).toHaveTextContent("Asen Jamir"));
    expect(detailed).toHaveTextContent("Chubala Imchen");
    // Teams with no published sheet say so rather than printing a blank.
    expect(detailed).toHaveTextContent("No team sheet");
    expect(page).not.toHaveTextContent("Asen Jamir");
  });

  it("prints no composition for a knockout-only competition", async () => {
    // Nobody is in a bracket band yet, which is what the tree already says.
    mount();
    await screen.findByTestId("public-day-2026-06-20");
    await userEvent.click(screen.getByTestId("rail-comp-football.u17"));
    const doc = await screen.findByTestId("fixture-print-doc");
    await waitFor(() =>
      expect(
        within(doc).getByTestId("print-page-comp-knockout-teams"),
      ).toBeInTheDocument(),
    );
    expect(within(doc).queryByTestId("print-page-groups-teams")).toBeNull();
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

  it("badges every team: crest when it has one, initials when it does not, nothing for a TBD side", async () => {
    mount();
    const m1 = await screen.findByTestId("court-Main Ground-row-m1");
    // Alpha wears its crest in both the Home cell and the Winner cell.
    expect(within(m1).getAllByTestId("team-crest")[0]).toHaveAttribute(
      "src",
      ALPHA_CREST,
    );
    expect(within(m1).getByTestId("team-crest-fallback")).toHaveTextContent("BF");

    // The badge stays inside the team link, so it opens the team page and
    // never steals the link's accessible name.
    const team = within(m1).getByRole("link", { name: "Alpha FC" });
    expect(within(team).getByTestId("team-crest")).toBeInTheDocument();

    // A bracket slot with no team yet gets NEITHER: there is nobody to badge.
    await userEvent.click(screen.getByTestId("day-pick-2026-06-21"));
    await userEvent.click(screen.getByTestId("view-courts"));
    const m3 = await screen.findByTestId("court-Side Pitch-row-m3");
    expect(within(m3).queryByTestId("team-crest")).toBeNull();
    expect(within(m3).queryByTestId("team-crest-fallback")).toBeNull();
  });

  it("scales the crest up on the Now-playing hero", async () => {
    mount();
    const tile = within(await screen.findByTestId("live-band")).getByTestId(
      "live-tile-m2",
    );
    const crest = within(tile).getByTestId("team-crest");
    expect(crest).toHaveAttribute("src", CAROL_CREST);
    // Hero size, not the list-row size: this is what a parent sees first.
    expect(crest.className).toContain("h-10");
    expect(within(tile).getByTestId("team-crest-fallback")).toHaveTextContent("DF");
  });

  it("prints the crests on the order of play", async () => {
    mount();
    await screen.findByTestId("public-day-2026-06-20");

    const sheet = within(screen.getByTestId("fixture-print-doc")).getByTestId(
      "print-page-court-Main Ground-teams",
    );
    const printed = within(sheet).getAllByTestId("team-crest");
    expect(printed[0]).toHaveAttribute("src", ALPHA_CREST);
    // Small enough that the table still fits the page.
    expect(printed[0]!.className).toContain("h-4");
    expect(within(sheet).getAllByTestId("team-crest-fallback").length).toBeGreaterThan(0);
  });

  it("the whole match row opens the match drawer; team names still open their team page", async () => {
    mount();
    const m1 = await screen.findByTestId("court-Main Ground-row-m1");
    // Stretched link over the row -> this match, opened over the sheet. It is
    // a real link, so middle-click opens the sheet with it already open.
    const row = within(m1).getByRole("link", { name: /vs/i });
    expect(row.getAttribute("href")).toContain("match=m1");
    // The team name is still its own link, above the stretched one.
    const team = within(m1).getByRole("link", { name: "Alpha FC" });
    expect(team.getAttribute("href")).toContain("/team/");
  });
});
