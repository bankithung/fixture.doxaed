import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";
import { ScoringPresetsPanel } from "../ScoringPresetsPanel";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      sportsMeta: vi.fn(),
      sports: vi.fn(),
      setSports: vi.fn(),
    },
  };
});

const LEGACY = {
  type: "sets" as const, best_of: 3, points: 21, win_by: 2, cap: 25,
  deciding: { points: 15, win_by: 2, cap: 17 },
  serve: {
    serves_per_turn: 3, alternate_every_point: false,
    change_ends_at: { regular: 11, deciding: 8 },
  },
};
const ISTAF_2024 = {
  type: "sets" as const, best_of: 3, points: 15, win_by: 2, cap: 17,
  deciding: { points: 15, win_by: 2, cap: 17 },
  serve: {
    serves_per_turn: 1, alternate_every_point: true,
    change_ends_at: { deciding: 8 },
  },
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ScoringPresetsPanel tournamentId="t1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.sportsMeta).mockResolvedValue({
    sports: [{ key: "sepak_takraw", name: "Sepak Takraw", leaf_count: 2 }],
    descriptors: {
      sepak_takraw: {
        key: "sepak_takraw", name: "Sepak Takraw", family: "target",
        has_draw: false, terms: { period: "Set" }, boards: [],
        presets: [
          { key: "istaf_legacy", label: "ISTAF legacy", note: "21/25, 15/17 decider", scoring: LEGACY },
          { key: "istaf_2024", label: "ISTAF 2024", note: "15/17, single service", scoring: ISTAF_2024 },
        ],
      },
    },
  });
  vi.mocked(tournamentsApi.sports).mockResolvedValue({
    sports: [{ key: "sepak_takraw", name: "Sepak Takraw", scoring: LEGACY }],
  });
  vi.mocked(tournamentsApi.setSports).mockResolvedValue({ sports: [] });
});

describe("ScoringPresetsPanel (D1 one-click)", () => {
  it("shows the active regime and applies another with an idempotent write", async () => {
    mount();
    // The stored scoring matches ISTAF legacy -> shown as active + disabled.
    const legacyBtn = await screen.findByTestId(
      "preset-sepak_takraw-istaf_legacy",
    );
    expect(legacyBtn).toBeDisabled();
    expect(screen.getByText("ISTAF legacy")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("preset-sepak_takraw-istaf_2024"));
    await waitFor(() => expect(tournamentsApi.setSports).toHaveBeenCalled());
    const [tid, sports, eventId] = vi.mocked(tournamentsApi.setSports).mock
      .calls[0];
    expect(tid).toBe("t1");
    expect(sports[0].scoring).toEqual(ISTAF_2024);
    expect(eventId).toBeTruthy(); // invariant 3: replay-safe
  });
});
