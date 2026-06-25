import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type DrawConfigResponse,
  type TournamentSettings,
} from "@/api/tournaments";
import { ScheduleWizard } from "../ScheduleWizard";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      drawConfig: vi.fn(),
      venues: vi.fn(),
      settings: vi.fn(),
      scheduleFixtures: vi.fn(),
    },
  };
});

const DRAW = {
  draw_config: {
    "*": {
      calendar: {
        date_start: "2026-08-01",
        date_end: "2026-08-02",
        daily_start: "09:00",
        daily_end: "18:00",
        slot_minutes: 60,
      },
    },
  },
  defaults: {},
} as unknown as DrawConfigResponse;

function settings(scheduling_config: Record<string, unknown> | null): TournamentSettings {
  return {
    rules: {},
    constraints: [],
    rules_frozen_at: null,
    can_edit: true,
    can_manage: true,
    can_delete: true,
    scheduling_config,
  } as unknown as TournamentSettings;
}

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.drawConfig).mockResolvedValue(DRAW);
  vi.mocked(tournamentsApi.venues).mockResolvedValue({
    venues: [{ name: "Court 1" }],
  } as unknown as Awaited<ReturnType<typeof tournamentsApi.venues>>);
  vi.mocked(tournamentsApi.scheduleFixtures).mockResolvedValue({
    scheduled: 4,
    unscheduled: [],
    soft_score: 1,
    explanation: [],
  });
});

describe("ScheduleWizard · auto-reflow", () => {
  it("runs with auto_reflow:true after the operator opts in", async () => {
    vi.mocked(tournamentsApi.settings).mockResolvedValue(settings({}));
    const user = userEvent.setup();
    wrap(<ScheduleWizard tournamentId="t1" open onClose={() => {}} />);

    // Expand the override disclosure, then flip the toggle on.
    await screen.findByTestId("adjust-before-running");
    await user.click(screen.getByTestId("adjust-before-running"));
    const toggle = await screen.findByTestId("auto-reflow-toggle");
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    await user.click(screen.getByTestId("rerun-schedule-submit"));
    await waitFor(() =>
      expect(tournamentsApi.scheduleFixtures).toHaveBeenCalled(),
    );
    const body = vi.mocked(tournamentsApi.scheduleFixtures).mock.calls[0][1];
    expect(body.auto_reflow).toBe(true);
  });

  it("pre-seeds the toggle from a stored scheduling_config", async () => {
    vi.mocked(tournamentsApi.settings).mockResolvedValue(
      settings({ auto_reflow: true }),
    );
    wrap(<ScheduleWizard tournamentId="t1" open onClose={() => {}} />);

    await screen.findByTestId("adjust-before-running");
    fireEvent.click(screen.getByTestId("adjust-before-running"));
    const toggle = await screen.findByTestId("auto-reflow-toggle");
    expect(toggle).toBeChecked();
  });
});
