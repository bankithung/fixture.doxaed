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
      generateFixtures: vi.fn(),
      scheduleFixtures: vi.fn(),
      settings: vi.fn(),
      updateSettings: vi.fn(),
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
});

describe("DryRunPreviewPage", () => {
  it("runs the pure simulate and renders the matches-by-day grid + quality", async () => {
    mount();
    // the simulate uses the SAME schedule payload Accept will send (§9 A1)
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
    expect(await screen.findByTestId("day-2026-06-20")).toBeInTheDocument();
    expect(screen.getByTestId("day-2026-06-21")).toBeInTheDocument();
    expect(screen.getByTestId("chip-p1")).toHaveTextContent("Alpha FC");
    expect(screen.getByTestId("chip-p2")).toHaveTextContent("Winner of p1");
    expect(screen.getByTestId("soft-score")).toHaveTextContent("91%");
    expect(screen.getByTestId("preview-seed")).toHaveTextContent("1234567");
    // nothing persisted by the preview itself
    expect(tournamentsApi.generateFixtures).not.toHaveBeenCalled();
  });

  it("Accept replays the previewed seed through generate + schedule with the hash guard", async () => {
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

  it("409 inputs_changed shows the InputsChangedBanner; re-preview re-simulates", async () => {
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

  it("Regenerate re-rolls the simulate; Discard leaves without persisting", async () => {
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

  it("demote_to_soft relaxation patches the record soft and re-previews", async () => {
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

    expect(
      await screen.findByTestId("violation-session_window_starved"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("relax-demote_to_soft"));

    await waitFor(() =>
      expect(tournamentsApi.updateSettings).toHaveBeenCalledWith("t1", {
        constraints: [{ ...record, hard: false }],
        event_id: expect.any(String),
      }),
    );
    await waitFor(() =>
      expect(tournamentsApi.previewFixtures).toHaveBeenCalledTimes(2),
    );
  });

  it("asks for the global setup when no calendar exists yet", async () => {
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {},
      defaults: { format: "round_robin" } as unknown as DrawConfig,
    });
    mount();
    expect(await screen.findByText("Calendar not set")).toBeInTheDocument();
    expect(tournamentsApi.previewFixtures).not.toHaveBeenCalled();
  });
});
