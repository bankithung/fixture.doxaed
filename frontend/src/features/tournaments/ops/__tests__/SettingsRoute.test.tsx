import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";
import { disputesApi } from "@/api/disputes";
import { SettingsRoute } from "../SettingsRoute";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      stage: vi.fn(),
      get: vi.fn(),
      settings: vi.fn(),
    },
  };
});
vi.mock("@/api/disputes", () => ({
  disputesApi: { list: vi.fn() },
}));

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/settings"]}>
          <Routes>
            <Route path="/tournaments/:id/settings" element={<SettingsRoute />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const TOUR = {
  id: "t1",
  name: "Cup",
  slug: "cup",
  status: "scheduled",
  time_zone: "Asia/Kolkata",
};

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(tournamentsApi.get).mockResolvedValue(TOUR as any);
  vi.mocked(disputesApi.list).mockResolvedValue([]);
});

describe("SettingsRoute", () => {
  it("at ready, renders the operations Settings (not the rules editor)", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { stage: "ready", can_manage: true, can_delete: false } as any,
    );
    mount();
    // Operations markers.
    expect(await screen.findByText("Public pages")).toBeInTheDocument();
    expect(screen.getByText("Setup & configuration")).toBeInTheDocument();
    // The setup-era rules editor is NOT here.
    expect(screen.queryByText("Match format")).toBeNull();
  });

  it("before ready, renders the simplified settings page", async () => {
    vi.mocked(tournamentsApi.stage).mockResolvedValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { stage: "org_registration", can_manage: true, can_delete: false } as any,
    );
    vi.mocked(tournamentsApi.settings).mockResolvedValue({
      rules: {
        points: { win: 3, draw: 1, loss: 0 },
        match: { halves: 2, half_minutes: 45, extra_time: false, penalties: false },
        squad: { min_players: 7, max_players: 18, max_subs: 5 },
        tiebreakers: [],
      },
      can_edit: true,
      can_delete: false,
      rules_frozen_at: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    mount();
    // The slimmed settings page: rename + audit + danger zone only (owner
    // 2026-07-05); the old rules editor is gone from here.
    expect(await screen.findByText("Tournament name")).toBeInTheDocument();
    expect(screen.getByText("Audit log")).toBeInTheDocument();
    expect(screen.queryByText("Match format")).toBeNull();
  });
});
