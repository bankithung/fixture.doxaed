import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type DrawConfigResponse } from "@/api/tournaments";
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
    },
  };
});

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
});

describe("CompetitionFormatBoard", () => {
  it("renders one group per sport with its category count", async () => {
    mount();
    expect(await screen.findByTestId("format-sport-table_tennis")).toBeInTheDocument();
    expect(screen.getByTestId("format-sport-sepak_takraw")).toBeInTheDocument();
    expect(screen.getByText(/2 categories/i)).toBeInTheDocument(); // table tennis
    expect(screen.getByText(/1 category/i)).toBeInTheDocument(); // sepak
  });

  it("sets a whole sport's format in one write to the sport layer", async () => {
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Format for Table Tennis" }),
    );
    await userEvent.click(
      screen.getByRole("option", { name: "Knockout (single elimination)" }),
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
    await userEvent.click(
      await screen.findByRole("button", { name: "Format for Sepak Takraw" }),
    );
    await userEvent.click(
      screen.getByRole("option", { name: "Group stage → Knockout" }),
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
    await userEvent.click(
      await screen.findByRole("button", { name: "Format for Sepak Takraw" }),
    );
    await userEvent.click(
      screen.getByRole("option", { name: "Group stage → Knockout" }),
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
