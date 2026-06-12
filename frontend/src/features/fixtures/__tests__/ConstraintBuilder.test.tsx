import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type ConstraintType,
  type DrawConfig,
  type TournamentSettings,
} from "@/api/tournaments";
import { ConstraintBuilder } from "../ConstraintBuilder";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      settings: vi.fn(),
      updateSettings: vi.fn(),
      constraintTypes: vi.fn(),
      sports: vi.fn(),
      drawConfig: vi.fn(),
      updateDrawConfig: vi.fn(),
    },
  };
});

const CATALOG: ConstraintType[] = [
  { type: "min_rest_minutes", label: "Minimum rest between a team's matches",
    hard: true, params_schema: { minutes: "int" },
    scopes: ["all", "sport", "leaf", "team"], layer: "S" },
  { type: "recurring_blackout_window", label: "Recurring blocked window",
    hard: true, params_schema: { days: "list", from: "time", to: "time" },
    scopes: ["all", "sport", "leaf"], layer: "S" },
  { type: "official_capacity", label: "Concurrent-match capacity (officials)",
    hard: true, params_schema: { count: "int" }, scopes: ["sport", "all"],
    layer: "S" },
];

const SETTINGS = {
  rules: {},
  constraints: [
    { type: "recurring_blackout_window", scope: "all", hard: true, weight: 5,
      params: { days: ["sun"], from: "00:00", to: "13:00" } },
  ],
  rules_frozen_at: null,
  can_edit: true,
  can_manage: true,
  can_delete: true,
} as unknown as TournamentSettings;

const COMPETITIONS = [{ leafKey: "football.u15", label: "Football · U15" }];
const TEAMS = [{ id: "tm1", name: "Alpha" }];

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

function mount() {
  return wrap(
    <ConstraintBuilder
      tournamentId="t1"
      competitions={COMPETITIONS}
      teams={TEAMS}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.settings).mockResolvedValue(SETTINGS);
  vi.mocked(tournamentsApi.updateSettings).mockResolvedValue(SETTINGS);
  vi.mocked(tournamentsApi.constraintTypes).mockResolvedValue(CATALOG);
  vi.mocked(tournamentsApi.sports).mockResolvedValue({
    sports: [{ key: "football", name: "Football" }],
  });
  vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
    draw_config: {},
    defaults: { format: "round_robin" } as unknown as DrawConfig,
  });
  vi.mocked(tournamentsApi.updateDrawConfig).mockResolvedValue({
    leaf_key: "*",
    draw_config: {},
    effective: { format: "round_robin" } as unknown as DrawConfig,
    has_matches: false,
  });
});

describe("ConstraintBuilder", () => {
  it("lists stored records with catalog labels and a global-setup badge", async () => {
    mount();
    expect(
      await screen.findByText("Recurring blocked window"),
    ).toBeInTheDocument();
    expect(screen.getByText("From Step 1")).toBeInTheDocument();
    // pristine → nothing to save yet
    expect(screen.getByTestId("save-constraints")).toBeDisabled();
  });

  it("adds a typed record from the catalog and saves the full list via the settings PATCH", async () => {
    mount();
    await screen.findByText("Recurring blocked window");
    await userEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    await userEvent.click(
      screen.getByRole("option", { name: "Concurrent-match capacity (officials)" }),
    );
    // scope options come from the catalog's scopes (sport + all only)
    await userEvent.click(screen.getByRole("button", { name: "Scope, rule 2" }));
    expect(
      screen.getByRole("option", { name: "Sport · Football" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Football · U15" }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "Sport · Football" }));

    await userEvent.click(screen.getByTestId("save-constraints"));
    await waitFor(() => expect(tournamentsApi.updateSettings).toHaveBeenCalled());
    const body = vi.mocked(tournamentsApi.updateSettings).mock.calls[0][1];
    expect(body.event_id).toEqual(expect.any(String));
    expect(body.constraints).toEqual([
      // the stored record is preserved verbatim
      { type: "recurring_blackout_window", scope: "all", hard: true, weight: 5,
        params: { days: ["sun"], from: "00:00", to: "13:00" } },
      // the new record carries catalog defaults + the picked scope
      { type: "official_capacity", scope: "sport:football", hard: true,
        weight: 5, params: { count: 1 } },
    ]);
  });

  it("normalizes an empty days picker to null (catalog: null = every day)", async () => {
    mount();
    await screen.findByText("Recurring blocked window");
    // remove the only selected day, then save
    await userEvent.click(screen.getByTestId("constraint-0-day-sun"));
    await userEvent.click(screen.getByTestId("save-constraints"));
    await waitFor(() => expect(tournamentsApi.updateSettings).toHaveBeenCalled());
    const body = vi.mocked(tournamentsApi.updateSettings).mock.calls[0][1];
    expect(body.constraints![0].params.days).toBeNull();
  });

  it("Mark reviewed stamps draw_config['*'].constraints_reviewed_at", async () => {
    mount();
    await screen.findByText("Recurring blocked window");
    await userEvent.click(screen.getByTestId("mark-reviewed"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith("t1", {
        leaf_key: "*",
        config: { constraints_reviewed_at: expect.any(String) },
        event_id: expect.any(String),
      }),
    );
  });

  it("shows the stored reviewed timestamp", async () => {
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {
        "*": { constraints_reviewed_at: "2026-06-10T09:00:00Z" },
      },
      defaults: { format: "round_robin" } as unknown as DrawConfig,
    });
    mount();
    expect(await screen.findByText("Checked")).toBeInTheDocument();
  });
});
