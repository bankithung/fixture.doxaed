import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type TournamentSettings } from "@/api/tournaments";
import { ClashesSection } from "../ClashesSection";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      settings: vi.fn(),
      updateSettings: vi.fn(),
    },
  };
});

const COMPS = [
  { leafKey: "sepaktakraw.u14", label: "Sepaktakraw U-14" },
  { leafKey: "table_tennis.u14", label: "Table Tennis U-14" },
];

function settings(constraints: unknown[] = []): TournamentSettings {
  return {
    rules: {},
    constraints,
    rules_frozen_at: null,
    can_edit: true,
    can_manage: true,
    can_delete: true,
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

const mount = (comps = COMPS) =>
  wrap(<ClashesSection tournamentId="t1" competitions={comps} />);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.settings).mockResolvedValue(settings());
  vi.mocked(tournamentsApi.updateSettings).mockResolvedValue(settings());
});

describe("ClashesSection", () => {
  it("prompts to add a competition when there is only one", async () => {
    mount([COMPS[0]]);
    expect(
      await screen.findByText(/add a second competition/i),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("add-clash-rule")).toBeNull();
  });

  it("adds a clash rule with both competitions pre-selected and saves the members", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("add-clash-rule"));
    // a two-competition tournament pre-selects both — that's the whole point
    expect(
      screen.getByTestId("clash-0-member-sepaktakraw.u14"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByTestId("clash-0-member-table_tennis.u14"),
    ).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByTestId("save-clashes"));
    await waitFor(() =>
      expect(tournamentsApi.updateSettings).toHaveBeenCalled(),
    );
    const body = vi.mocked(tournamentsApi.updateSettings).mock.calls[0][1];
    expect(body.event_id).toEqual(expect.any(String));
    expect(body.constraints).toEqual([
      {
        type: "no_concurrent_competitions",
        scope: "all",
        hard: true,
        weight: 5,
        params: {
          members: ["sepaktakraw.u14", "table_tennis.u14"],
          gap_minutes: 0,
        },
      },
    ]);
  });

  it("drops a half-built clash rule (fewer than two competitions) on save", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("add-clash-rule"));
    // toggle one off → only one member left → not a real clash
    await userEvent.click(screen.getByTestId("clash-0-member-table_tennis.u14"));
    await userEvent.click(screen.getByTestId("save-clashes"));
    await waitFor(() =>
      expect(tournamentsApi.updateSettings).toHaveBeenCalled(),
    );
    const body = vi.mocked(tournamentsApi.updateSettings).mock.calls[0][1];
    expect(body.constraints).toEqual([]);
  });

  it("gives a competition its own session window and preserves other rules", async () => {
    vi.mocked(tournamentsApi.settings).mockResolvedValue(
      settings([
        {
          type: "recurring_blackout_window",
          scope: "all",
          hard: true,
          weight: 5,
          params: { days: ["sun"], from: "00:00", to: "13:00" },
        },
      ]),
    );
    mount();
    await userEvent.click(
      await screen.findByTestId("session-sepaktakraw.u14-toggle"),
    );
    // the window inputs appear
    expect(
      screen.getByTestId("session-sepaktakraw.u14-from"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("save-clashes"));
    await waitFor(() =>
      expect(tournamentsApi.updateSettings).toHaveBeenCalled(),
    );
    const body = vi.mocked(tournamentsApi.updateSettings).mock.calls[0][1];
    expect(body.constraints).toEqual([
      // the unrelated rule is preserved verbatim
      {
        type: "recurring_blackout_window",
        scope: "all",
        hard: true,
        weight: 5,
        params: { days: ["sun"], from: "00:00", to: "13:00" },
      },
      {
        type: "category_session_window",
        scope: "leaf:sepaktakraw.u14",
        hard: true,
        weight: 5,
        params: { days: null, from: "09:00", to: "12:00" },
      },
    ]);
  });

  it("keeps Save disabled until something changes", async () => {
    mount();
    expect(await screen.findByTestId("save-clashes")).toBeDisabled();
  });
});
