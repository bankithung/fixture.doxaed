import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import {
  tournamentsApi,
  type DrawConfigResponse,
  type TournamentSettings,
} from "@/api/tournaments";
import { CompetitionFormatBoard } from "../CompetitionFormatBoard";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      drawConfig: vi.fn(),
      updateDrawConfig: vi.fn(),
      sports: vi.fn(),
      settings: vi.fn(),
      updateSettings: vi.fn(),
    },
  };
});

function settingsPayload(over: Partial<TournamentSettings> = {}): TournamentSettings {
  return {
    rules: {
      format: "round_robin", group_size: 4, advance_per_group: 2,
      points: { win: 3, draw: 1, loss: 0 }, tiebreakers: ["points"],
      match: { halves: 2, half_minutes: 45, extra_time: false, penalties: true },
      squad: { min_players: 7, max_players: 23, max_subs: 5 },
      discipline: { yellow_suspension_threshold: 2, red_matches_banned: 1 },
      by_leaf: {},
    },
    constraints: [], rules_frozen_at: null, can_edit: true, can_manage: true,
    can_delete: true, scheduling_config: {},
    scoring_defaults: {
      table_tennis: { type: "sets", best_of: 3, points: 21, win_by: 2, cap: null },
      sepak_takraw: { type: "sets", best_of: 3, points: 21, win_by: 2, cap: 25 },
    },
    ...over,
  } as unknown as TournamentSettings;
}

const COMPS = [
  { leafKey: "table_tennis.u14.boys.singles", label: "U-14 Boys Singles", sport: "table_tennis" },
  { leafKey: "table_tennis.u14.boys.doubles", label: "U-14 Boys Doubles", sport: "table_tennis" },
  { leafKey: "sepak_takraw.u14.boys", label: "U-14 Boys", sport: "sepak_takraw" },
];

const DEFAULTS = {
  format: "round_robin", group_size: 4, advance_per_group: 2, advance_best_thirds: 0,
  legs: 1, swiss_rounds: null, seeding: "registration", knockout_seeding: "cross",
  seed: null, third_place: false, plate: false, bye_policy: "seeded_byes",
  min_entries_action: "prompt", constraints_reviewed_at: null,
};

function dc(layers: Record<string, unknown> = {}): DrawConfigResponse {
  return { draw_config: layers, defaults: DEFAULTS } as unknown as DrawConfigResponse;
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
  wrap(<CompetitionFormatBoard tournamentId="t1" competitions={comps} />);

/** Open a sport's bookmark tab (one sport card shows at a time). */
const openSport = async (sp: string) =>
  userEvent.click(await screen.findByTestId(`format-sport-tab-${sp}`));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.drawConfig).mockResolvedValue(dc());
  vi.mocked(tournamentsApi.updateDrawConfig).mockResolvedValue({} as never);
  vi.mocked(tournamentsApi.sports).mockResolvedValue({
    sports: [
      { key: "table_tennis", name: "Table Tennis" },
      { key: "sepak_takraw", name: "Sepak Takraw" },
    ],
  });
  vi.mocked(tournamentsApi.settings).mockResolvedValue(settingsPayload());
  vi.mocked(tournamentsApi.updateSettings).mockResolvedValue({} as never);
});

describe("CompetitionFormatBoard", () => {
  it("shows one bookmark tab per sport and swaps the open card", async () => {
    mount();
    const ttTab = await screen.findByTestId("format-sport-tab-table_tennis");
    expect(ttTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("format-sport-tab-sepak_takraw"))
      .toHaveAttribute("aria-selected", "false");
    // Only the open tab's card renders; clicking the other tab swaps it in.
    expect(await screen.findByTestId("format-sport-table_tennis")).toBeInTheDocument();
    expect(screen.queryByTestId("format-sport-sepak_takraw")).not.toBeInTheDocument();
    await openSport("sepak_takraw");
    expect(await screen.findByTestId("format-sport-sepak_takraw")).toBeInTheDocument();
    expect(screen.queryByTestId("format-sport-table_tennis")).not.toBeInTheDocument();
  });

  it("sets a whole sport's format in one write to the sport layer", async () => {
    mount();
    await userEvent.click(
      await screen.findByTestId("format-sport-table_tennis-format-knockout"),
    );
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          leaf_key: "sport:table_tennis",
          config: expect.objectContaining({ format: "knockout" }),
        }),
      ),
    );
  });

  it("group-stage→knockout exposes group size + advance and saves them", async () => {
    mount();
    await openSport("sepak_takraw");
    await userEvent.click(
      await screen.findByTestId(
        "format-sport-sepak_takraw-format-groups_knockout",
      ),
    );
    const adv = await screen.findByTestId("format-sport-sepak_takraw-advance");
    fireEvent.change(adv, { target: { value: "3" } });
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          leaf_key: "sport:sepak_takraw",
          config: expect.objectContaining({
            format: "groups_knockout",
            group_size: 4,
            advance_per_group: 3,
          }),
        }),
      ),
    );
  });

  it("defaults groups to balanced sizing and lets you turn it off", async () => {
    mount();
    await openSport("sepak_takraw");
    await userEvent.click(
      await screen.findByTestId(
        "format-sport-sepak_takraw-format-groups_knockout",
      ),
    );
    // FIFA-style balance is on by default after choosing the group format.
    const balance = await screen.findByTestId("format-sport-sepak_takraw-balance");
    expect(balance).toBeChecked();
    await userEvent.click(balance); // turn it off
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          leaf_key: "sport:sepak_takraw",
          config: expect.objectContaining({
            format: "groups_knockout",
            balance_groups: false,
          }),
        }),
      ),
    );
  });

  it("can override one category's format independently of its sport", async () => {
    mount();
    await userEvent.click(
      await screen.findByTestId("format-sport-table_tennis-customize"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Format for U-14 Boys Doubles" }),
    );
    await userEvent.click(
      screen.getByRole("option", { name: "Round-robin (league)" }),
    );
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          leaf_key: "table_tennis.u14.boys.doubles",
          config: expect.objectContaining({ format: "round_robin" }),
        }),
      ),
    );
  });

  it("sets a sport-level match duration (applies to all its categories)", async () => {
    mount();
    await openSport("sepak_takraw");
    fireEvent.change(
      await screen.findByTestId("format-sport-sepak_takraw-duration"),
      { target: { value: "20" } },
    );
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          leaf_key: "sport:sepak_takraw",
          config: expect.objectContaining({ match_duration_minutes: 20 }),
        }),
      ),
    );
  });

  it("inherits the sport's scoring default on each game's card", async () => {
    mount();
    await openSport("sepak_takraw");
    // sepak is single-category → its scoring control sits on the sport card,
    // showing the inherited sepak profile (best of 3 · 21 pts · cap 25).
    const summary = await screen.findByTestId("format-sport-sepak_takraw-scoring-summary");
    expect(summary).toHaveTextContent("Best of 3");
    expect(summary).toHaveTextContent("21 pts");
    expect(summary).toHaveTextContent("cap 25");
  });

  it("saves a per-game scoring override via the settings PATCH", async () => {
    mount();
    await userEvent.click(
      await screen.findByTestId("format-sport-table_tennis-customize"),
    );
    const id = "format-leaf-table_tennis.u14.boys.doubles-scoring";
    await userEvent.click(screen.getByTestId(`${id}-toggle`));
    fireEvent.change(screen.getByTestId(`${id}-points`), { target: { value: "15" } });
    fireEvent.change(screen.getByTestId(`${id}-cap`), { target: { value: "17" } });
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateSettings).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          amend: false,
          rules: {
            by_leaf: {
              "table_tennis.u14.boys.doubles": {
                scoring: expect.objectContaining({ type: "sets", points: 15, cap: 17 }),
              },
            },
          },
        }),
      ),
    );
    // draw-config was untouched (scoring rides the settings PATCH only)
    expect(tournamentsApi.updateDrawConfig).not.toHaveBeenCalled();
  });

  it("composes multiple stages and saves them to the sport layer", async () => {
    mount();
    await openSport("sepak_takraw");
    await userEvent.click(
      await screen.findByTestId("format-sport-sepak_takraw-stages-toggle"),
    );
    const ed = "format-sport-sepak_takraw-stages";
    await userEvent.click(screen.getByTestId(`${ed}-add`)); // round_robin
    await userEvent.click(screen.getByTestId(`${ed}-add`)); // knockout
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          leaf_key: "sport:sepak_takraw",
          config: expect.objectContaining({
            stages: expect.arrayContaining([
              expect.objectContaining({ type: "round_robin" }),
              expect.objectContaining({
                type: "knockout",
                from: expect.objectContaining({ advance_per_group: 2 }),
              }),
            ]),
          }),
        }),
      ),
    );
  });

  it("composes stages for ONE category, saved to that leaf layer (per-game)", async () => {
    mount();
    await userEvent.click(
      await screen.findByTestId("format-sport-table_tennis-customize"),
    );
    const leaf = "table_tennis.u14.boys.doubles";
    await userEvent.click(screen.getByTestId(`format-leaf-${leaf}-stages-toggle`));
    const ed = `format-leaf-${leaf}-stages`;
    await userEvent.click(screen.getByTestId(`${ed}-add`)); // round_robin
    await userEvent.click(screen.getByTestId(`${ed}-add`)); // knockout
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          leaf_key: leaf,
          config: expect.objectContaining({
            stages: expect.arrayContaining([
              expect.objectContaining({ type: "round_robin" }),
              expect.objectContaining({ type: "knockout" }),
            ]),
          }),
        }),
      ),
    );
  });

  it("saves a per-game tie-breaker order via the settings PATCH", async () => {
    mount();
    await openSport("sepak_takraw");
    // sepak is single-category → its tie-breakers sit on the sport card
    const id = "format-sport-sepak_takraw-tiebreakers";
    await userEvent.click(await screen.findByTestId(`${id}-toggle`));
    await userEvent.click(screen.getByTestId(`${id}-down-head_to_head`));
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateSettings).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          rules: {
            by_leaf: {
              "sepak_takraw.u14.boys": {
                tiebreakers: [
                  "points", "set_difference", "head_to_head",
                  "point_difference", "points_for", "coin_toss",
                ],
              },
            },
          },
        }),
      ),
    );
  });

  it("requires an amend reason to change scoring once rules are frozen", async () => {
    vi.mocked(tournamentsApi.settings).mockResolvedValue(
      settingsPayload({ can_edit: false, rules_frozen_at: "2026-06-01T00:00:00Z" }),
    );
    mount();
    await openSport("sepak_takraw");
    const id = "format-sport-sepak_takraw-scoring";
    await userEvent.click(await screen.findByTestId(`${id}-toggle`));
    fireEvent.change(screen.getByTestId(`${id}-points`), { target: { value: "25" } });
    // amend reason appears and the save is blocked until it's filled
    expect(screen.getByTestId("scoring-amend-reason")).toBeInTheDocument();
    expect(screen.getByTestId("save-formats")).toBeDisabled();
    fireEvent.change(screen.getByTestId("scoring-amend-reason"), {
      target: { value: "corrected after a referee meeting" },
    });
    expect(screen.getByTestId("save-formats")).not.toBeDisabled();
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateSettings).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ amend: true, reason: "corrected after a referee meeting" }),
      ),
    );
  });

  it("names a hidden sport whose stage plan blocks the save", async () => {
    // Table Tennis has a stored invalid plan (a knockout that is not last).
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue(
      dc({
        "sport:table_tennis": {
          stages: [
            { id: "s1", type: "knockout" },
            { id: "s2", type: "round_robin", from: { advance_per_group: 2 } },
          ],
        },
      }),
    );
    mount();
    // Work on Sepak Takraw, so the broken sport's tab is hidden.
    await openSport("sepak_takraw");
    fireEvent.change(
      await screen.findByTestId("format-sport-sepak_takraw-duration"),
      { target: { value: "20" } },
    );
    expect(screen.getByTestId("save-formats")).toBeDisabled();
    const hint = screen.getByTestId("stage-errors-hint");
    expect(hint).toHaveTextContent("Table Tennis");
    // Clicking the named sport opens its tab so the inline error is visible…
    await userEvent.click(
      within(hint).getByRole("button", { name: "Table Tennis" }),
    );
    expect(
      await screen.findByTestId("format-sport-table_tennis"),
    ).toBeInTheDocument();
    // …and the hint goes away (the error sport is no longer hidden).
    expect(screen.queryByTestId("stage-errors-hint")).not.toBeInTheDocument();
  });

  it("keeps only the failed layers staged after a mid-save failure", async () => {
    mount();
    // Stage edits on two sport layers.
    await userEvent.click(
      await screen.findByTestId("format-sport-table_tennis-format-knockout"),
    );
    await openSport("sepak_takraw");
    await userEvent.click(
      await screen.findByTestId("format-sport-sepak_takraw-format-knockout"),
    );
    // First PATCH lands, the second fails mid-loop.
    vi.mocked(tournamentsApi.updateDrawConfig)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("boom"));
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledTimes(2),
    );
    expect(
      await screen.findByText("Could not save the formats"),
    ).toBeInTheDocument();

    // Re-save sends ONLY the failed layer; the committed one is not re-sent.
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledTimes(3),
    );
    expect(
      vi.mocked(tournamentsApi.updateDrawConfig).mock.calls[2]![1],
    ).toEqual(expect.objectContaining({ leaf_key: "sport:sepak_takraw" }));
  });

  it("overrides one category's match duration; clearing sends null (inherit)", async () => {
    vi.mocked(tournamentsApi.drawConfig).mockResolvedValue(
      dc({ "table_tennis.u14.boys.singles": { match_duration_minutes: 15 } }),
    );
    mount();
    await userEvent.click(
      await screen.findByTestId("format-sport-table_tennis-customize"),
    );
    const input = screen.getByTestId(
      "format-leaf-table_tennis.u14.boys.singles-duration",
    );
    expect(input).toHaveValue(15);
    fireEvent.change(input, { target: { value: "" } });
    await userEvent.click(screen.getByTestId("save-formats"));
    await waitFor(() =>
      expect(tournamentsApi.updateDrawConfig).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          leaf_key: "table_tennis.u14.boys.singles",
          config: expect.objectContaining({ match_duration_minutes: null }),
        }),
      ),
    );
  });
});
