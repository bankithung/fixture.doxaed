import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TournamentsListPage } from "../TournamentsListPage";
import { tournamentsApi, type Tournament } from "@/api/tournaments";

vi.mock("@/api/tournaments");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TournamentsListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SAMPLE: Tournament = {
  id: "t1",
  slug: "kohima-cup",
  name: "Kohima Cup",
  status: "draft",
  organization_slug: "ws-1",
  sport_code: null,
  time_zone: "Asia/Kolkata",
  created_at: "2026-06-05T00:00:00Z",
};

describe("TournamentsListPage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("lists the user's tournaments", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([SAMPLE]);
    renderPage();
    expect(await screen.findByText("Kohima Cup")).toBeInTheDocument();
  });

  it("shows an empty state with a start CTA when there are none", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([]);
    renderPage();
    expect(
      await screen.findByText(/haven't started any tournaments/i),
    ).toBeInTheDocument();
  });

  it("invites by email with a role + idempotency event_id", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([SAMPLE]);
    vi.mocked(tournamentsApi.invite).mockResolvedValue({
      id: "i1",
      email: "ref@example.com",
      role: "referee",
      tournament_id: "t1",
      status: "pending",
    });
    renderPage();
    await screen.findByText("Kohima Cup");

    await userEvent.type(
      screen.getByLabelText(/invite by email/i),
      "ref@example.com",
    );
    await userEvent.click(screen.getByRole("button", { name: /^role$/i }));
    await userEvent.click(screen.getByRole("option", { name: /referee/i }));
    await userEvent.click(screen.getByRole("button", { name: /send invite/i }));

    await waitFor(() => expect(tournamentsApi.invite).toHaveBeenCalledTimes(1));
    const [tid, payload] = vi.mocked(tournamentsApi.invite).mock.calls[0];
    expect(tid).toBe("t1");
    expect(payload.email).toBe("ref@example.com");
    expect(payload.role).toBe("referee");
    expect(payload.event_id).toBeTruthy();
    expect(await screen.findByText(/invitation sent/i)).toBeInTheDocument();
  });
});
