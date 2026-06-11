import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type DrawConfig } from "@/api/tournaments";
import { AdvanceToKnockoutDialog } from "../AdvanceToKnockoutDialog";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      drawConfig: vi.fn(),
      generateFixtures: vi.fn(),
    },
  };
});

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
  vi.mocked(tournamentsApi.generateFixtures).mockResolvedValue({ generated: 4 });
  vi.mocked(tournamentsApi.drawConfig).mockResolvedValue({
    draw_config: {
      "*": { advance_per_group: 2 },
      leaf: { advance_per_group: 1 },
    },
    defaults: { advance_per_group: 2 } as unknown as DrawConfig,
  });
});

describe("AdvanceToKnockoutDialog", () => {
  it("prefills the stored advance_per_group and never re-asks it blank", async () => {
    wrap(
      <AdvanceToKnockoutDialog
        tournamentId="t1"
        open
        onClose={() => {}}
        leafKey="leaf"
        leafLabel="Leaf"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("advance-per-group")).toHaveValue(1),
    );
    await userEvent.click(screen.getByTestId("confirm-advance"));
    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        format: "knockout_from_groups",
        advancePerGroup: 1,
        leafKey: "leaf",
      }),
    );
  });

  it("falls back to the '*' layer when the leaf has no stored value", async () => {
    wrap(
      <AdvanceToKnockoutDialog
        tournamentId="t1"
        open
        onClose={() => {}}
        leafKey="other.leaf"
        leafLabel="Other"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("advance-per-group")).toHaveValue(2),
    );
  });
});
