import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  AdvanceToKnockoutDialog,
  GenerateDrawWizard,
} from "../GenerateDrawWizard";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: { ...actual.tournamentsApi, generateFixtures: vi.fn() },
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
  vi.mocked(tournamentsApi.generateFixtures).mockResolvedValue({
    generated: 6,
  });
});
afterEach(() => vi.clearAllMocks());

describe("GenerateDrawWizard", () => {
  it("league on a leaf generates by_category and chains the scheduler", async () => {
    const onGenerated = vi.fn();
    wrap(
      <GenerateDrawWizard
        tournamentId="t1"
        open
        onClose={() => {}}
        leafKey="tt.u16.f.3v3"
        leafLabel="TT u16 F 3v3"
        teamCount={3}
        onGenerated={onGenerated}
      />,
    );

    await userEvent.click(screen.getByTestId("confirm-generate"));

    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        format: "by_category",
        leafKey: "tt.u16.f.3v3",
      }),
    );
    // "Ask me about dates & venues next" is on by default → chains.
    expect(onGenerated).toHaveBeenCalledWith({
      leafKey: "tt.u16.f.3v3",
      label: "TT u16 F 3v3",
    });
  });

  it("groups format asks teams-per-group and sends group_size", async () => {
    wrap(
      <GenerateDrawWizard
        tournamentId="t1"
        open
        onClose={() => {}}
        leafKey="leaf"
        leafLabel="Leaf"
        teamCount={9}
        onGenerated={() => {}}
      />,
    );

    await userEvent.click(screen.getByTestId("format-groups"));
    fireEvent.change(screen.getByTestId("group-size"), {
      target: { value: "3" },
    });
    await userEvent.click(screen.getByTestId("confirm-generate"));

    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        format: "round_robin",
        groupSize: 3,
        leafKey: "leaf",
      }),
    );
  });

  it("knockout format sends knockout", async () => {
    wrap(
      <GenerateDrawWizard
        tournamentId="t1"
        open
        onClose={() => {}}
        leafKey="leaf"
        leafLabel="Leaf"
        teamCount={5}
        onGenerated={() => {}}
      />,
    );
    await userEvent.click(screen.getByTestId("format-knockout"));
    await userEvent.click(screen.getByTestId("confirm-generate"));
    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        format: "knockout",
        leafKey: "leaf",
      }),
    );
  });
});

describe("AdvanceToKnockoutDialog", () => {
  it("sends knockout_from_groups with the chosen advance count", async () => {
    wrap(
      <AdvanceToKnockoutDialog
        tournamentId="t1"
        open
        onClose={() => {}}
        leafKey="leaf"
        leafLabel="Leaf"
      />,
    );
    fireEvent.change(screen.getByTestId("advance-per-group"), {
      target: { value: "1" },
    });
    await userEvent.click(screen.getByTestId("confirm-advance"));
    await waitFor(() =>
      expect(tournamentsApi.generateFixtures).toHaveBeenCalledWith("t1", {
        format: "knockout_from_groups",
        advancePerGroup: 1,
        leafKey: "leaf",
      }),
    );
  });
});
