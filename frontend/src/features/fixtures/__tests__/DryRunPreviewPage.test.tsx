import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type DrawConfig,
  type FixturePreview,
  type FixtureReadiness,
  type TeamRow,
  type TournamentSettings,
} from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { DryRunPreviewPage } from "../DryRunPreviewPage";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      drawConfig: vi.fn(),
      teams: vi.fn(),
      fixtureReadiness: vi.fn(),
      previewFixtures: vi.fn(),
      previewAllFixtures: vi.fn(),
      publishAllFixtures: vi.fn(),
      generateFixtures: vi.fn(),
      scheduleFixtures: vi.fn(),
      settings: vi.fn(),
      updateSettings: vi.fn(),
      stage: vi.fn(),
    },
  };
});

const CALENDAR = {
  date_start: "2026-06-20",
  date_end: "2026-06-21",
  daily_start: "09:00",
  daily_end: "17:00",
  slot_minutes: 60,
};

const PREVIEW: FixturePreview = {
  matches: [
    {
      ref: "p1", leaf_key: "football.u15", stage: "group", group_label: "A",
      round_no: 1, home: { team_id: "tm1" }, away: { team_id: "tm2" },
      scheduled_at: "2026-06-20T09:00:00", venue: "Main Ground",
    },
    {
      ref: "p2", leaf_key: "football.u15", stage: "knockout", group_label: "",
      round_no: 2, home: { team_id: "tm1" },
      away: { source: { type: "winner_of", ref: "p1" } },
      scheduled_at: "2026-06-21T10:00:00", venue: "Main Ground",
    },
  ],
  unscheduled: [],
  violations: [],
  soft_score: 0.91,
  fairness: { days_used: 2 },
  seed: 1234567,
  inputs_hash: "hash-1",
  warnings: [],
  explanation: [],
  leaf_key: "football.u15",
};

// A two-stage preview: a group stage + a PLACEHOLDER knockout whose slots are
// group_position pointers (the backend ships these with the FULL legacy label).
const MULTISTAGE_PREVIEW: FixturePreview = {
  ...PREVIEW,
  matches: [
    {
      ref: "g1", leaf_key: "football.u15", stage: "group",
      group_label: "Football — U15 — Group A", round_no: 1,
      home: { team_id: "tm1" }, away: { team_id: "tm2" },
      scheduled_at: "2026-06-20T09:00:00", venue: "Main Ground",
    },
    {
      ref: "k1", leaf_key: "football.u15", stage: "knockout", group_label: "",
      round_no: 1,
      home: { source: { type: "group_position", group_label: "Football — U15 — Group A", position: 1 } },
      away: { source: { type: "group_position", group_label: "Football — U15 — Group B", position: 2 } },
      scheduled_at: "2026-06-21T10:00:00", venue: "Main Ground",
    },
    {
      ref: "k2", leaf_key: "football.u15", stage: "knockout", group_label: "",
      round_no: 2,
      home: { source: { type: "winner_of", ref: "k1" } },
      away: { source: { type: "winner_of", ref: "k1" } },
      scheduled_at: "2026-06-21T11:00:00", venue: "Main Ground",
    },
  ],
};

const TEAMS = [
  { id: "tm1", name: "Alpha FC", short_name: "A", school: "A", pool: "",
    sport: "football", leaf_key: "football.u15", status: "registered",
    player_count: 7 },
  { id: "tm2", name: "Bravo FC", short_name: "B", school: "B", pool: "",
    sport: "football", leaf_key: "football.u15", status: "registered",
    player_count: 7 },
] as TeamRow[];

const READINESS: FixtureReadiness = {
  global: { checks: [] },
  competitions: [
    { leaf_key: "football.u15", label: "Football · U15", ready: true,
      summary: "5/5", checks: [] },
  ],
};

function mount(initial = "/tournaments/t1/fixtures/preview?leaf=football.u15") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route
              path="/tournaments/:id/fixtures/preview"
              element={<DryRunPreviewPage />}
            />
            <Route
              path="/tournaments/t1/fixtures"
              element={<div data-testid="fixtures-page" />}
            />
            <Route
              path="/tournaments/t1/control"
              element={<div data-testid="control-room-page" />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
    draw_config: { "*": { calendar: CALENDAR } },
    defaults: { format: "round_robin" } as unknown as DrawConfig,
  });
  vi.mocked(tournamentsApi.teams).mockResolvedValue(TEAMS);
  vi.mocked(tournamentsApi.fixtureReadiness).mockResolvedValue(READINESS);
  vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue(PREVIEW);
  vi.mocked(tournamentsApi.previewAllFixtures).mockResolvedValue({
    ...PREVIEW, competitions: 3,
  });
  vi.mocked(tournamentsApi.publishAllFixtures).mockResolvedValue({
    competitions: 3, scheduled: 2, unscheduled: [], warnings: [],
  });
  vi.mocked(tournamentsApi.generateFixtures).mockResolvedValue({ generated: 2 });
  vi.mocked(tournamentsApi.scheduleFixtures).mockResolvedValue({
    scheduled: 2, unscheduled: [], soft_score: 0.91, explanation: [],
  });
  vi.mocked(tournamentsApi.settings).mockResolvedValue({
    rules: {}, constraints: [], rules_frozen_at: null,
    can_edit: true, can_manage: true, can_delete: true,
  } as unknown as TournamentSettings);
  vi.mocked(tournamentsApi.updateSettings).mockResolvedValue(
    {} as unknown as TournamentSettings,
  );
  // Mid-flow by default — publishing returns to the fixtures hub.
  vi.mocked(tournamentsApi.stage).mockResolvedValue({
    stage: "fixtures", status: "registration_open",
    order: ["setup", "fixtures", "ready"], allowed_to: [],
    can_manage: true, modules: [], rules_frozen_at: null, stages: [],
  });
});

describe("DryRunPreviewPage", () => {
  it("runs the pure simulate, leads with the verdict and fills the spreadsheet", async () => {
    mount();
    // the simulate uses the SAME schedule payload Publish will send (§9 A1)
    await waitFor(() =>
      expect(tournamentsApi.previewFixtures).toHaveBeenCalledWith("t1", {
        leaf_key: "football.u15",
        schedule: {
          date_start: "2026-06-20", date_end: "2026-06-21",
          daily_start: "09:00", daily_end: "17:00", slot_minutes: 60,
        },
        include_schedule: true,
      }),
    );
    // plain "Preview" title (no journey stepper here) + the trial-run framing
    expect(screen.getByText("Preview")).toBeInTheDocument();
    expect(
      screen.getByText("This is a trial run. Nothing is saved until you publish."),
    ).toBeInTheDocument();
    // verdict first, in plain words
    expect(await screen.findByTestId("soft-score")).toHaveTextContent(
      "This schedule works. No rules are broken.",
    );
    // The spreadsheet leads: every match is a line, group stage and knockout
    // together, banded by day and court (owner 2026-08-15).
    expect(screen.getByTestId("matches-spreadsheet")).toBeInTheDocument();
    expect(screen.getByTestId("sheet-row-p1")).toHaveTextContent("Alpha FC");
    // Times read in 12-hour clock with am/pm, never 24-hour.
    expect(screen.getByTestId("sheet-row-p1")).toHaveTextContent("9:00 AM");
    expect(screen.getByTestId("sheet-row-p2")).toBeInTheDocument();
    expect(screen.getByTestId("sheet-count")).toHaveTextContent("2 rows");
    expect(
      screen.getByTestId("sheet-band-2026-06-20|Main Ground"),
    ).toBeInTheDocument();
    // The structure lives one click away, on the Draw view.
    await userEvent.click(screen.getByTestId("preview-view-draw"));
    expect(screen.getByTestId("competition-panel")).toBeInTheDocument();
    // The draw reads as a table too: one line per team, group and slot as
    // columns (owner 2026-08-15).
    expect(screen.getByTestId("draw-groups")).toBeInTheDocument();
    expect(
      screen.getByTestId("draw-row-football.u15-Group A-1"),
    ).toHaveTextContent("Alpha FC");
    // nothing persisted by the preview itself
    expect(tournamentsApi.generateFixtures).not.toHaveBeenCalled();
  });

  it("splits a multi-stage competition into Group stage and Knockout tabs", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue(MULTISTAGE_PREVIEW);
    mount();
    await userEvent.click(await screen.findByTestId("preview-view-draw"));

    // Group stage first: the group's teams as rows, knockout out of sight.
    expect(await screen.findByTestId("stage-groups")).toBeInTheDocument();
    expect(
      screen.getByTestId("draw-row-football.u15-Group A-1"),
    ).toHaveTextContent("Alpha FC");
    expect(screen.queryByTestId("preview-bracket")).toBeNull();
    // Knockout tab: the bracket with its placeholder slots.
    await userEvent.click(screen.getByTestId("stage-tab-knockout"));
    expect(screen.getByTestId("preview-bracket")).toBeInTheDocument();
    expect(screen.getAllByText("Group A top 1").length).toBeGreaterThan(0);
    expect(screen.queryByTestId("stage-groups")).toBeNull();
  });

  /** The tournament's own daily break, as the settings endpoint returns it. */
  function withDailyBreak(from: string, to: string): void {
    vi.mocked(tournamentsApi.settings).mockResolvedValue({
      rules: {},
      constraints: [
        {
          type: "recurring_blackout_window", scope: "all", hard: true,
          weight: 5, params: { from, to, days: [], label: "daily_break" },
        },
      ],
      rules_frozen_at: null, can_edit: true, can_manage: true, can_delete: true,
    } as unknown as TournamentSettings);
  }

  it("marks the tournament's own break where the court stands idle for it", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue({
      ...PREVIEW,
      matches: [
        {
          ref: "g1", leaf_key: "football.u15", stage: "group", group_label: "A",
          round_no: 1, home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T09:00:00", venue: "Court 1", duration_minutes: 30,
        },
        {
          ref: "g2", leaf_key: "football.u15", stage: "group", group_label: "A",
          round_no: 2, home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T10:30:00", venue: "Court 1", duration_minutes: 30,
        },
      ],
    });
    withDailyBreak("09:30", "10:30");
    mount();
    // g1 ends 09:30, g2 starts 10:30, and the organiser's break sits in that
    // window -> ONE named line, in 12-hour clock (owner 2026-08-15).
    expect(await screen.findByText("Daily break")).toBeInTheDocument();
    expect(screen.getByText(/9:30 AM to 10:30 AM/)).toBeInTheDocument();
  });

  it("says nothing about a court that is simply idle between matches", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue({
      ...PREVIEW,
      matches: [
        {
          ref: "g1", leaf_key: "football.u15", stage: "group", group_label: "A",
          round_no: 1, home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T09:00:00", venue: "Court 1", duration_minutes: 30,
        },
        {
          ref: "g2", leaf_key: "football.u15", stage: "group", group_label: "A",
          round_no: 2, home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T10:30:00", venue: "Court 1", duration_minutes: 30,
        },
        // A knockout match fills the ENTIRE 09:30-10:30 gap on the same court.
        {
          ref: "k1", leaf_key: "football.u15", stage: "knockout", group_label: "",
          round_no: 1, home: { team_id: "tm3" }, away: { team_id: "tm4" },
          scheduled_at: "2026-06-20T09:30:00", venue: "Court 1", duration_minutes: 60,
        },
      ],
    });
    mount();
    expect(await screen.findByTestId("sheet-row-g1")).toBeInTheDocument();
    // No break was configured, so no break line — whatever the court is doing.
    expect(screen.queryByText(/break/i)).toBeNull();
  });

  it("marks the break only where the court is genuinely free for it", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue({
      ...PREVIEW,
      matches: [
        {
          ref: "g1", leaf_key: "football.u15", stage: "group", group_label: "A",
          round_no: 1, home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T09:00:00", venue: "Court 1", duration_minutes: 30,
        },
        {
          ref: "g2", leaf_key: "football.u15", stage: "group", group_label: "A",
          round_no: 2, home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T11:30:00", venue: "Court 1", duration_minutes: 30,
        },
        // A hidden match uses the court 09:30-10:30 only; 10:30-11:30 is idle.
        {
          ref: "k1", leaf_key: "football.u15", stage: "knockout", group_label: "",
          round_no: 1, home: { team_id: "tm3" }, away: { team_id: "tm4" },
          scheduled_at: "2026-06-20T09:30:00", venue: "Court 1", duration_minutes: 60,
        },
      ],
    });
    // A break covering the WHOLE 09:30-11:30 gap: the court is busy with a
    // hidden match until 10:30, so only the free half earns the line.
    withDailyBreak("10:30", "11:30");
    mount();
    expect(await screen.findByTestId("sheet-row-g1")).toBeInTheDocument();
    expect(screen.getByText("Daily break")).toBeInTheDocument();
    expect(screen.getByText(/10:30 AM to 11:30 AM/)).toBeInTheDocument();
  });

  it("Courts view names when each court is free and what each competition costs", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue({
      ...PREVIEW,
      matches: [
        {
          ref: "g1", leaf_key: "football.u15", stage: "group", group_label: "A",
          round_no: 1, home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T09:00:00", venue: "Court 1", duration_minutes: 30,
        },
        {
          ref: "g2", leaf_key: "football.u15", stage: "group", group_label: "A",
          round_no: 2, home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T11:30:00", venue: "Court 1", duration_minutes: 30,
        },
      ],
    });
    withDailyBreak("10:30", "11:30");
    mount();
    await userEvent.click(await screen.findByTestId("preview-view-courts"));

    // The court's own day, with its timeline and its readings.
    const row = await screen.findByTestId("court-row-2026-06-20|Court 1");
    expect(row).toHaveTextContent("Court 1");
    expect(row).toHaveTextContent("2 matches");
    // Day 09:00-17:00 = 480 min; 60 played, 60 in the configured break.
    expect(screen.getByTestId("court-stat-used")).toHaveTextContent("1h");
    expect(screen.getByTestId("court-stat-breaks")).toHaveTextContent("1h");
    expect(screen.getByTestId("court-stat-free")).toHaveTextContent("6h");
    // The free stretches are spelled out, not left to the picture alone.
    expect(row).toHaveTextContent("9:30 AM to 10:30 AM");

    // The other half of the tab: minutes per competition.
    await userEvent.click(screen.getByTestId("court-tab-time"));
    const load = screen.getByTestId("load-row-football.u15");
    expect(load).toHaveTextContent("1h");
    expect(screen.getByTestId("load-total")).toHaveTextContent("1h");
  });

  it("moves between the sheet, the group stage and the knockout", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue(MULTISTAGE_PREVIEW);
    mount();
    // The sheet leads; the structure is behind the Draw view.
    expect(await screen.findByTestId("sheet-row-g1")).toBeInTheDocument();
    expect(screen.queryByTestId("stage-groups")).toBeNull();
    await userEvent.click(screen.getByTestId("preview-view-draw"));
    expect(screen.getByTestId("stage-groups")).toBeInTheDocument();
    // Knockout tab, then back to the groups.
    await userEvent.click(screen.getByTestId("stage-tab-knockout"));
    expect(screen.getByTestId("preview-bracket")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("stage-tab-groups"));
    expect(screen.getByTestId("stage-groups")).toBeInTheDocument();
    // Back to the spreadsheet.
    await userEvent.click(screen.getByTestId("preview-view-sheet"));
    expect(screen.getByTestId("sheet-row-g1")).toBeInTheDocument();
  });

  it("shows only the bracket for a pure-knockout competition (no empty grid)", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue({
      ...PREVIEW,
      matches: [
        {
          ref: "k1", leaf_key: "football.u15", stage: "knockout", group_label: "",
          round_no: 1, home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T10:00:00", venue: "Court",
        },
      ],
    });
    mount();
    await userEvent.click(await screen.findByTestId("preview-view-draw"));
    // No group stage -> just the bracket; no group table, no message.
    expect(await screen.findByTestId("preview-bracket")).toBeInTheDocument();
    expect(screen.queryByTestId("stage-groups")).toBeNull();
    expect(screen.queryByTestId("preview-knockout-only")).toBeNull();
  });

  it("keeps the draw number and quality behind the closed Advanced details", async () => {
    mount();
    await screen.findByTestId("matches-spreadsheet");
    // closed by default when nothing needs attention
    expect(screen.queryByTestId("preview-seed")).toBeNull();
    expect(screen.queryByTestId("schedule-quality")).toBeNull();
    await userEvent.click(screen.getByTestId("advanced-details-toggle"));
    expect(screen.getByTestId("preview-seed")).toHaveTextContent(
      "Draw number 1234567",
    );
    expect(screen.getByTestId("schedule-quality")).toHaveTextContent("91%");
  });

  it("Publish replays the previewed seed through generate + schedule with the hash guard", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("accept-preview"));

    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        leafKey: "football.u15",
        seed: 1234567,
        expectedInputsHash: "hash-1",
      }),
    );
    await waitFor(() =>
      expect(tournamentsApi.scheduleFixtures).toHaveBeenCalledWith("t1", {
        date_start: "2026-06-20", date_end: "2026-06-21",
        daily_start: "09:00", daily_end: "17:00", slot_minutes: 60,
        leaf_key: "football.u15",
        expected_inputs_hash: "hash-1",
      }),
    );
    // success returns to the hub
    await waitFor(() =>
      expect(screen.getByTestId("fixtures-page")).toBeInTheDocument(),
    );
  });

  it("publish hands off to the control room once the stage is ready", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue({
      stage: "ready", status: "scheduled",
      order: ["setup", "fixtures", "ready"], allowed_to: [],
      can_manage: true, modules: [], rules_frozen_at: null, stages: [],
    });
    mount();
    await userEvent.click(await screen.findByTestId("accept-preview"));

    await waitFor(() =>
      expect(screen.getByTestId("control-room-page")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("fixtures-page")).toBeNull();
  });

  it("409 inputs_changed shows the banner; preview again re-simulates", async () => {
    vi.mocked(tournamentsApi.generateFixtures).mockRejectedValue(
      new ApiError(409, { detail: "inputs_changed", inputs_hash: "hash-2" }),
    );
    mount();
    await userEvent.click(await screen.findByTestId("accept-preview"));

    expect(await screen.findByTestId("inputs-changed-banner")).toBeInTheDocument();
    expect(screen.getByTestId("accept-preview")).toBeDisabled();
    expect(tournamentsApi.scheduleFixtures).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("re-preview"));
    await waitFor(() =>
      expect(tournamentsApi.previewFixtures).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("inputs-changed-banner")).toBeNull(),
    );
    expect(screen.getByTestId("accept-preview")).toBeEnabled();
  });

  it("Try another draw re-rolls; Back without saving leaves without persisting", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("regenerate-preview"));
    await waitFor(() =>
      expect(tournamentsApi.previewFixtures).toHaveBeenCalledTimes(2),
    );
    // A re-roll is a RANDOM re-draw, not the same deterministic order again
    // (owner 2026-08-15): the stored config usually seeds by registration.
    expect(tournamentsApi.previewFixtures).toHaveBeenLastCalledWith(
      "t1",
      expect.objectContaining({ draw: { seeding: "random" } }),
    );
    await userEvent.click(screen.getByTestId("discard-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("fixtures-page")).toBeInTheDocument(),
    );
    expect(tournamentsApi.generateFixtures).not.toHaveBeenCalled();
    expect(tournamentsApi.scheduleFixtures).not.toHaveBeenCalled();
  });

  it("a hard violation blocks publishing and offers the one-click preference fix", async () => {
    const record = {
      type: "category_session_window", scope: "leaf:football.u15",
      hard: true, weight: 5, params: {},
    };
    vi.mocked(tournamentsApi.settings).mockResolvedValue({
      rules: {}, constraints: [record], rules_frozen_at: null,
      can_edit: true, can_manage: true, can_delete: true,
    } as unknown as TournamentSettings);
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue({
      ...PREVIEW,
      unscheduled: ["p2"],
      violations: [
        {
          code: "session_window_starved", hard: true, constraint: record,
          matches: ["p2"], params: { scope: record.scope },
          message: "A hard session window leaves no feasible slot.",
          relaxations: [
            { action: "demote_to_soft", code: "demote_to_soft", params: {} },
          ],
        },
      ],
    });
    mount();

    // plain verdict + the failure link back to the rules
    expect(await screen.findByTestId("soft-score")).toHaveTextContent(
      "1 problem to fix before you publish.",
    );
    expect(screen.getByTestId("fix-rules-link")).toBeInTheDocument();
    expect(
      screen.getByTestId("violation-session_window_starved"),
    ).toHaveTextContent('A "must" time rule leaves these matches no room.');
    // publishing a known-broken schedule is not the easy path
    expect(screen.getByTestId("accept-preview")).toBeDisabled();
    expect(screen.getByTestId("accept-preview")).toHaveAttribute(
      "title",
      "Fix the problems above first.",
    );
    // Advanced details stays closed (owner 2026-07-13) — the verdict panel
    // above already carries the problem loudly.
    expect(screen.getByTestId("advanced-details-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // The unplaced match is reported ONCE, inside the problem that caused it
    // (owner 2026-08-15) — no second panel repeating the same trouble.
    expect(screen.queryByTestId("unscheduled-summary")).toBeNull();
    expect(
      screen.getByTestId("violation-session_window_starved"),
    ).toHaveTextContent("1 matches");
    expect(screen.getByTestId("show-unplaced")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("relax-demote_to_soft"));
    await waitFor(() =>
      expect(tournamentsApi.updateSettings).toHaveBeenCalledWith("t1", {
        constraints: [{ ...record, hard: false }],
        event_id: expect.any(String),
      }),
    );
    expect(
      await screen.findByText(
        "Done. That rule is now a preference, and the preview re-ran.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(tournamentsApi.previewFixtures).toHaveBeenCalledTimes(2),
    );
  });

  it("fairness flags render plain explanations inside Advanced details", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue({
      ...PREVIEW,
      fairness: {
        days_used: 2,
        teams: [
          { team_id: "tm1", name: "Alpha FC", rest_min: 30, rest_median: 45,
            early: 3, late: 0, venues: 2, max_per_day: 2 },
          { team_id: "tm2", name: "Bravo FC", rest_min: 180, rest_median: 200,
            early: 1, late: 1, venues: 1, max_per_day: 1 },
        ],
        flags: [
          { code: "rest_below_min", team_id: "tm1", value: 30, median: 180 },
          { code: "early_outlier", team_id: "tm1", value: 3, median: 1 },
        ],
      },
    });
    mount();

    // Closed by default even when flagged; opening reveals the panel.
    await screen.findByTestId("matches-spreadsheet");
    expect(screen.queryByTestId("fairness-panel")).toBeNull();
    await userEvent.click(screen.getByTestId("advanced-details-toggle"));
    const panel = await screen.findByTestId("fairness-panel");
    expect(panel).toBeInTheDocument();
    expect(screen.getByTestId("fairness-row-tm1")).toHaveTextContent("Alpha FC");
    expect(screen.getByTestId("fairness-row-tm1")).toHaveTextContent("30m");
    expect(screen.getByTestId("fairness-row-tm2")).toHaveTextContent("3h");
    expect(screen.getByTestId("fairness-flag-rest_below_min")).toHaveTextContent(
      "Alpha FC gets less rest than your minimum",
    );
    expect(screen.getByTestId("fairness-flag-early_outlier")).toHaveTextContent(
      "starts the day far more often than most teams",
    );
    expect(screen.queryByTestId("fairness-toggle")).toBeNull();
  });

  it("collapses a long, unflagged fairness table behind Advanced details + Show all", async () => {
    const teams = Array.from({ length: 10 }, (_, i) => ({
      team_id: `tm${i + 1}`, name: `Team ${i + 1}`, rest_min: 60,
      rest_median: 90, early: 1, late: 1, venues: 1, max_per_day: 1,
    }));
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue({
      ...PREVIEW,
      fairness: { days_used: 2, teams, flags: [] },
    });
    mount();

    await screen.findByTestId("matches-spreadsheet");
    expect(screen.queryByTestId("fairness-panel")).toBeNull();
    await userEvent.click(screen.getByTestId("advanced-details-toggle"));
    expect(screen.getAllByTestId(/^fairness-row-/)).toHaveLength(8);
    await userEvent.click(screen.getByTestId("fairness-toggle"));
    expect(screen.getAllByTestId(/^fairness-row-/)).toHaveLength(10);
  });

  it("omits the fairness panel when the preview carries no per-team data", async () => {
    mount();
    await screen.findByTestId("matches-spreadsheet");
    await userEvent.click(screen.getByTestId("advanced-details-toggle"));
    expect(screen.queryByTestId("fairness-panel")).toBeNull();
    expect(screen.getByTestId("preview-seed")).toBeInTheDocument();
  });

  it("asks for Step 1 when no calendar exists yet", async () => {
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {},
      defaults: { format: "round_robin" } as unknown as DrawConfig,
    });
    mount();
    expect(await screen.findByText("Step 1 is not finished")).toBeInTheDocument();
    expect(
      screen.getByText("The preview needs your tournament dates. Set them in Step 1 first."),
    ).toBeInTheDocument();
    expect(tournamentsApi.previewFixtures).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Open Step 1" }));
    await waitFor(() =>
      expect(screen.getByTestId("fixtures-page")).toBeInTheDocument(),
    );
  });

  it("publishes a re-rolled draw as the random draw it previewed", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("regenerate-preview"));
    await waitFor(() =>
      expect(tournamentsApi.previewFixtures).toHaveBeenCalledTimes(2),
    );
    await userEvent.click(screen.getByTestId("accept-preview"));
    // Seed alone is ignored by a registration-seeded config — the seeding
    // method has to travel with it or publish would commit another draw.
    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        leafKey: "football.u15",
        seeding: "random",
        seed: 1234567,
        expectedInputsHash: "hash-1",
      }),
    );
  });

  it("all-mode publishes the re-rolled draw with the same override", async () => {
    mount("/tournaments/t1/fixtures/preview?all=1");
    await userEvent.click(await screen.findByTestId("regenerate-preview"));
    await waitFor(() =>
      expect(tournamentsApi.previewAllFixtures).toHaveBeenCalledTimes(2),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Publish all competitions" }),
    );
    await waitFor(() =>
      expect(tournamentsApi.publishAllFixtures).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ draw: { seeding: "random" } }),
      ),
    );
  });

  it("publishing toasts in plain words", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("accept-preview"));
    expect(
      await screen.findByText("Published. 2 matches are on the schedule."),
    ).toBeInTheDocument();
  });

  it("all-mode shows knockout-only competitions in the combined sheet", async () => {
    vi.mocked(tournamentsApi.previewAllFixtures).mockResolvedValue({
      ...PREVIEW,
      competitions: 2,
      matches: [
        ...PREVIEW.matches,
        {
          ref: "k9", leaf_key: "tt.u19", stage: "knockout",
          group_label: "TT · u19", round_no: 1,
          home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T11:00:00", venue: "Hall",
        },
      ],
    });
    mount("/tournaments/t1/fixtures/preview?all=1");
    // Two competitions -> the combined sheet, with the knockout match VISIBLE
    // as its own line (a knockout-only sport must not read as empty).
    expect(await screen.findByTestId("sheet-row-k9")).toBeInTheDocument();
    expect(screen.getByTestId("sheet-row-p1")).toBeInTheDocument();
    expect(screen.queryByTestId("competition-panel")).toBeNull();
  });

  it("all-mode Draw view renders the proper bracket per knockout competition", async () => {
    vi.mocked(tournamentsApi.previewAllFixtures).mockResolvedValue({
      ...PREVIEW,
      competitions: 2,
      matches: [
        ...PREVIEW.matches,
        {
          ref: "k9", leaf_key: "tt.u19", stage: "knockout",
          group_label: "TT · u19", round_no: 1,
          home: { team_id: "tm1" }, away: { team_id: "tm2" },
          scheduled_at: "2026-06-20T11:00:00", venue: "Hall",
        },
      ],
    });
    mount("/tournaments/t1/fixtures/preview?all=1");
    await userEvent.click(await screen.findByTestId("preview-view-draw"));
    expect(screen.getByTestId("draw-brackets")).toBeInTheDocument();
    expect(screen.getByTestId("preview-bracket-tt.u19")).toBeInTheDocument();
    expect(
      screen.getByTestId("preview-bracket-football.u15"),
    ).toBeInTheDocument();
  });

  it("all-mode previews every competition together and publishes them in one call", async () => {
    mount("/tournaments/t1/fixtures/preview?all=1");
    // the combined endpoint runs, NOT the per-leaf preview
    await waitFor(() =>
      expect(tournamentsApi.previewAllFixtures).toHaveBeenCalled(),
    );
    expect(tournamentsApi.previewFixtures).not.toHaveBeenCalled();
    expect(screen.getByText("All competitions")).toBeInTheDocument();

    // Publish = ONE atomic publish-all, not per-leaf generate + schedule
    await userEvent.click(
      await screen.findByRole("button", { name: "Publish all competitions" }),
    );
    await waitFor(() =>
      expect(tournamentsApi.publishAllFixtures).toHaveBeenCalledWith("t1", {
        schedule: expect.anything(),
      }),
    );
    expect(tournamentsApi.generateFixtures).not.toHaveBeenCalled();
    expect(tournamentsApi.scheduleFixtures).not.toHaveBeenCalled();
  });

  const sheetRefs = (): (string | null)[] =>
    screen
      .getAllByTestId(/^sheet-row-/)
      .map((el) => el.getAttribute("data-testid"));

  it("sorts the sheet by a column, both ways, then back to play order", async () => {
    mount();
    await screen.findByTestId("matches-spreadsheet");
    // Play order first: p1 (day 1) before p2 (day 2).
    expect(sheetRefs()).toEqual(["sheet-row-p1", "sheet-row-p2"]);
    // Away ascending: "Bravo FC" before "Winner of p1".
    await userEvent.click(screen.getByTestId("sheet-sort-away"));
    expect(screen.getByTestId("sheet-sort-away").closest("th")).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(sheetRefs()).toEqual(["sheet-row-p1", "sheet-row-p2"]);
    await userEvent.click(screen.getByTestId("sheet-sort-away"));
    expect(sheetRefs()).toEqual(["sheet-row-p2", "sheet-row-p1"]);
    // A third click drops the sort.
    await userEvent.click(screen.getByTestId("sheet-sort-away"));
    expect(screen.getByTestId("sheet-sort-away").closest("th")).toHaveAttribute(
      "aria-sort",
      "none",
    );
    expect(sheetRefs()).toEqual(["sheet-row-p1", "sheet-row-p2"]);
  });

  it("searches the sheet and clears the filter again", async () => {
    mount();
    await screen.findByTestId("matches-spreadsheet");
    await userEvent.type(screen.getByTestId("filter-search"), "bravo");
    expect(sheetRefs()).toEqual(["sheet-row-p1"]);
    expect(screen.getByTestId("sheet-count")).toHaveTextContent("1 of 2 rows");
    expect(screen.getByTestId("chip-filter-q")).toHaveTextContent("bravo");

    await userEvent.click(screen.getByTestId("clear-filters"));
    expect(sheetRefs()).toEqual(["sheet-row-p1", "sheet-row-p2"]);
  });

  it("filters the sheet down to the matches with no time", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue({
      ...PREVIEW,
      unscheduled: ["p2"],
    });
    mount();
    await userEvent.click(await screen.findByTestId("show-unplaced"));
    expect(sheetRefs()).toEqual(["sheet-row-p2"]);
    expect(screen.getByTestId("sheet-row-p2")).toHaveAttribute(
      "data-unplaced",
      "true",
    );
    expect(screen.getByTestId("chip-filter-status")).toHaveTextContent(
      "No time yet",
    );
  });
});
