import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsTab } from "../SettingsTab";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type Tournament,
  type TournamentSettings,
} from "@/api/tournaments";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      settings: vi.fn(),
      get: vi.fn(),
      setActive: vi.fn(),
      remove: vi.fn(),
      updateSettings: vi.fn(),
    },
  };
});
// The disputes panel makes its own data calls — stub it out for this test.
vi.mock("@/features/disputes/DisputesPanel", () => ({ DisputesPanel: () => null }));

const SETTINGS = {
  rules: {
    points: { win: 3, draw: 1, loss: 0 },
    match: { halves: 2, half_minutes: 45, extra_time: false, penalties: false },
    squad: { min_players: 7, max_players: 18, max_subs: 5 },
    tiebreakers: [],
  },
  constraints: [],
  modules: [],
  rules_frozen_at: null,
  can_edit: false,
  can_manage: true,
  can_delete: true,
};

function tournament(status: string): Tournament {
  return {
    id: "t1",
    slug: "cup",
    name: "Cup",
    status,
    organization_slug: "ws",
    sport_code: null,
    sports: [],
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
            <Route path="/tournaments" element={<div>tournaments-hub</div>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(tournamentsApi.settings).mockResolvedValue(
    SETTINGS as unknown as TournamentSettings,
  );
});
afterEach(() => vi.restoreAllMocks());

describe("SettingsTab danger zone", () => {
  it("deactivates an active tournament", async () => {
    vi.mocked(tournamentsApi.get).mockResolvedValue(tournament("published"));
    vi.mocked(tournamentsApi.setActive).mockResolvedValue(tournament("archived"));

    renderTab();

    const btn = await screen.findByTestId("toggle-active");
    expect(btn).toHaveTextContent(/deactivate/i);
    await userEvent.click(btn);
    await waitFor(() =>
      expect(tournamentsApi.setActive).toHaveBeenCalledWith("t1", false),
    );
  });

  it("shows Reactivate for an archived tournament", async () => {
    vi.mocked(tournamentsApi.get).mockResolvedValue(tournament("archived"));
    renderTab();
    expect(await screen.findByTestId("toggle-active")).toHaveTextContent(
      /reactivate/i,
    );
  });

  it("deletes after confirming", async () => {
    vi.mocked(tournamentsApi.get).mockResolvedValue(tournament("draft"));
    vi.mocked(tournamentsApi.remove).mockResolvedValue(undefined);

    renderTab();

    await userEvent.click(await screen.findByTestId("delete-tournament"));
    const dialog = await screen.findByRole("dialog", {
      name: /delete tournament/i,
    });
    await userEvent.click(
      within(dialog).getByTestId("confirm-delete-tournament"),
    );
    await waitFor(() => expect(tournamentsApi.remove).toHaveBeenCalledWith("t1"));
  });

  it("hides the danger zone for non-managers", async () => {
    vi.mocked(tournamentsApi.get).mockResolvedValue(tournament("published"));
    vi.mocked(tournamentsApi.settings).mockResolvedValue({
      ...SETTINGS,
      can_manage: false,
      can_delete: false,
    } as unknown as TournamentSettings);

    renderTab();

    await screen.findByText(/scoring rules/i);
    expect(screen.queryByTestId("delete-tournament")).toBeNull();
  });

  it("hides the danger zone for INVITED managers (organizer-only)", async () => {
    // An invited tournament-admin manages day-to-day (can_manage) but only
    // the organizer may delete/deactivate (owner decision 2026-06-11).
    vi.mocked(tournamentsApi.get).mockResolvedValue(tournament("published"));
    vi.mocked(tournamentsApi.settings).mockResolvedValue({
      ...SETTINGS,
      can_manage: true,
      can_delete: false,
    } as unknown as TournamentSettings);

    renderTab();

    await screen.findByText(/scoring rules/i);
    expect(screen.queryByTestId("delete-tournament")).toBeNull();
    expect(screen.queryByTestId("toggle-active")).toBeNull();
  });
});
