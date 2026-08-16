import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateTournamentPage } from "../CreateTournamentPage";
import { tournamentsApi } from "@/api/tournaments";

vi.mock("@/api/tournaments");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CreateTournamentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CreateTournamentPage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates a tournament with the name + a client event_id", async () => {
    vi.mocked(tournamentsApi.create).mockResolvedValue({
      id: "t1",
      slug: "kohima-cup",
      name: "Kohima Cup",
      status: "draft",
      organization_slug: "ws-1",
      sport_code: null,
      sports: [],
      time_zone: "Asia/Kolkata",
      created_at: "2026-06-05T00:00:00Z",
    });

    renderPage();

    await userEvent.type(
      screen.getByLabelText(/tournament name/i),
      "Kohima Cup",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /create tournament/i }),
    );

    await waitFor(() =>
      expect(tournamentsApi.create).toHaveBeenCalledTimes(1),
    );
    const arg = vi.mocked(tournamentsApi.create).mock.calls[0][0];
    expect(arg.name).toBe("Kohima Cup");
    expect(arg.event_id).toBeTruthy();
  });

  it("shows a validation error when name is empty", async () => {
    renderPage();
    await userEvent.click(
      screen.getByRole("button", { name: /create tournament/i }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/required/i);
    expect(tournamentsApi.create).not.toHaveBeenCalled();
  });

  // Participants-first (spec 2026-08-17) — asked here, and still switchable in
  // Settings until the first team is registered.
  it("defaults to typed names and can be switched to participants-first", async () => {
    vi.mocked(tournamentsApi.create).mockResolvedValue({
      id: "t1",
      slug: "roster-cup",
      name: "Roster Cup",
      status: "draft",
      organization_slug: "ws-1",
      sport_code: null,
      sports: [],
      time_zone: "Asia/Kolkata",
      created_at: "2026-06-05T00:00:00Z",
    });

    renderPage();
    expect(screen.getByTestId("roster-mode-inline")).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await userEvent.type(screen.getByLabelText(/tournament name/i), "Roster Cup");
    await userEvent.click(screen.getByTestId("roster-mode-roster_first"));
    await userEvent.click(
      screen.getByRole("button", { name: /create tournament/i }),
    );

    await waitFor(() => expect(tournamentsApi.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(tournamentsApi.create).mock.calls[0][0].roster_mode).toBe(
      "roster_first",
    );
    // The scope question is untouched by the new one.
    expect(vi.mocked(tournamentsApi.create).mock.calls[0][0].scope).toBe(
      "inter_school",
    );
  });
});
