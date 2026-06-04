import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { MemberDirectoryPage } from "../MemberDirectoryPage";
import { useAuthStore } from "@/features/auth/authStore";
import { orgsApi, type OrgMember } from "@/api/orgs";
import type { User } from "@/types/user";

const baseUser: User = {
  id: "u1",
  email: "owner@example.com",
  name: "Org Owner",
  is_superuser: false,
  has_2fa_enrolled: false,
  twofa_enrolled_at: null,
  email_verified_at: "2025-01-01T00:00:00Z",
  last_active_org_id: "o1",
  last_active_org_slug: "acme",
  deleted_at: null,
  memberships: [
    {
      org_id: "o1",
      org_slug: "acme",
      org_name: "Acme",
      roles: ["admin"],
      is_org_owner: true,
      effective_modules: ["org.member_directory", "org.settings"],
    },
  ],
};

const sampleMembers: OrgMember[] = [
  {
    id: "mem-1",
    user_id: "u1",
    email: "owner@example.com",
    full_name: "Org Owner",
    roles: ["admin"],
    is_org_owner: true,
    joined_at: "2025-01-15T10:00:00Z",
    is_active: true,
  },
  {
    id: "mem-2",
    user_id: "u2",
    email: "alice@example.com",
    full_name: "Alice Wonderland",
    roles: ["referee", "match_scorer"],
    is_org_owner: false,
    joined_at: "2025-06-01T10:00:00Z",
    is_active: true,
  },
  {
    id: "mem-3",
    user_id: "u3",
    email: "bob@example.com",
    full_name: "Bob Builder",
    roles: ["team_manager"],
    is_org_owner: false,
    joined_at: "2025-09-01T10:00:00Z",
    is_active: true,
  },
];

function renderPage(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/o/acme/members"]}>
          <Routes>
            <Route
              path="/o/:orgSlug/members"
              element={<MemberDirectoryPage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: baseUser, bootstrapped: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clear();
});

describe("MemberDirectoryPage", () => {
  it("renders rows, total count, and role badges", async () => {
    vi.spyOn(orgsApi, "members").mockResolvedValue(sampleMembers);
    vi.spyOn(orgsApi, "invitations").mockResolvedValue([]);

    renderPage();

    // Loading state appears first (skeleton renders 3 placeholder rows).
    expect(screen.getAllByTestId("member-skeleton")).toHaveLength(3);

    const table = await screen.findByTestId("members-table");
    const rows = within(table).getAllByRole("row");
    // header + 3 members
    expect(rows).toHaveLength(4);

    // Total count rendered.
    expect(screen.getByText(/^3 members$/i)).toBeInTheDocument();

    // Owner row carries an owner badge.
    const ownerRow = screen.getByTestId("member-row-u1");
    expect(within(ownerRow).getByTestId("role-badge-owner")).toBeInTheDocument();

    // Alice has referee + match_scorer badges.
    const aliceRow = screen.getByTestId("member-row-u2");
    expect(
      within(aliceRow).getByTestId("role-badge-referee"),
    ).toBeInTheDocument();
    expect(
      within(aliceRow).getByTestId("role-badge-match_scorer"),
    ).toBeInTheDocument();
  });

  it("filters members by search term (name and email)", async () => {
    vi.spyOn(orgsApi, "members").mockResolvedValue(sampleMembers);
    vi.spyOn(orgsApi, "invitations").mockResolvedValue([]);

    renderPage();
    await screen.findByTestId("members-table");

    const search = screen.getByTestId("member-search") as HTMLInputElement;
    await userEvent.type(search, "alice");

    await waitFor(() => {
      expect(screen.queryByTestId("member-row-u3")).toBeNull();
    });
    expect(screen.getByTestId("member-row-u2")).toBeInTheDocument();

    // Email substring also matches.
    await userEvent.clear(search);
    await userEvent.type(search, "bob@");
    await waitFor(() => {
      expect(screen.queryByTestId("member-row-u2")).toBeNull();
    });
    expect(screen.getByTestId("member-row-u3")).toBeInTheDocument();
  });

  it("shows the no-permission card when org.member_directory is missing", () => {
    useAuthStore.setState({
      user: {
        ...baseUser,
        memberships: [
          {
            ...baseUser.memberships[0],
            roles: ["team_manager"],
            is_org_owner: false,
            effective_modules: [],
          },
        ],
      },
      bootstrapped: true,
    });
    const spy = vi.spyOn(orgsApi, "members");

    renderPage();

    expect(screen.getByTestId("no-permission")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("renders a retry-able error state on fetch failure", async () => {
    const spy = vi
      .spyOn(orgsApi, "members")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(sampleMembers);
    vi.spyOn(orgsApi, "invitations").mockResolvedValue([]);

    renderPage();

    const retryBtn = await screen.findByTestId("members-retry");
    expect(screen.getByRole("alert")).toHaveTextContent(/failed/i);

    await userEvent.click(retryBtn);

    await screen.findByTestId("members-table");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("hides the invite button when the user cannot manage", () => {
    useAuthStore.setState({
      user: {
        ...baseUser,
        memberships: [
          {
            ...baseUser.memberships[0],
            roles: ["referee"],
            is_org_owner: false,
            effective_modules: ["org.member_directory"],
          },
        ],
      },
      bootstrapped: true,
    });
    vi.spyOn(orgsApi, "members").mockResolvedValue(sampleMembers);
    vi.spyOn(orgsApi, "invitations").mockResolvedValue([]);

    renderPage();

    expect(screen.queryByTestId("invite-button")).toBeNull();
  });

  it("renders the empty state when there are zero members", async () => {
    vi.spyOn(orgsApi, "members").mockResolvedValue([]);
    vi.spyOn(orgsApi, "invitations").mockResolvedValue([]);

    renderPage();

    await screen.findByText(/no members yet/i);
    expect(screen.getByText(/invite a member/i)).toBeInTheDocument();
  });

  it("accepts a paginated members envelope", async () => {
    vi.spyOn(orgsApi, "members").mockResolvedValue({
      count: sampleMembers.length,
      next: null,
      previous: null,
      results: sampleMembers,
    });
    vi.spyOn(orgsApi, "invitations").mockResolvedValue([]);

    renderPage();

    const table = await screen.findByTestId("members-table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
  });
});
