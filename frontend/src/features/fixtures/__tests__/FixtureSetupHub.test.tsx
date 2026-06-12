import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type DrawConfig,
  type FixtureReadiness,
  type MatchRow,
  type StagePayload,
  type TeamRow,
  type TournamentSettings,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { FixtureSetupHub } from "../FixtureSetupHub";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      get: vi.fn(),
      teams: vi.fn(),
      matches: vi.fn(),
      standings: vi.fn(),
      stage: vi.fn(),
      fixtureReadiness: vi.fn(),
      drawConfig: vi.fn(),
      venues: vi.fn(),
      settings: vi.fn(),
      constraintTypes: vi.fn(),
      sports: vi.fn(),
      scheduleChanges: vi.fn(),
      scheduleFixtures: vi.fn(),
      swissNextRound: vi.fn(),
    },
  };
});

const READINESS: FixtureReadiness = {
  global: {
    checks: [
      { id: "calendar_set", status: "ok" },
      { id: "venues_defined", status: "ok" },
      { id: "constraints_reviewed", status: "ok" },
    ],
  },
  competitions: [
    {
      leaf_key: "football.u15",
      label: "Football · U15",
      ready: true,
      summary: "5/5",
      checks: [
        { id: "enough_teams", status: "ok", hint: "2 registered teams" },
        { id: "format_chosen", status: "ok" },
        { id: "seeds_set", status: "ok" },
        { id: "calendar_set", status: "ok" },
        { id: "constraints_reviewed", status: "ok" },
        { id: "already_generated", status: "ok", hint: "No existing draw" },
      ],
    },
    {
      leaf_key: "football.u17",
      label: "Football · U17",
      ready: false,
      summary: "2/5",
      checks: [
        {
          id: "enough_teams",
          status: "fail",
          hint: "0 registered team(s) — minimum 2",
          fix: "teams",
        },
        { id: "format_chosen", status: "ok" },
        { id: "seeds_set", status: "ok" },
        {
          id: "venues_defined",
          status: "fail",
          hint: "No venues defined — add at least one.",
          fix: "venues",
        },
        { id: "constraints_reviewed", status: "warn", fix: "constraints" },
        { id: "already_generated", status: "ok" },
      ],
    },
  ],
};

const TEAMS: TeamRow[] = [
  {
    id: "tm1", name: "A FC", short_name: "A", school: "A School", pool: "U15",
    sport: "football", leaf_key: "football.u15", status: "registered",
    player_count: 7,
  },
  {
    id: "tm2", name: "B FC", short_name: "B", school: "B School", pool: "U15",
    sport: "football", leaf_key: "football.u15", status: "registered",
    player_count: 7,
  },
];

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/fixtures"]}>
          <Routes>
            <Route path="/tournaments/t1/fixtures" element={ui} />
            <Route
              path="/tournaments/t1/teams"
              element={<div data-testid="teams-page" />}
            />
            <Route
              path="/tournaments/t1/fixtures/preview"
              element={<div data-testid="preview-page" />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.get).mockResolvedValue({
    id: "t1",
    slug: "nagaland-cup",
    name: "Nagaland Schools Cup",
  } as Awaited<ReturnType<typeof tournamentsApi.get>>);
  vi.mocked(tournamentsApi.teams).mockResolvedValue(TEAMS);
  vi.mocked(tournamentsApi.matches).mockResolvedValue([]);
  vi.mocked(tournamentsApi.standings).mockResolvedValue({ groups: [] });
  vi.mocked(tournamentsApi.stage).mockResolvedValue({
    can_manage: true,
    modules: [],
  } as unknown as StagePayload);
  vi.mocked(tournamentsApi.fixtureReadiness).mockResolvedValue(READINESS);
  vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
    draw_config: {},
    defaults: { format: "round_robin" } as unknown as DrawConfig,
  });
  vi.mocked(tournamentsApi.venues).mockResolvedValue({ venues: [] });
  vi.mocked(tournamentsApi.settings).mockResolvedValue({
    rules: {},
    constraints: [],
    rules_frozen_at: null,
    can_edit: true,
    can_manage: true,
    can_delete: true,
  } as unknown as TournamentSettings);
  vi.mocked(tournamentsApi.constraintTypes).mockResolvedValue([]);
  vi.mocked(tournamentsApi.sports).mockResolvedValue({ sports: [] });
  vi.mocked(tournamentsApi.scheduleChanges).mockResolvedValue({ results: [] });
  vi.mocked(tournamentsApi.scheduleFixtures).mockResolvedValue({
    scheduled: 1, unscheduled: [], soft_score: 0.9, explanation: [],
  });
  vi.mocked(tournamentsApi.swissNextRound).mockResolvedValue({
    generated: 1,
    round_no: 2,
    leaf_key: "football.u15",
    matches: ["m9"],
    warnings: [],
  });
});

/** A group-stage match in football.u15 (unscheduled by default). */
function groupMatch(id = "m1", over: Partial<MatchRow> = {}): MatchRow {
  return {
    id, stage: "group", group_label: "Group A", round_no: 1,
    match_no: 1, status: "scheduled",
    home_team: { id: "tm1", name: "A FC", short_name: "A" },
    away_team: { id: "tm2", name: "B FC", short_name: "B" },
    home_score: null, away_score: null, sport: "football", set_scores: [],
    leaf_key: "football.u15", venue: "", scoring: null, scheduled_at: null,
    ...over,
  } as MatchRow;
}

/** A finished Swiss-round match in football.u15. */
function swissMatch(id: string, status = "completed"): MatchRow {
  return {
    id, stage: "swiss", group_label: "Swiss", round_no: 1,
    match_no: 1, status,
    home_team: { id: "tm1", name: "A FC", short_name: "A" },
    away_team: { id: "tm2", name: "B FC", short_name: "B" },
    home_score: 1, away_score: 0, sport: "football", set_scores: [],
    leaf_key: "football.u15", venue: "", scoring: null, scheduled_at: null,
  } as MatchRow;
}

/** Stored Swiss draw config for the u15 leaf (drives the next-round CTA). */
function mockSwissConfig(): void {
  vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
    draw_config: { "football.u15": { format: "swiss", swiss_rounds: 3 } },
    defaults: { format: "round_robin" } as unknown as DrawConfig,
  });
}

/** Readiness whose GLOBAL checks fail — the stage gate must engage. */
function mockGlobalsUnset(): void {
  vi.mocked(tournamentsApi.fixtureReadiness).mockResolvedValue({
    global: {
      checks: [
        {
          id: "calendar_set",
          status: "fail",
          hint: "No tournament calendar yet — set the date range.",
          fix: "settings",
        },
        {
          id: "venues_defined",
          status: "fail",
          hint: "No venues defined — add at least one.",
          fix: "venues",
        },
      ],
    },
    competitions: READINESS.competitions,
  });
}

/** Mark u15's draw as drifted (already_generated warn → D2 banner). */
function mockDriftedU15(): void {
  vi.mocked(tournamentsApi.fixtureReadiness).mockResolvedValue({
    ...READINESS,
    competitions: [
      {
        ...READINESS.competitions[0],
        checks: READINESS.competitions[0].checks.map((c) =>
          c.id === "already_generated"
            ? { ...c, status: "warn" as const, fix: "diff" }
            : c,
        ),
      },
      READINESS.competitions[1],
    ],
  });
}

describe("FixtureSetupHub", () => {
  it("stage-gates everything behind Step 1 until dates and venues exist", async () => {
    mockGlobalsUnset();
    wrap(<FixtureSetupHub tournamentId="t1" />);

    expect(await screen.findByTestId("global-setup-gate")).toBeInTheDocument();
    expect(screen.getByText("Let's set up your fixtures")).toBeInTheDocument();
    // the journey header points at step 1
    expect(screen.getByTestId("journey-next")).toHaveTextContent(
      "Next: set your tournament dates and venues.",
    );
    // competitions, the receipt strip and the Advanced tools are all hidden
    expect(screen.queryByTestId("competition-card-football.u15")).toBeNull();
    expect(screen.queryByTestId("global-setup-strip")).toBeNull();
    expect(screen.queryByTestId("advanced-tools")).toBeNull();
    // the CTA opens the Step 1 wizard
    await userEvent.click(screen.getByTestId("global-setup-cta"));
    expect(
      await screen.findByRole("dialog", { name: "Step 1 · When & where" }),
    ).toBeInTheDocument();
  });

  it("renders the journey, the Step 1 receipt and grouped competition cards (no raw n/5 badge)", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    // globals set → receipt strip, not the gate
    expect(await screen.findByTestId("global-setup-strip")).toBeInTheDocument();
    expect(screen.queryByTestId("global-setup-gate")).toBeNull();
    expect(screen.getByText("Step 1 · When & where")).toBeInTheDocument();
    expect(screen.getByTestId("journey-next")).toHaveTextContent(
      "Next: choose how each competition plays.",
    );

    // u15 (ready) sits in the open "Ready to go" section as a card with ONE
    // sentence — the raw server summary badge is gone from the card face
    expect(screen.getByTestId("section-ready")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const card = screen.getByTestId("competition-card-football.u15");
    expect(
      within(card).getByText("Ready to preview. Nothing is saved until you publish."),
    ).toBeInTheDocument();
    expect(within(card).queryByText("5/5")).toBeNull();
    // no toolbar before the journey is done
    expect(screen.queryByTestId("share-schedule")).toBeNull();
    expect(screen.queryByTestId("hub-more")).toBeNull();
    // no competition needs setup or is drawn → those sections don't render
    expect(screen.queryByTestId("section-needs_setup")).toBeNull();
    expect(screen.queryByTestId("section-drawn")).toBeNull();
  });

  it("collapses the Waiting-for-teams section by default, showing only the count", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    const needsTeams = await screen.findByTestId("section-needs_teams");
    expect(needsTeams).toHaveAttribute("aria-expanded", "false");
    expect(within(needsTeams).getByText("1")).toBeInTheDocument();
    // u17 (0 teams) is hidden until the section is opened
    expect(screen.queryByTestId("competition-card-football.u17")).toBeNull();
    await userEvent.click(needsTeams);
    const card = screen.getByTestId("competition-card-football.u17");
    expect(
      within(card).getByText("Waiting for teams - 0 of 2 minimum."),
    ).toBeInTheDocument();
  });

  it("hides the checklist behind See what's missing; one detail open at a time", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
    wrap(<FixtureSetupHub tournamentId="t1" />);

    // open the drawn card's body
    await userEvent.click(
      await screen.findByTestId("competition-row-football.u15"),
    );
    expect(await screen.findByTestId("competition-result-card")).toBeInTheDocument();

    // opening u17's what's-missing detail closes u15's body (single slot)
    await userEvent.click(screen.getByTestId("section-needs_teams"));
    expect(screen.queryByText("Teams registered")).toBeNull();
    await userEvent.click(screen.getByTestId("whats-missing-football.u17"));
    expect(screen.getByText("Teams registered")).toBeInTheDocument();
    expect(screen.getByText("2 of 5 checks passed")).toBeInTheDocument();
    expect(screen.queryByTestId("competition-result-card")).toBeNull();

    // toggling again collapses it
    await userEvent.click(screen.getByTestId("whats-missing-football.u17"));
    expect(screen.queryByText("Teams registered")).toBeNull();
  });

  it("the ready card's single primary goes straight to the preview", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    await userEvent.click(await screen.findByTestId("generate-football.u15"));
    await waitFor(() =>
      expect(screen.getByTestId("preview-page")).toBeInTheDocument(),
    );
  });

  it("Change format on a ready card opens the Step 2 wizard", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    await userEvent.click(
      await screen.findByTestId("change-format-football.u15"),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "Step 2 · How Football · U15 plays",
      }),
    ).toBeInTheDocument();
  });

  it("deep-links a venues fix into the Step 1 wizard", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    await userEvent.click(await screen.findByTestId("section-needs_teams"));
    await userEvent.click(screen.getByTestId("whats-missing-football.u17"));
    // U17 has two fixable fails (teams, venues) + a warn (constraints)
    const fixes = screen.getAllByRole("button", { name: "Fix this" });
    await userEvent.click(fixes[1]); // venues_defined
    expect(
      await screen.findByRole("dialog", { name: "Step 1 · When & where" }),
    ).toBeInTheDocument();
    // opened at the venues step
    expect(await screen.findByTestId("add-venue")).toBeInTheDocument();
  });

  it("deep-links a teams fix to the teams tab", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    await userEvent.click(await screen.findByTestId("section-needs_teams"));
    await userEvent.click(screen.getByTestId("whats-missing-football.u17"));
    const fixes = screen.getAllByRole("button", { name: "Fix this" });
    await userEvent.click(fixes[0]); // enough_teams
    await waitFor(() =>
      expect(screen.getByTestId("teams-page")).toBeInTheDocument(),
    );
  });

  it("files a drawn competition under Scheduled and routes the drift banner to a fresh preview", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
    mockDriftedU15();
    wrap(<FixtureSetupHub tournamentId="t1" />);

    // the drawn competition files under the (open) Scheduled section
    expect(await screen.findByTestId("section-drawn")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // D2: the banner replaces the sentence on the card face
    const card = screen.getByTestId("competition-card-football.u15");
    expect(
      within(card).getByTestId("inputs-changed-banner"),
    ).toBeInTheDocument();
    await userEvent.click(within(card).getByTestId("re-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("preview-page")).toBeInTheDocument(),
    );
  });

  it("Keep this draw dismisses the drift banner and restores the sentence", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
    mockDriftedU15();
    wrap(<FixtureSetupHub tournamentId="t1" />);

    await userEvent.click(await screen.findByTestId("keep-draw"));
    expect(screen.queryByTestId("inputs-changed-banner")).toBeNull();
    expect(
      screen.getByText("Drawn - 1 match, not yet scheduled."),
    ).toBeInTheDocument();
  });

  it("celebrates a fully drawn journey and Share copies the public URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
    wrap(<FixtureSetupHub tournamentId="t1" />);

    const banner = await screen.findByTestId("done-banner");
    expect(within(banner).getByText("Your schedule is out")).toBeInTheDocument();
    const share = within(banner).getByTestId("share-schedule");
    await waitFor(() => expect(share).toBeEnabled()); // slug resolved
    await userEvent.click(share);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("/t/nagaland-cup/t1/schedule"),
      ),
    );
    expect(await screen.findByText("Schedule link copied")).toBeInTheDocument();

    // dismissing the banner moves the Share primary into the toolbar
    await userEvent.click(screen.getByTestId("done-dismiss"));
    expect(screen.queryByTestId("done-banner")).toBeNull();
    expect(screen.getByTestId("share-schedule")).toBeInTheDocument();
  });

  it("Print lives in the More menu and opens the public schedule page", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
    wrap(<FixtureSetupHub tournamentId="t1" />);

    await userEvent.click(await screen.findByTestId("hub-more"));
    const print = screen.getByTestId("print-order-of-play");
    await waitFor(() => expect(print).toBeEnabled());
    await userEvent.click(print);
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("/t/nagaland-cup/t1/schedule"),
      "_blank",
      "noopener",
    );
    vi.unstubAllGlobals();
  });

  it("Re-run schedule confirms with the stored Step 1 answers prefilled (never re-asks)", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {
        "*": {
          calendar: {
            date_start: "2026-08-01", date_end: "2026-08-05",
            daily_start: "08:00", daily_end: "17:00", slot_minutes: 60,
          },
        },
      },
      defaults: { format: "round_robin" } as unknown as DrawConfig,
    });
    vi.mocked(tournamentsApi.settings).mockResolvedValue({
      rules: {},
      constraints: [
        { type: "min_rest_minutes", scope: "all", hard: true, weight: 5,
          params: { minutes: 45 } },
        { type: "max_matches_per_team_per_day", scope: "all", hard: true,
          weight: 5, params: { count: 2 } },
      ],
      rules_frozen_at: null,
      can_edit: true, can_manage: true, can_delete: true,
    } as unknown as TournamentSettings);
    wrap(<FixtureSetupHub tournamentId="t1" />);

    await userEvent.click(await screen.findByTestId("hub-more"));
    await userEvent.click(screen.getByTestId("re-run-schedule"));
    // a single confirm with the stored answers — no date questions re-asked
    const summary = await screen.findByTestId("rerun-summary");
    await waitFor(() =>
      expect(summary).toHaveTextContent("2026-08-01 to 2026-08-05"),
    );
    expect(summary).toHaveTextContent("08:00 to 17:00, 60 min per match");
    expect(summary).toHaveTextContent("45 min between matches, max 2 per day");

    await userEvent.click(screen.getByTestId("rerun-schedule-submit"));
    await waitFor(() =>
      expect(tournamentsApi.scheduleFixtures).toHaveBeenCalledWith("t1", {
        date_start: "2026-08-01",
        date_end: "2026-08-05",
        daily_start: "08:00",
        daily_end: "17:00",
        slot_minutes: 60,
        venues: [],
        rest_minutes: 45,
        max_per_team_per_day: 2,
      }),
    );
    expect(await screen.findByText("1 matches scheduled")).toBeInTheDocument();
  });

  it("keeps the rules, history and tables behind the closed Advanced disclosure", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
    vi.mocked(tournamentsApi.standings).mockResolvedValue({
      groups: [
        {
          group_label: "Group A",
          rows: [
            {
              team_id: "tm1", name: "A FC", school: "A School",
              P: 1, W: 1, D: 0, L: 0, GF: 1, GA: 0, GD: 1, Pts: 3,
            },
          ],
        },
      ],
    });
    wrap(<FixtureSetupHub tournamentId="t1" />);

    // closed by default — no panels mounted
    const toggle = await screen.findByTestId("advanced-tools-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("hub-tab-constraints")).toBeNull();

    await userEvent.click(toggle);
    // Scheduling rules is the default tab; the other panels are NOT mounted
    expect(screen.getByTestId("hub-tab-constraints")).toHaveTextContent(
      "Scheduling rules",
    );
    expect(await screen.findByTestId("mark-reviewed")).toBeInTheDocument();
    expect(screen.queryByTestId("schedule-changes-panel")).toBeNull();

    await userEvent.click(screen.getByTestId("hub-tab-changes"));
    expect(
      await screen.findByTestId("schedule-changes-panel"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("mark-reviewed")).toBeNull();

    await userEvent.click(screen.getByTestId("hub-tab-standings"));
    expect(await screen.findByText("Group A")).toBeInTheDocument();
    expect(screen.queryByTestId("schedule-changes-panel")).toBeNull();
  });

  it("offers Pair the next round on the card face once a Swiss round is decided", async () => {
    mockSwissConfig();
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      swissMatch("m1", "completed"),
      swissMatch("m2", "walkover"),
    ]);
    wrap(<FixtureSetupHub tournamentId="t1" />);

    expect(
      await screen.findByText(
        "Round 1 is finished. Pair the next round from the standings.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("next-round-football.u15"));
    await waitFor(() =>
      expect(tournamentsApi.swissNextRound).toHaveBeenCalledWith("t1", {
        leaf_key: "football.u15",
        event_id: expect.any(String),
      }),
    );
    expect(
      await screen.findByText("Round 2 paired - 1 match"),
    ).toBeInTheDocument();
  });

  it("hides Pair the next round while the round is unfinished or the format is not swiss", async () => {
    // unfinished round
    mockSwissConfig();
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      swissMatch("m1", "completed"),
      swissMatch("m2", "scheduled"),
    ]);
    const { unmount } = wrap(<FixtureSetupHub tournamentId="t1" />);
    expect(
      await screen.findByTestId("competition-card-football.u15"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("next-round-football.u15")).toBeNull();
    unmount();

    // finished matches but a non-swiss stored format
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      swissMatch("m1", "completed"),
    ]);
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: { "football.u15": { format: "round_robin" } },
      defaults: { format: "round_robin" } as unknown as DrawConfig,
    });
    wrap(<FixtureSetupHub tournamentId="t1" />);
    expect(
      await screen.findByTestId("competition-card-football.u15"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("next-round-football.u15")).toBeNull();
  });

  it("surfaces the round_incomplete refusal as a plain toast description", async () => {
    mockSwissConfig();
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      swissMatch("m1", "completed"),
    ]);
    vi.mocked(tournamentsApi.swissNextRound).mockRejectedValue(
      new ApiError(400, { detail: "round_incomplete" }),
    );
    wrap(<FixtureSetupHub tournamentId="t1" />);

    await userEvent.click(
      await screen.findByTestId("next-round-football.u15"),
    );
    expect(
      await screen.findByText("Could not pair the next round"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This round still has unfinished matches. Finish or walk over every match first.",
      ),
    ).toBeInTheDocument();
  });

  it("offers Build the bracket once the group stage is finished and opens the confirm", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      groupMatch("m1", { status: "completed", home_score: 1, away_score: 0 }),
    ]);
    wrap(<FixtureSetupHub tournamentId="t1" />);

    expect(
      await screen.findByText(
        "The group stage is finished. Build the knockout bracket from the standings.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("advance-football.u15"));
    expect(
      await screen.findByRole("dialog", { name: "Build the knockout bracket" }),
    ).toBeInTheDocument();
  });
});
