import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrgChooserPage } from "../OrgChooserPage";
import { useAuthStore } from "@/features/auth/authStore";
import { tournamentsApi, type Tournament } from "@/api/tournaments";
import { invitationsApi, type MyInvitation } from "@/api/invitations";
import { overviewApi, type Overview } from "@/api/overview";
import type { User } from "@/types/user";

vi.mock("@/api/tournaments", () => ({
  tournamentsApi: { list: vi.fn(), matches: vi.fn() },
}));
vi.mock("@/api/invitations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/invitations")>();
  return {
    ...actual,
    invitationsApi: { ...actual.invitationsApi, myInvitations: vi.fn() },
  };
});
vi.mock("@/api/overview", () => ({
  overviewApi: { get: vi.fn() },
}));

function makeUser(memberships: User["memberships"]): User {
  return {
    id: "u1",
    email: "me@example.com",
    name: "Imna",
    is_superuser: false,
    has_2fa_enrolled: false,
    twofa_enrolled_at: null,
    email_verified_at: null,
    last_active_org_id: null,
    last_active_org_slug: null,
    memberships,
    deleted_at: null,
  };
}

const INVITED_TOURNAMENT: Tournament = {
  id: "t-9",
  slug: "anpsa",
  name: "Anpsa",
  status: "registration_open",
  organization_slug: "ws-9",
  sport_code: null,
  sports: [],
  time_zone: "Asia/Kolkata",
  created_at: "2026-06-10T00:00:00Z",
  origin: "invited",
  my_roles: ["match_scorer"],
};

const PENDING_INVITE: MyInvitation = {
  id: "inv-1",
  email: "me@example.com",
  role: "referee",
  status: "pending",
  organization_name: "Acme Org",
  tournament_id: "t-2",
  tournament_name: "Knockout Cup",
  invited_by_email: "owner@example.com",
  expires_at: "2026-07-01T10:00:00Z",
  created_at: "2026-06-01T10:00:00Z",
};

const todayIso = new Date().toISOString().slice(0, 10);

const OVERVIEW: Overview = {
  totals: {
    tournaments: 2,
    tournaments_live: 1,
    matches: 12,
    matches_completed: 7,
    matches_live: 1,
    matches_today: 3,
    matches_next7: 4,
    teams: 14,
    players: 151,
    institutions: 5,
    goals: 23,
  },
  tournament_status: [
    { status: "live", count: 1 },
    { status: "draft", count: 1 },
  ],
  sports: [
    { key: "football", name: "Football", tournaments: 2, matches: 12 },
  ],
  matches_per_day: [
    { date: todayIso, completed: 1, live: 1, scheduled: 1 },
  ],
  progress: [
    {
      id: "t-9",
      slug: "anpsa",
      name: "Anpsa",
      status: "live",
      total: 10,
      completed: 3,
      live: 1,
      teams: 8,
    },
  ],
  recent_results: [
    {
      match_id: "m-1",
      tournament_id: "t-9",
      tournament_name: "Anpsa",
      home: "Alpha HSS",
      away: "Beta HSS",
      home_score: 2,
      away_score: 1,
      sport: "football",
      ended_at: "2026-07-04T10:00:00Z",
    },
  ],
};

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OrgChooserPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({ user: makeUser([]), bootstrapped: true });
  vi.mocked(tournamentsApi.matches).mockResolvedValue([] as never);
  vi.mocked(overviewApi.get).mockResolvedValue(OVERVIEW);
});

afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clear();
});

describe("OrgChooserPage (Dashboard)", () => {
  it("shows a centered welcome CTA when the user has nothing yet", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([]);
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText("Welcome to Fixture")).toBeInTheDocument();
    const cta = screen.getByRole("link", {
      name: /start your first tournament/i,
    });
    expect(cta).toHaveAttribute("href", "/tournaments/new");
    // Centered both axes: the page root is a flex container centering content.
    const root = screen.getByText("Welcome to Fixture").closest("div.flex.w-full");
    expect(root?.className).toContain("items-center");
    expect(root?.className).toContain("justify-center");
  });

  it("renders the workspace view (KPIs + table) for an invited user — no dead end", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([INVITED_TOURNAMENT]);
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([]);

    renderPage();

    expect(await screen.findAllByText("Anpsa")).not.toHaveLength(0);
    // The individual workspace: KPI strip over everything the user is part of.
    expect(screen.getByTestId("kpi-strip")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-tournament-t-9")).toHaveAttribute(
      "href",
      "/tournaments/t-9",
    );
    // It's a real dashboard now, not the empty state.
    expect(screen.queryByText("Welcome to Fixture")).not.toBeInTheDocument();
  });

  it("renders the analytics overview from /api/me/overview/", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([INVITED_TOURNAMENT]);
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([]);

    renderPage();

    // KPI band carries the cross-tournament totals (count-up lands on the
    // final value immediately: no matchMedia in jsdom counts as reduced).
    const strip = await screen.findByTestId("kpi-strip");
    expect(within(strip).getByText("Tournaments")).toBeInTheDocument();
    expect(within(strip).getByText("14")).toBeInTheDocument(); // teams
    expect(within(strip).getByText("23")).toBeInTheDocument(); // goals
    expect(within(strip).getByText("151 players")).toBeInTheDocument();

    // The bento chart cells render from the same payload.
    expect(screen.getByTestId("overview-activity")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("overview-status")).getByText("Live"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("overview-sports")).getByText("Football"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("overview-progress")).getByText("3/10"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("overview-results")).getByText("2-1"),
    ).toBeInTheDocument();

    // The activity chart ships its WCAG table twin.
    expect(screen.getByText("Matches per day")).toBeInTheDocument();
  });

  it("keeps the dashboard standing when the overview endpoint fails", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([INVITED_TOURNAMENT]);
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([]);
    vi.mocked(overviewApi.get).mockRejectedValue(new Error("boom"));

    renderPage();

    // Table + KPI strip still render; chart cells degrade to a quiet notice.
    expect(await screen.findByTestId("dashboard-tournament-t-9")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-strip")).toBeInTheDocument();
    expect(
      screen.getAllByText("Analytics unavailable right now.").length,
    ).toBeGreaterThan(0);
  });

  it("never surfaces the org/workspace concept, even for workspace owners", async () => {
    // Root pages are individual-level (owner decision 2026-06-11): orgs are a
    // hidden implementation detail — no Workspaces section, no /o/ slugs.
    useAuthStore.setState({
      user: makeUser([
        {
          org_id: "o9",
          org_slug: "test-2",
          org_name: "test",
          roles: ["admin"] as never,
          is_org_owner: true,
          effective_modules: [],
        },
      ]),
      bootstrapped: true,
    });
    vi.mocked(tournamentsApi.list).mockResolvedValue([
      { ...INVITED_TOURNAMENT, id: "t-1", name: "test", origin: "owner", my_roles: ["admin"] },
    ]);
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([]);

    renderPage();

    await screen.findByTestId("dashboard-tournament-t-1");
    expect(screen.queryByText("Workspaces")).not.toBeInTheDocument();
    expect(screen.queryByText(/\/o\/test-2/)).not.toBeInTheDocument();
  });

  it("surfaces a pending-invites callout linking to the inbox", async () => {
    vi.mocked(tournamentsApi.list).mockResolvedValue([]);
    vi.mocked(invitationsApi.myInvitations).mockResolvedValue([
      PENDING_INVITE,
    ]);

    renderPage();

    const callout = await screen.findByTestId("pending-invites-callout");
    expect(callout).toHaveAttribute("href", "/invites");
    expect(callout.textContent).toMatch(/1 pending invitation/i);
  });
});
