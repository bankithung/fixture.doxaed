import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi } from "@/api/tournaments";
import { useFixtureStepStore } from "@/features/fixtures/fixtureStepStore";
import { FixtureStepBar } from "../FixtureStepBar";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      list: vi.fn(),
      copySetup: vi.fn(),
    },
  };
});

function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/fixtures"]}>
          <Routes>
            <Route path="/tournaments/:id/fixtures" element={<FixtureStepBar />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("FixtureStepBar · copying another tournament's setup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useFixtureStepStore.getState().publish({ step: 1, activeStep: 1 });
    vi.mocked(tournamentsApi.list).mockResolvedValue([
      { id: "t1", name: "This year" },
      {
        id: "t2",
        name: "ANPSA Dimapur District Table Tennis Competition 2026 (Clone 2)",
      },
    ] as never);
  });

  it("offers the copy from the top of every setup page", () => {
    // Owner 2026-08-19: "keep the copy rule button in the top right so anyone
    // can see it" — it used to sit under the optional Rules step.
    mount();
    expect(screen.getByTestId("open-copy-setup")).toBeInTheDocument();
  });

  it("opens a side panel and names the tournament in full", async () => {
    vi.mocked(tournamentsApi.copySetup).mockResolvedValue({
      source_id: "t2",
      source_name: "ANPSA Dimapur District Table Tennis Competition 2026 (Clone 2)",
      parts: ["constraints"],
      counts: { constraints: 14 },
      unknown_competitions: [],
      target_had: { constraints: 0, draw_config: 0 },
      copied: false,
      dry_run: true,
    } as never);

    mount();
    await userEvent.click(screen.getByTestId("open-copy-setup"));
    const panel = await screen.findByTestId("copy-setup-dialog");

    await userEvent.click(within(panel).getByLabelText("Copy from"));
    // The full name, not a truncated one — the panel has the room for it.
    await userEvent.click(
      screen.getByRole("option", {
        name: "ANPSA Dimapur District Table Tennis Competition 2026 (Clone 2)",
      }),
    );
    await userEvent.click(within(panel).getByTestId("copy-setup-check"));
    expect(await screen.findByTestId("copy-setup-report")).toHaveTextContent("14");
  });
});
