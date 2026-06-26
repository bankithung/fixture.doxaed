import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TournamentsListPage } from "../TournamentsListPage";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type Tournament } from "@/api/tournaments";

vi.mock("@/api/tournaments");

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <TournamentsListPage />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const SAMPLE: Tournament = {
  id: "t1",
  slug: "kohima-cup",
  name: "Kohima Cup",
  status: "registration_open",
  organization_slug: "ws-1",
  sport_code: "football",
  sports: [],
  time_zone: "Asia/Kolkata",
  created_at: "2026-06-05T00:00:00Z",
  origin: "owner",
  my_roles: ["admin"],
};

describe("TournamentsListPage", () => {
  beforeEach(() => vi.resetAllMocks());

  it("lists the user's tournaments with status + sport", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([SAMPLE]);
    renderPage();
    expect(await screen.findByText("Kohima Cup")).toBeInTheDocument();
    expect(screen.getByText("kohima-cup")).toBeInTheDocument();
    expect(screen.getByText(/registration open/i)).toBeInTheDocument();
    expect(screen.getByText("football")).toBeInTheDocument();
  });

  it("makes each row a link that opens the tournament", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([SAMPLE]);
    renderPage();
    const link = await screen.findByRole("link", { name: "Kohima Cup" });
    expect(link).toHaveAttribute("href", "/tournaments/t1");
  });

  it("does not render the inline invite-by-email controls", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([SAMPLE]);
    renderPage();
    await screen.findByText("Kohima Cup");
    expect(screen.queryByLabelText(/invite by email/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /send invite/i }),
    ).not.toBeInTheDocument();
  });

  it("marks owned tournaments with the Owner chip and invited ones with the role", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([
      SAMPLE,
      {
        ...SAMPLE,
        id: "t2",
        slug: "guest-cup",
        name: "Guest Cup",
        origin: "invited",
        my_roles: ["match_scorer"],
      },
    ]);
    renderPage();
    await screen.findByText("Kohima Cup");
    expect(screen.getByTestId("role-badge-owner")).toBeInTheDocument();
    expect(screen.getByTestId("role-badge-match_scorer")).toBeInTheDocument();
    expect(screen.getByText("Match scorer")).toBeInTheDocument();
  });

  it("shows an empty state with a start CTA when there are none", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([]);
    renderPage();
    expect(
      await screen.findByText(/haven't started any tournaments/i),
    ).toBeInTheDocument();
  });

  it("lets a manager rename a tournament from the list", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([SAMPLE]);
    vi.mocked(tournamentsApi.rename).mockResolvedValue({
      ...SAMPLE,
      name: "Kohima Open",
    });
    renderPage();
    await screen.findByText("Kohima Cup");

    await userEvent.click(screen.getByTestId("rename-tournament"));
    const input = await screen.findByTestId("rename-input");
    await userEvent.clear(input);
    await userEvent.type(input, "Kohima Open");
    await userEvent.click(screen.getByTestId("confirm-rename"));

    await waitFor(() =>
      expect(tournamentsApi.rename).toHaveBeenCalledWith("t1", "Kohima Open"),
    );
  });

  it("hides the Edit name action from non-managing members", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([
      { ...SAMPLE, origin: "invited", my_roles: ["match_scorer"] },
    ]);
    renderPage();
    await screen.findByText("Kohima Cup");
    expect(screen.queryByTestId("rename-tournament")).toBeNull();
  });
});
