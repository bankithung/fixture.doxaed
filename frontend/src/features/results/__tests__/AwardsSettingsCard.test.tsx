import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tournamentsApi, type AwardsPayload } from "@/api/tournaments";
import { ToastProvider } from "@/components/ui/toast";
import { AwardsSettingsCard } from "../AwardsSettingsCard";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      awards: vi.fn(),
      saveAwards: vi.fn(),
    },
  };
});

const TT = "table_tennis.u_14.boys.singles";
const SEPAK = "sepak_takraw.u_14.boys";

const PAYLOAD: AwardsPayload = {
  awards: {
    enabled: false,
    ladder: [
      { place: 1, points: 5, label: "Gold" },
      { place: 2, points: 3, label: "Silver" },
      { place: 3, points: 2, label: "Bronze" },
    ],
    by_competition: [],
    bronze: "shared",
    groups: [],
    overrides: [],
  },
  competitions: [
    {
      leaf_key: TT, sport_key: "table_tennis", sport_name: "Table Tennis",
      path: ["U-14", "Boys", "Singles"], label: "U-14 · Boys · Singles",
    },
    {
      leaf_key: SEPAK, sport_key: "sepak_takraw", sport_name: "Sepak Takraw",
      path: ["U-14", "Boys"], label: "U-14 · Boys",
    },
  ],
  suggested_groups: [
    {
      key: "u_14_boys", label: "U-14 Boys",
      include: ["table_tennis.u_14.boys", "sepak_takraw.u_14.boys"],
      decide: "points",
    },
  ],
  can_manage: true,
};

function renderCard(canManage = true): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AwardsSettingsCard tournamentId="t1" canManage={canManage} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("AwardsSettingsCard", () => {
  beforeEach(() => {
    vi.mocked(tournamentsApi.awards).mockResolvedValue(PAYLOAD);
    vi.mocked(tournamentsApi.saveAwards).mockResolvedValue(PAYLOAD);
  });

  it("shows the ladder the host owns, place by place", async () => {
    renderCard();
    expect(await screen.findByTestId("ladder-points-1")).toHaveValue(5);
    expect(screen.getByTestId("ladder-points-3")).toHaveValue(2);
  });

  it("saves a changed points value", async () => {
    renderCard();
    const gold = await screen.findByTestId("ladder-points-1");
    await userEvent.clear(gold);
    await userEvent.type(gold, "10");
    await userEvent.click(screen.getByTestId("awards-save"));

    await waitFor(() =>
      expect(tournamentsApi.saveAwards).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          ladder: expect.arrayContaining([
            expect.objectContaining({ place: 1, points: 10 }),
          ]),
        }),
      ),
    );
  });

  it("adds a fourth place, because a meet can score deeper than three", async () => {
    renderCard();
    await screen.findByTestId("ladder-points-1");
    await userEvent.click(screen.getByRole("button", { name: "Add a place" }));
    expect(screen.getByTestId("ladder-points-4")).toBeInTheDocument();
  });

  it("offers groups read off the category tree, spanning sports", async () => {
    renderCard();
    await screen.findByTestId("awards-suggest");
    await userEvent.click(screen.getByTestId("awards-suggest"));
    const group = await screen.findByTestId("awards-group-0");
    expect(screen.getByLabelText("Group name")).toHaveValue("U-14 Boys");
    expect(group).toHaveTextContent("2 competitions");
  });

  it("is read-only for someone who cannot manage the tournament", async () => {
    renderCard(false);
    expect(await screen.findByTestId("ladder-points-1")).toBeDisabled();
    expect(screen.queryByTestId("awards-save")).not.toBeInTheDocument();
  });

  it("says when a group has quietly lost a whole sport", async () => {
    // "Overall" frozen to the table-tennis competitions excludes sepak takraw
    // from the overall trophy, and nothing said so (owner 2026-08-25).
    vi.mocked(tournamentsApi.awards).mockResolvedValue({
      ...PAYLOAD,
      awards: {
        ...PAYLOAD.awards,
        groups: [
          { key: "overall", label: "Overall", include: [TT], decide: "points" },
        ],
      },
    });
    renderCard();

    expect(await screen.findByTestId("awards-group-warn-0")).toHaveTextContent(
      "Sepak Takraw",
    );
    // And "every competition" is a state the host can pick, not one they can
    // only reach by re-ticking every box.
    expect(screen.getByTestId("awards-group-all-0")).not.toBeChecked();
    await userEvent.click(screen.getByTestId("awards-group-all-0"));
    expect(screen.queryByTestId("awards-group-warn-0")).toBeNull();
    await userEvent.click(screen.getByTestId("awards-save"));
    await waitFor(() =>
      expect(tournamentsApi.saveAwards).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({
          groups: [expect.objectContaining({ include: [] })],
        }),
      ),
    );
  });
});
