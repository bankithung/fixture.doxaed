import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InvitesPage } from "../InvitesPage";
import { ToastProvider } from "@/components/ui/toast";
import { invitationsApi, type MyInvitation } from "@/api/invitations";

vi.mock("@/api/invitations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/invitations")>();
  return {
    ...actual,
    invitationsApi: {
      ...actual.invitationsApi,
      myInvitations: vi.fn(),
      acceptInvitation: vi.fn(),
      declineInvitation: vi.fn(),
    },
  };
});

const tournamentInvite: MyInvitation = {
  id: "inv-1",
  email: "me@example.com",
  role: "match_scorer",
  status: "pending",
  organization_name: "Acme Org",
  tournament_id: "t-99",
  tournament_name: "Nagaland Schools Cup",
  invited_by_email: "owner@example.com",
  expires_at: "2026-07-01T10:00:00Z",
  created_at: "2026-06-01T10:00:00Z",
};

/** Captures the location the router navigated to (assert accept jump). */
function LocationProbe(): React.ReactElement {
  return <div data-testid="tournament-detail">tournament detail</div>;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/invites"]}>
          <Routes>
            <Route path="/invites" element={<InvitesPage />} />
            <Route path="/tournaments" element={<div>tournaments hub</div>} />
            <Route path="/tournaments/:id" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Desktop width so the table (not mobile cards) renders.
  window.innerWidth = 1280;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("InvitesPage", () => {
  it("renders pending invitations from the endpoint", async () => {
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([
      tournamentInvite,
    ]);

    renderPage();

    expect(
      await screen.findByText("Nagaland Schools Cup"),
    ).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    // Role is humanized.
    expect(screen.getByText("Match scorer")).toBeInTheDocument();
    expect(invitationsApi.myInvitations).toHaveBeenCalled();
  });

  it("shows the empty state when there are no invitations", async () => {
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([]);

    renderPage();

    expect(
      await screen.findByText(/no pending invitations/i),
    ).toBeInTheDocument();
  });

  it("accept calls acceptInvitation, invalidates tournaments, and navigates to the tournament", async () => {
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([
      tournamentInvite,
    ]);
    vi.mocked(invitationsApi.acceptInvitation).mockResolvedValue({
      membership_id: "mem-1",
      tournament_id: "t-99",
      role: "match_scorer",
      status: "accepted",
    });

    const { client } = renderPage();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    await screen.findByText("Nagaland Schools Cup");
    await userEvent.click(screen.getByTestId("accept-inv-1"));

    await waitFor(() =>
      expect(invitationsApi.acceptInvitation).toHaveBeenCalledWith("inv-1"),
    );

    // Both the inbox AND the tournaments-list query are invalidated.
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["my-invitations"],
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["tournaments"] });
    });

    // Navigated to the tournament detail page.
    expect(await screen.findByTestId("tournament-detail")).toBeInTheDocument();
  });

  it("decline confirms via the dialog then calls declineInvitation", async () => {
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([
      tournamentInvite,
    ]);
    vi.mocked(invitationsApi.declineInvitation).mockResolvedValue({
      status: "declined",
    });

    renderPage();

    await screen.findByText("Nagaland Schools Cup");
    await userEvent.click(screen.getByTestId("decline-inv-1"));

    const dialog = await screen.findByRole("dialog", {
      name: /decline invitation/i,
    });
    await userEvent.click(within(dialog).getByTestId("confirm-decline"));

    await waitFor(() =>
      expect(invitationsApi.declineInvitation).toHaveBeenCalledWith("inv-1"),
    );
  });
});
