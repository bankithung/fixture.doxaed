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

  it("explains the lock in words, not a code", async () => {
    vi.mocked(tournamentsApi.setRosterMode).mockRejectedValue(
      new ApiError(409, { detail: "roster_mode_locked" }),
    );
    renderTab();

    await userEvent.click(await screen.findByTestId("roster-mode-roster_first"));
    expect(
      await screen.findByText(/teams are already registered/i),
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
