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
  it("runs the pure simulate, leads with the verdict and renders the day grid", async () => {
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
    // step 4 journey header (Preview & publish) + the trial-run framing
    expect(screen.getByText("Step 4 · Preview & publish")).toBeInTheDocument();
    expect(
      screen.getByText("This is a trial run. Nothing is saved until you publish."),
    ).toBeInTheDocument();
    // verdict first, in plain words
    expect(await screen.findByTestId("soft-score")).toHaveTextContent(
      "This schedule works. No rules are broken.",
    );
    expect(screen.getByTestId("day-2026-06-20")).toBeInTheDocument();
    expect(screen.getByTestId("day-2026-06-21")).toBeInTheDocument();
    expect(screen.getByTestId("chip-p1")).toHaveTextContent("Alpha FC");
    expect(screen.getByTestId("chip-p2")).toHaveTextContent("Winner of p1");
    // nothing persisted by the preview itself
    expect(tournamentsApi.generateFixtures).not.toHaveBeenCalled();
  });

  it("times the placeholder knockout in the day grid; bracket + groups live in the Draw tab (Gap 5c)", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue(MULTISTAGE_PREVIEW);
    mount();

    // Default day view: the knockout is timed with a clean placeholder label.
    const k1 = await screen.findByTestId("chip-k1");
    expect(k1).toHaveTextContent("Group A top 1");
    expect(k1).not.toHaveTextContent("Football"); // never the raw em-dash label
    expect(k1).toHaveTextContent("10:00");
    expect(screen.getByTestId("day-2026-06-21")).toBeInTheDocument();
    // The bracket is NOT in the schedule views.
    expect(screen.queryByTestId("preview-bracket")).toBeNull();

    // Draw tab: the full bracket tree + the numbered group composition.
    await userEvent.click(screen.getByTestId("preview-view-draw"));
    expect(screen.getByTestId("preview-bracket")).toBeInTheDocument();
    expect(screen.getByTestId("preview-bracket-football.u15")).toBeInTheDocument();
    expect(screen.getByTestId("draw-groups")).toBeInTheDocument();
    expect(screen.getAllByText("Group A top 1").length).toBeGreaterThan(0);
  });

  it("switches the schedule between By day and By group (owner ask)", async () => {
    vi.mocked(tournamentsApi.previewFixtures).mockResolvedValue(MULTISTAGE_PREVIEW);
    mount();
    // Default view is by day.
    expect(await screen.findByTestId("day-2026-06-21")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("preview-view-group"));
    // By group: a "Group A" bucket and a "Knockout" bucket, no day bands.
    expect(screen.getByTestId("group-football.u15::Group A")).toBeInTheDocument();
    expect(screen.getByTestId("group-football.u15::__ko__")).toBeInTheDocument();
    expect(screen.queryByTestId("day-2026-06-21")).toBeNull();
    // The knockout bucket still shows the placeholder Stage 2 flow.
    expect(screen.getAllByText("Group A top 1").length).toBeGreaterThan(0);
    // Back to by day.
    await userEvent.click(screen.getByTestId("preview-view-day"));
    expect(screen.getByTestId("day-2026-06-21")).toBeInTheDocument();
  });

  it("keeps the draw number and quality behind the closed Advanced details", async () => {
    mount();
    await screen.findByTestId("day-2026-06-20");
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
    await userEvent.click(screen.getByTestId("discard-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("fixtures-page")).toBeInTheDocument(),
    );
    expect(tournamentsApi.generateFixtures).not.toHaveBeenCalled();
    expect(tournamentsApi.scheduleFixtures).not.toHaveBeenCalled();
  });

  it("a hard violation blocks publishing, forces the details open and offers the one-click preference fix", async () => {
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
      "1 problem(s) need fixing before you publish.",
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
    // problems force the Advanced details open
    expect(screen.getByTestId("advanced-details-toggle")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // unscheduled matches explained in plain words
    expect(screen.getByText("1 match(es) have no time yet")).toBeInTheDocument();
    expect(
      screen.getByText("Add another day or venue in Step 1, then preview again."),
    ).toBeInTheDocument();

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

  it("fairness flags force the details open and render the plain explanations", async () => {
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

    // flagged → no click needed, the panel is already visible
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

    await screen.findByTestId("day-2026-06-20");
    expect(screen.queryByTestId("fairness-panel")).toBeNull();
    await userEvent.click(screen.getByTestId("advanced-details-toggle"));
    expect(screen.getAllByTestId(/^fairness-row-/)).toHaveLength(8);
    await userEvent.click(screen.getByTestId("fairness-toggle"));
    expect(screen.getAllByTestId(/^fairness-row-/)).toHaveLength(10);
  });

  it("omits the fairness panel when the preview carries no per-team data", async () => {
    mount();
    await screen.findByTestId("day-2026-06-20");
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

  it("publishing toasts in plain words", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("accept-preview"));
    expect(
      await screen.findByText("Published. 2 matches are on the schedule."),
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
});
