import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});

describe("FixtureSetupHub", () => {
  it("renders the global setup card and one readiness checklist per competition", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    expect(await screen.findByText("Football · U15")).toBeInTheDocument();
    expect(screen.getByText("Football · U17")).toBeInTheDocument();
    expect(screen.getByText("Global setup")).toBeInTheDocument();
    // progress summaries from the server, never recomputed
    expect(screen.getByText(/5\/5/)).toBeInTheDocument();
    expect(screen.getByText(/2\/5/)).toBeInTheDocument();
  });

  it("gates the generate CTA on server readiness", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    expect(await screen.findByTestId("generate-football.u15")).toBeEnabled();
    expect(screen.getByTestId("generate-football.u17")).toBeDisabled();
  });

  it("deep-links a venues fix into the global setup wizard", async () => {
    wrap(<FixtureSetupHub tournamentId="t1" />);
    await screen.findByText("Football · U17");
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
    await screen.findByText("Football · U17");
    const fixes = screen.getAllByRole("button", { name: "Fix" });
    await userEvent.click(fixes[0]); // enough_teams
    await waitFor(() =>
      expect(screen.getByTestId("teams-page")).toBeInTheDocument(),
    );
  });

  it("shows the read-only result card for a drawn competition and routes the stale-draw banner to a fresh preview", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      {
        id: "m1", stage: "group", group_label: "Group A", round_no: 1,
        match_no: 1, status: "scheduled",
        home_team: { id: "tm1", name: "A FC", short_name: "A" },
        away_team: { id: "tm2", name: "B FC", short_name: "B" },
        home_score: null, away_score: null, sport: "football", set_scores: [],
        leaf_key: "football.u15", venue: "", scoring: null, scheduled_at: null,
      } as MatchRow,
    ]);
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
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      {
        id: "m1", stage: "group", group_label: "Group A", round_no: 1,
        match_no: 1, status: "scheduled",
        home_team: { id: "tm1", name: "A FC", short_name: "A" },
        away_team: { id: "tm2", name: "B FC", short_name: "B" },
        home_score: null, away_score: null, sport: "football", set_scores: [],
        leaf_key: "football.u15", venue: "", scoring: null, scheduled_at: null,
      } as MatchRow,
    ]);
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
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      {
        id: "m1", stage: "group", group_label: "Group A", round_no: 1,
        match_no: 1, status: "scheduled",
        home_team: { id: "tm1", name: "A FC", short_name: "A" },
        away_team: { id: "tm2", name: "B FC", short_name: "B" },
        home_score: null, away_score: null, sport: "football", set_scores: [],
        leaf_key: "football.u15", venue: "", scoring: null, scheduled_at: null,
      } as MatchRow,
    ]);
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

  it("the inputs-changed banner can be dismissed with Keep", async () => {
    vi.mocked(tournamentsApi.matches).mockResolvedValue([
      {
        id: "m1", stage: "group", group_label: "Group A", round_no: 1,
        match_no: 1, status: "scheduled",
        home_team: { id: "tm1", name: "A FC", short_name: "A" },
        away_team: { id: "tm2", name: "B FC", short_name: "B" },
        home_score: null, away_score: null, sport: "football", set_scores: [],
        leaf_key: "football.u15", venue: "", scoring: null, scheduled_at: null,
      } as MatchRow,
    ]);
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

    expect(await screen.findByTestId("inputs-changed-banner")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("keep-draw"));
    expect(screen.queryByTestId("inputs-changed-banner")).toBeNull();
  });
});
