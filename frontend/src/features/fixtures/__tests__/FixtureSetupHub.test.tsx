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
  vi.mocked(tournamentsApi.swissNextRound).mockResolvedValue({
    generated: 1,
    round_no: 2,
    leaf_key: "football.u15",
    matches: ["m9"],
    warnings: [],
  });
});

/** A scheduled group-stage match in football.u15. */
function groupMatch(id = "m1"): MatchRow {
  return {
    id, stage: "group", group_label: "Group A", round_no: 1,
    match_no: 1, status: "scheduled",
    home_team: { id: "tm1", name: "A FC", short_name: "A" },
    away_team: { id: "tm2", name: "B FC", short_name: "B" },
    home_score: null, away_score: null, sport: "football", set_scores: [],
    leaf_key: "football.u15", venue: "", scoring: null, scheduled_at: null,
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

/** Expand one competition row (accordion). */
async function expandRow(key: string): Promise<void> {
  await userEvent.click(await screen.findByTestId(`competition-row-${key}`));
}

describe("FixtureSetupHub", () => {
  it("stage-gates everything behind global setup until dates and venues exist", async () => {
    mockGlobalsUnset();
    wrap(<FixtureSetupHub tournamentId="t1" />);

    expect(await screen.findByTestId("global-setup-gate")).toBeInTheDocument();
    expect(
      screen.getByText("Start with the global setup"),
    ).toBeInTheDocument();
    // competitions, the summary strip and the tab bar are all hidden
    expect(screen.queryByTestId("competition-row-football.u15")).toBeNull();
    expect(screen.queryByTestId("global-setup-strip")).toBeNull();
    expect(screen.queryByTestId("hub-tab-constraints")).toBeNull();
    // the CTA opens the GlobalSetupWizard
    await userEvent.click(screen.getByTestId("global-setup-cta"));
    expect(
      await screen.findByRole("dialog", { name: "Global setup" }),
    ).toBeInTheDocument();
  });

  it("renders the slim global strip and groups competitions into funnel sections", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    // globals set → slim strip, not the gate
    expect(await screen.findByTestId("global-setup-strip")).toBeInTheDocument();
    expect(screen.queryByTestId("global-setup-gate")).toBeNull();
    expect(screen.getByText("Global setup")).toBeInTheDocument();

    // u15 (ready) sits in the open "Ready to draw" section with its server
    // summary as a badge — never recomputed
    expect(screen.getByTestId("section-ready")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.getByTestId("competition-row-football.u15"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("readiness-badge-football.u15"),
    ).toHaveTextContent("5/5");
    // no competition needs setup or is drawn → those sections don't render
    expect(screen.queryByTestId("section-needs_setup")).toBeNull();
    expect(screen.queryByTestId("section-drawn")).toBeNull();
  });

  it("collapses the Needs-teams section by default, showing only the count", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    const needsTeams = await screen.findByTestId("section-needs_teams");
    expect(needsTeams).toHaveAttribute("aria-expanded", "false");
    expect(within(needsTeams).getByText("1")).toBeInTheDocument();
    // u17 (0 teams) is hidden until the section is opened
    expect(screen.queryByTestId("competition-row-football.u17")).toBeNull();
    await userEvent.click(needsTeams);
    expect(
      screen.getByTestId("competition-row-football.u17"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("readiness-badge-football.u17"),
    ).toHaveTextContent("2/5");
  });

  it("expands rows accordion-style — only one checklist open at a time", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    await expandRow("football.u15");
    expect(screen.getByTestId("generate-football.u15")).toBeEnabled();

    await userEvent.click(screen.getByTestId("section-needs_teams"));
    await expandRow("football.u17");
    // u17's expansion replaced u15's (single-open accordion)
    expect(screen.getByTestId("generate-football.u17")).toBeDisabled();
    expect(screen.queryByTestId("generate-football.u15")).toBeNull();

    // clicking the open row again collapses it
    await userEvent.click(screen.getByTestId("competition-row-football.u17"));
    expect(screen.queryByTestId("generate-football.u17")).toBeNull();
  });

  it("gates the generate CTA on server readiness", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    await expandRow("football.u15");
    expect(screen.getByTestId("generate-football.u15")).toBeEnabled();
    await userEvent.click(screen.getByTestId("section-needs_teams"));
    await expandRow("football.u17");
    expect(screen.getByTestId("generate-football.u17")).toBeDisabled();
  });

  it("deep-links a venues fix into the global setup wizard", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    await userEvent.click(await screen.findByTestId("section-needs_teams"));
    await expandRow("football.u17");
    // U17 has two fixable fails (teams, venues) + a warn (constraints)
    const fixes = screen.getAllByRole("button", { name: "Fix" });
    await userEvent.click(fixes[1]); // venues_defined
    expect(
      await screen.findByRole("dialog", { name: "Global setup" }),
    ).toBeInTheDocument();
    // opened at the venues step
    expect(await screen.findByTestId("add-venue")).toBeInTheDocument();
  });

  it("deep-links a teams fix to the teams tab", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    await userEvent.click(await screen.findByTestId("section-needs_teams"));
    await expandRow("football.u17");
    const fixes = screen.getAllByRole("button", { name: "Fix" });
    await userEvent.click(fixes[0]); // enough_teams
    await waitFor(() =>
      expect(screen.getByTestId("teams-page")).toBeInTheDocument(),
    );
  });

  it("files a drawn competition under Drawn, shows the read-only result card and routes the stale-draw banner to a fresh preview", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
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
    wrap(<FixtureSetupHub tournamentId="t1" />);

    // the drawn competition files under the (open) Drawn section
    expect(await screen.findByTestId("section-drawn")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expandRow("football.u15");
    // post-generation: read-only card, no inline score entry (§6 screen 6)
    expect(await screen.findByTestId("competition-result-card")).toBeInTheDocument();
    expect(screen.queryByLabelText("Home score")).toBeNull();
    // invariant-10 banner → fresh dry run for that competition
    await userEvent.click(screen.getByTestId("re-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("preview-page")).toBeInTheDocument(),
    );
  });

  it("Share schedule copies the public schedule URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
    wrap(<FixtureSetupHub tournamentId="t1" />);

    const share = await screen.findByTestId("share-schedule");
    await waitFor(() => expect(share).toBeEnabled()); // slug resolved
    await userEvent.click(share);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("/t/nagaland-cup/t1/schedule"),
      ),
    );
    expect(
      await screen.findByText("Public schedule link copied"),
    ).toBeInTheDocument();
  });

  it("Print opens the public schedule page (the print view lives there)", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
    wrap(<FixtureSetupHub tournamentId="t1" />);

    const print = await screen.findByTestId("print-order-of-play");
    await waitFor(() => expect(print).toBeEnabled());
    await userEvent.click(print);
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("/t/nagaland-cup/t1/schedule"),
      "_blank",
      "noopener",
    );
    vi.unstubAllGlobals();
  });

  it("switches the lower panels via tabs instead of stacking them", async () => {
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

    // Constraints is the default tab; the other panels are NOT mounted
    expect(
      await screen.findByText("Scheduling constraints"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("schedule-changes-panel")).toBeNull();

    await userEvent.click(screen.getByTestId("hub-tab-changes"));
    expect(
      await screen.findByTestId("schedule-changes-panel"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Scheduling constraints")).toBeNull();

    await userEvent.click(screen.getByTestId("hub-tab-standings"));
    expect(await screen.findByText("Group A")).toBeInTheDocument();
    expect(screen.queryByTestId("schedule-changes-panel")).toBeNull();
  });

  it("offers Generate next round once a Swiss round is fully decided and posts the next-round endpoint", async () => {
    mockSwissConfig();
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      swissMatch("m1", "completed"),
      swissMatch("m2", "walkover"),
    ]);
    wrap(<FixtureSetupHub tournamentId="t1" />);

    await expandRow("football.u15");
    const btn = await screen.findByTestId("next-round-football.u15");
    await userEvent.click(btn);
    await waitFor(() =>
      expect(tournamentsApi.swissNextRound).toHaveBeenCalledWith("t1", {
        leaf_key: "football.u15",
        event_id: expect.any(String),
      }),
    );
    expect(
      await screen.findByText("Round 2 generated — 1 match"),
    ).toBeInTheDocument();
  });

  it("hides Generate next round while the current Swiss round is unfinished or the format is not swiss", async () => {
    // unfinished round
    mockSwissConfig();
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      swissMatch("m1", "completed"),
      swissMatch("m2", "scheduled"),
    ]);
    const { unmount } = wrap(<FixtureSetupHub tournamentId="t1" />);
    await expandRow("football.u15");
    expect(await screen.findByTestId("competition-result-card")).toBeInTheDocument();
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
    await expandRow("football.u15");
    expect(await screen.findByTestId("competition-result-card")).toBeInTheDocument();
    expect(screen.queryByTestId("next-round-football.u15")).toBeNull();
  });

  it("surfaces the round_incomplete refusal as a toast description", async () => {
    mockSwissConfig();
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      swissMatch("m1", "completed"),
    ]);
    vi.mocked(tournamentsApi.swissNextRound).mockRejectedValue(
      new ApiError(400, { detail: "round_incomplete" }),
    );
    wrap(<FixtureSetupHub tournamentId="t1" />);

    await expandRow("football.u15");
    await userEvent.click(await screen.findByTestId("next-round-football.u15"));
    expect(
      await screen.findByText("Could not generate the next round"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The current round still has unfinished matches — finish or walk over every match first.",
      ),
    ).toBeInTheDocument();
  });

  it("the inputs-changed banner can be dismissed with Keep", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([groupMatch()]);
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
      ],
    });
    wrap(<FixtureSetupHub tournamentId="t1" />);

    await expandRow("football.u15");
    expect(await screen.findByTestId("inputs-changed-banner")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("keep-draw"));
    expect(screen.queryByTestId("inputs-changed-banner")).toBeNull();
  });
});
