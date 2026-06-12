import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type DrawConfig,
  type TeamRow,
} from "@/api/tournaments";
import { CompetitionFormatWizard } from "../CompetitionFormatWizard";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      drawConfig: vi.fn(),
      updateDrawConfig: vi.fn(),
      venues: vi.fn(),
      generateFixtures: vi.fn(),
      setTeamSeeds: vi.fn(),
    },
  };
});

const DEFAULTS = {
  format: "round_robin",
  group_size: 5,
  advance_per_group: 2,
  legs: 1,
  seeding: "registration",
  seed: null,
  third_place: false,
  bye_policy: "seeded_byes",
  min_entries_action: "prompt",
  constraints_reviewed_at: null,
  calendar: null,
} as DrawConfig;

function team(id: string, name: string, seed: number | null = null): TeamRow {
  return {
    id, name, short_name: name, school: "S", pool: "", sport: "football",
    leaf_key: "football.u15", status: "registered", seed, player_count: 7,
  };
}

const TEAMS = [team("a", "Alpha"), team("b", "Bravo"), team("c", "Charlie")];

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
  vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
    draw_config: {},
    defaults: DEFAULTS,
  });
  vi.mocked(tournamentsApi.venues).mockResolvedValue({ venues: [] });
  vi.mocked(tournamentsApi.updateDrawConfig).mockResolvedValue({
    leaf_key: "football.u15",
    draw_config: {},
    effective: DEFAULTS,
    has_matches: false,
  });
  vi.mocked(tournamentsApi.generateFixtures).mockResolvedValue({ generated: 3 });
  vi.mocked(tournamentsApi.setTeamSeeds).mockResolvedValue({
    updated: 3,
    leaf_key: "football.u15",
  });
});

function mount(over: Partial<Parameters<typeof CompetitionFormatWizard>[0]> = {}) {
  return wrap(
    <CompetitionFormatWizard
      tournamentId="t1"
      open
      onClose={() => {}}
      leafKey="football.u15"
      leafLabel="Football · U15"
      teams={TEAMS}
      onGenerated={() => {}}
      {...over}
    />,
  );
}

describe("CompetitionFormatWizard", () => {
  it("shows the asked-once globals read-only and never re-asks them", async () => {
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {
        "*": { calendar: { date_start: "2026-06-20", date_end: "2026-06-28" } },
      },
      defaults: DEFAULTS,
    });
    vi.mocked(tournamentsApi.venues).mockResolvedValue({
      venues: [
        { id: "v1", name: "A", venue_type: "ground", windows: [], count: 1 },
        { id: "v2", name: "B", venue_type: "hall", windows: [], count: 4 },
      ],
    });
    const onEditGlobals = vi.fn();
    mount({ onEditGlobals });

    const strip = await screen.findByTestId("globals-strip");
    await waitFor(() => expect(strip).toHaveTextContent("2 venues"));
    expect(strip).toHaveTextContent("From global setup");
    // read-only: no date inputs anywhere in this wizard
    expect(document.querySelector('input[type="date"]')).toBeNull();
    await userEvent.click(screen.getByTestId("edit-globals"));
    expect(onEditGlobals).toHaveBeenCalled();
  });

  it("prefills every stored answer from draw_config[leaf]", async () => {
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
      draw_config: {
        "football.u15": {
          format: "groups_knockout",
          group_size: 3,
          advance_per_group: 1,
          legs: 2,
          seeding: "snake",
          third_place: true,
        },
      },
      defaults: DEFAULTS,
    });
    mount();

    expect(await screen.findByTestId("format-groups_knockout")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByTestId("group-size")).toHaveValue(3);
    expect(screen.getByTestId("advance-per-group")).toHaveValue(1);
    expect(screen.getByTestId("two-legs")).toBeChecked();
    expect(screen.getByTestId("third-place")).toBeChecked();
  });

  it("Save format persists draw_config[leaf] WITHOUT generating", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("format-groups_knockout"));
    fireEvent.change(screen.getByTestId("group-size"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("advance-per-group"), {
      target: { value: "1" },
    });
    await userEvent.click(screen.getByTestId("save-format"));

    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith("t1", {
        leaf_key: "football.u15",
        config: {
          seeding: "registration",
          format: "groups_knockout",
          group_size: 3,
          advance_per_group: 1,
          legs: 1,
          third_place: false,
        },
        event_id: expect.any(String),
      }),
    );
    expect(tournamentsApi.generateFixtures).not.toHaveBeenCalled();
  });

  it("league saves a single round_robin group sized to the field", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("format-league"));
    await userEvent.click(screen.getByTestId("save-format"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith("t1", {
        leaf_key: "football.u15",
        config: {
          seeding: "registration",
          format: "round_robin",
          group_size: 3, // = team count → one group
          advance_per_group: 2,
          legs: 1,
        },
        event_id: expect.any(String),
      }),
    );
  });

  it("seeded method opens the SeedListEditor and saves the order via the seeds API", async () => {
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Seeding method" }),
    );
    await userEvent.click(
      screen.getByRole("option", { name: /Seeded — strict seed order/ }),
    );
    // teams listed alphabetically (no stored seeds); promote Charlie to seed 2
    await userEvent.click(screen.getByLabelText("Move Charlie up"));
    await userEvent.click(screen.getByTestId("save-format"));

    await waitFor(() =>
      expect(tournamentsApi.setTeamSeeds).toHaveBeenCalledWith("t1", {
        leaf_key: "football.u15",
        seeds: [
          { team_id: "a", seed: 1 },
          { team_id: "c", seed: 2 },
          { team_id: "b", seed: 3 },
        ],
        event_id: expect.any(String),
      }),
    );
  });

  it("Save & generate persists, then generates from the stored config (bare body)", async () => {
    const onGenerated = vi.fn();
    mount({ onGenerated });
    await userEvent.click(await screen.findByTestId("format-knockout"));
    await userEvent.click(screen.getByTestId("third-place"));
    await userEvent.click(screen.getByTestId("confirm-generate"));

    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        leafKey: "football.u15",
      }),
    );
    expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith("t1", {
      leaf_key: "football.u15",
      config: { seeding: "registration", format: "knockout", third_place: true },
      event_id: expect.any(String),
    });
    expect(onGenerated).toHaveBeenCalledWith({
      leafKey: "football.u15",
      label: "Football · U15",
    });
  });

  it("with onPreview the primary CTA saves the format and hands off to the dry run (no direct generate)", async () => {
    const onPreview = vi.fn();
    mount({ onPreview });
    await userEvent.click(await screen.findByTestId("format-knockout"));
    expect(screen.queryByTestId("confirm-generate")).toBeNull();
    await userEvent.click(screen.getByTestId("confirm-preview"));

    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith("t1", {
        leaf_key: "football.u15",
        config: { seeding: "registration", format: "knockout", third_place: false },
        event_id: expect.any(String),
      }),
    );
    expect(onPreview).toHaveBeenCalledWith({
      leafKey: "football.u15",
      label: "Football · U15",
    });
    expect(tournamentsApi.generateFixtures).not.toHaveBeenCalled();
  });

  it("blocks saving when advance per group >= group size", async () => {
    mount();
    await userEvent.click(await screen.findByTestId("format-groups_knockout"));
    fireEvent.change(screen.getByTestId("group-size"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("advance-per-group"), {
      target: { value: "3" },
    });
    expect(
      screen.getByText("Advance per group must be smaller than the group size."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("save-format")).toBeDisabled();
    expect(screen.getByTestId("confirm-generate")).toBeDisabled();
  });
});
