import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsTab } from "../SettingsTab";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError } from "@/types/api";
import {
  tournamentsApi,
  type Tournament,
  type TournamentSettings,
} from "@/api/tournaments";

/**
 * How players are entered (spec 2026-08-17) — a FUNNEL choice, so it stays
 * editable here rather than being frozen at creation. The server locks it once
 * teams exist; this screen has to say so in words an organizer can act on.
 */

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      settings: vi.fn(),
      get: vi.fn(),
      stage: vi.fn(),
      setRosterMode: vi.fn(),
    },
  };
});
vi.mock("@/features/disputes/DisputesPanel", () => ({ DisputesPanel: () => null }));

function tournament(roster_mode: "inline" | "roster_first"): Tournament {
  return {
    id: "t1",
    slug: "cup",
    name: "Cup",
    status: "draft",
    organization_slug: "ws",
    sport_code: null,
    sports: [],
    roster_mode,
    time_zone: "Asia/Kolkata",
    created_at: "2026-05-01T00:00:00Z",
  };
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/settings"]}>
          <Routes>
            <Route path="/tournaments/:id/settings" element={<SettingsTab />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tournamentsApi.settings).mockResolvedValue({
    can_edit: false,
    can_manage: true,
    can_delete: false,
  } as unknown as TournamentSettings);
  vi.mocked(tournamentsApi.stage).mockResolvedValue({
    can_manage: true,
  } as never);
  vi.mocked(tournamentsApi.get).mockResolvedValue(tournament("inline"));
});

describe("SettingsTab — how players are entered", () => {
  it("shows which mode is on", async () => {
    renderTab();
    expect(await screen.findByTestId("roster-mode-inline")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("roster-mode-roster_first")).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("switches to participants-first", async () => {
    vi.mocked(tournamentsApi.setRosterMode).mockResolvedValue(
      tournament("roster_first"),
    );
    renderTab();

    await userEvent.click(await screen.findByTestId("roster-mode-roster_first"));
    await waitFor(() =>
      expect(tournamentsApi.setRosterMode).toHaveBeenCalledWith(
        "t1",
        "roster_first",
      ),
    );
  });

  it("says what the switch carried across, not just 'Saved'", async () => {
    // Owner 2026-08-18: switching on a tournament that already has teams
    // MIGRATES. The organizer has to be told their squads survived.
    vi.mocked(tournamentsApi.setRosterMode).mockResolvedValue({
      ...tournament("roster_first"),
      roster_switch: {
        mode: "roster_first",
        changed: true,
        seeded: 12,
        team_form_id: "f1",
        team_form_kept: false,
      },
    });
    renderTab();

    await userEvent.click(await screen.findByTestId("roster-mode-roster_first"));
    expect(
      await screen.findByText(/12 players already registered were added/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/team form now picks from that list/i),
    ).toBeInTheDocument();
  });

  it("flags a hand-built team form it refused to overwrite", async () => {
    vi.mocked(tournamentsApi.setRosterMode).mockResolvedValue({
      ...tournament("roster_first"),
      roster_switch: {
        mode: "roster_first",
        changed: true,
        seeded: 0,
        team_form_id: null,
        team_form_kept: true,
      },
    });
    renderTab();

    await userEvent.click(await screen.findByTestId("roster-mode-roster_first"));
    expect(
      await screen.findByText(/hand-built team form was left untouched/i),
    ).toBeInTheDocument();
  });

  it("explains the one remaining refusal in words, not a code", async () => {
    vi.mocked(tournamentsApi.setRosterMode).mockRejectedValue(
      new ApiError(400, { detail: "leave_the_participants_stage_first" }),
    );
    renderTab();

    await userEvent.click(await screen.findByTestId("roster-mode-inline"));
    expect(
      await screen.findByText(/move off the participants step first/i),
    ).toBeInTheDocument();
  });

  it("hides the choice from a member who cannot manage", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue({
      can_manage: false,
    } as never);
    renderTab();

    await screen.findByText(/audit log/i);
    expect(screen.queryByTestId("roster-mode-inline")).toBeNull();
  });
});
