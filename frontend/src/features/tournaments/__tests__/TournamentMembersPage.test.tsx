import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TournamentMembersPage } from "../TournamentMembersPage";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type TournamentMember } from "@/api/tournaments";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      members: vi.fn(),
      updateMember: vi.fn(),
      invite: vi.fn(),
    },
  };
});

const baseMembers: TournamentMember[] = [
  {
    id: "m-admin",
    user_id: "u-admin",
    email: "admin@example.com",
    full_name: "Ada Admin",
    role: "admin",
    status: "active",
    assigned_at: "2026-05-01T10:00:00Z",
  },
  {
    id: "m-scorer",
    user_id: "u-scorer",
    email: "scorer@example.com",
    full_name: "Sam Scorer",
    role: "match_scorer",
    status: "active",
    assigned_at: "2026-05-02T10:00:00Z",
  },
];

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/tournaments/t1/members"]}>
          <Routes>
            <Route
              path="/tournaments/:id/members"
              element={<TournamentMembersPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  // Desktop width so the table (not mobile cards) renders.
  window.innerWidth = 1280;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("TournamentMembersPage", () => {
  it("renders the roster from the members endpoint", async () => {
    vi.mocked(tournamentsApi.members).mockResolvedValue(baseMembers);

    renderPage();

    expect(await screen.findByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("scorer@example.com")).toBeInTheDocument();
    expect(tournamentsApi.members).toHaveBeenCalledWith("t1");
  });

  it("changing a role calls updateMember with the membership id + new role", async () => {
    vi.mocked(tournamentsApi.members).mockResolvedValue(baseMembers);
    vi.mocked(tournamentsApi.updateMember).mockResolvedValue({
      ...baseMembers[1],
      role: "referee",
    });

    renderPage();

    await screen.findByText("scorer@example.com");

    // Open the scorer row's role Select and choose Referee.
    await userEvent.click(
      screen.getByRole("button", { name: /role for sam scorer/i }),
    );
    await userEvent.click(screen.getByRole("option", { name: /^referee$/i }));

    await waitFor(() =>
      expect(tournamentsApi.updateMember).toHaveBeenCalledWith("t1", "m-scorer", {
        role: "referee",
      }),
    );
  });

  it("revoking a member confirms then calls updateMember with status:revoked", async () => {
    vi.mocked(tournamentsApi.members).mockResolvedValue(baseMembers);
    vi.mocked(tournamentsApi.updateMember).mockResolvedValue({
      ...baseMembers[1],
      status: "revoked",
    });

    renderPage();

    await screen.findByText("scorer@example.com");

    // Click the scorer row's Revoke button → opens the confirm dialog.
    await userEvent.click(screen.getByTestId("revoke-m-scorer"));

    const dialog = await screen.findByRole("dialog", { name: /revoke member/i });
    await userEvent.click(
      within(dialog).getByTestId("confirm-revoke"),
    );

    await waitFor(() =>
      expect(tournamentsApi.updateMember).toHaveBeenCalledWith("t1", "m-scorer", {
        status: "revoked",
      }),
    );
  });

  it("surfaces the last_admin guard as a clear error toast", async () => {
    const { ApiError } = await import("@/types/api");
    vi.mocked(tournamentsApi.members).mockResolvedValue(baseMembers);
    vi.mocked(tournamentsApi.updateMember).mockRejectedValue(
      new ApiError(400, { detail: "last_admin" }),
    );

    renderPage();

    await screen.findByText("admin@example.com");

    // Try to revoke the sole admin → backend rejects with last_admin.
    await userEvent.click(screen.getByTestId("revoke-m-admin"));
    const dialog = await screen.findByRole("dialog", { name: /revoke member/i });
    await userEvent.click(within(dialog).getByTestId("confirm-revoke"));

    expect(
      await screen.findByText(/can't remove the last admin/i),
    ).toBeInTheDocument();
  });

  it("inviting by email calls invite with email + role + an event_id", async () => {
    vi.mocked(tournamentsApi.members).mockResolvedValue(baseMembers);
    vi.mocked(tournamentsApi.invite).mockResolvedValue({
      id: "inv1",
      email: "new@example.com",
      role: "team_manager",
      tournament_id: "t1",
      status: "pending",
    });

    renderPage();

    await screen.findByText("admin@example.com");

    // Inviting lives in the right-side drawer now.
    await userEvent.click(screen.getByTestId("open-invite-drawer"));
    await userEvent.type(
      await screen.findByTestId("invite-email"),
      "new@example.com",
    );
    await userEvent.click(screen.getByTestId("invite-submit"));

    await waitFor(() => expect(tournamentsApi.invite).toHaveBeenCalled());
    const [tid, payload] = vi.mocked(tournamentsApi.invite).mock.calls[0];
    expect(tid).toBe("t1");
    expect(payload.email).toBe("new@example.com");
    expect(payload.role).toBe("team_manager");
    expect(payload.event_id).toBeTruthy();
  });

  it("groups a person's multiple roles into one row and counts people", async () => {
    // Same user_id holding two roles (e.g. created the tournament → admin, then
    // accepted a team-manager invite) must render as ONE person, not two rows.
    const multiRole: TournamentMember[] = [
      {
        id: "m-banki-admin",
        user_id: "u-banki",
        email: "banki@example.com",
        full_name: "Bankithung",
        role: "admin",
        status: "active",
        assigned_at: "2026-06-08T10:00:00Z",
      },
      {
        id: "m-banki-tm",
        user_id: "u-banki",
        email: "banki@example.com",
        full_name: "Bankithung",
        role: "team_manager",
        status: "active",
        assigned_at: "2026-06-08T11:00:00Z",
      },
      {
        id: "m-scorer",
        user_id: "u-scorer",
        email: "scorer@example.com",
        full_name: "Sam Scorer",
        role: "match_scorer",
        status: "active",
        assigned_at: "2026-06-09T10:00:00Z",
      },
    ];
    vi.mocked(tournamentsApi.members).mockResolvedValue(multiRole);

    renderPage();

    await screen.findByText("banki@example.com");
    // One row per person → the email appears once, not once per role.
    expect(screen.getAllByText("banki@example.com")).toHaveLength(1);
    // Two distinct people, not three membership rows.
    expect(screen.getByTestId("members-count")).toHaveTextContent(
      "2members",
    );
    // Both of Bankithung's roles are present as editable controls...
    expect(
      screen.getAllByRole("button", { name: /role for bankithung/i }),
    ).toHaveLength(2);
    // ...each independently removable by membership id.
    expect(screen.getByTestId("revoke-m-banki-admin")).toBeInTheDocument();
    expect(screen.getByTestId("revoke-m-banki-tm")).toBeInTheDocument();
  });
});
