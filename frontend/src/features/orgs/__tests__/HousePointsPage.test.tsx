import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { HousePointsPage } from "../HousePointsPage";
import { useAuthStore } from "@/features/auth/authStore";
import { api } from "@/api/client";

/**
 * The houses api (`@/api/houses`) is exercised for real on top of a mocked
 * transport (`api.get`/`api.post` spies, the OrgSettingsPage pattern) so the
 * event_id minting inside `housesApi.awardPoints`/`recordMeetResult` is
 * covered by the assertions below.
 */

const ORG_ID = "22222222-2222-7222-8222-222222222222";
const SEASON_ID = "33333333-3333-7333-8333-333333333333";
const RED_ID = "44444444-4444-7444-8444-444444444444";
const BLUE_ID = "55555555-5555-7555-8555-555555555555";

const season = {
  id: SEASON_ID,
  label: "2026-27",
  starts_on: null,
  ends_on: null,
  is_current: true,
};

const groups = [
  { id: BLUE_ID, name: "Blue House", kind: "house", colour: "blue" },
  { id: RED_ID, name: "Red House", kind: "house", colour: "red" },
];

const table = [
  {
    group_id: RED_ID,
    name: "Red House",
    kind: "house",
    colour: "red",
    points: 24,
    entries: 3,
  },
  {
    group_id: BLUE_ID,
    name: "Blue House",
    kind: "house",
    colour: "blue",
    points: 10,
    entries: 2,
  },
];

function makeUser(roles: string[], isOwner: boolean): Record<string, unknown> {
  return {
    id: "u1",
    email: "ops@grace.test",
    name: "Ops User",
    is_superuser: false,
    has_2fa_enrolled: false,
    twofa_enrolled_at: null,
    email_verified_at: "2026-01-01T00:00:00Z",
    last_active_org_id: ORG_ID,
    last_active_org_slug: "grace",
    memberships: [
      {
        org_id: ORG_ID,
        org_slug: "grace",
        org_name: "Grace School",
        roles,
        is_org_owner: isOwner,
        effective_modules: [],
      },
    ],
    deleted_at: null,
  };
}

function mockReads(): void {
  vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path === `/api/orgs/${ORG_ID}/seasons/`) {
      return Promise.resolve({ seasons: [season] });
    }
    if (path === `/api/orgs/${ORG_ID}/seasons/${SEASON_ID}/house-table/`) {
      return Promise.resolve({ season, table });
    }
    if (path === `/api/orgs/${ORG_ID}/seasons/${SEASON_ID}/groups/`) {
      return Promise.resolve({ groups });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

function renderPage(): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/o/grace/houses"]}>
          <Routes>
            <Route path="/o/:orgSlug/houses" element={<HousePointsPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAuthStore.setState({
    user: makeUser(["admin"], true),
    bootstrapped: true,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.getState().clear();
});

describe("HousePointsPage", () => {
  it("renders the house table ranked, with points and entries", async () => {
    mockReads();
    renderPage();

    const list = await screen.findByTestId("house-table");
    expect(list).toBeInTheDocument();

    // Rank order is the API order (winner first).
    const first = within(list).getByTestId("house-row-0");
    const second = within(list).getByTestId("house-row-1");
    expect(first).toHaveTextContent("Red House");
    expect(first).toHaveTextContent("24");
    expect(second).toHaveTextContent("Blue House");
    expect(second).toHaveTextContent("10");
    expect(within(list).getByTestId("house-points-0")).toHaveTextContent("24");
    expect(within(list).getByTestId("house-points-1")).toHaveTextContent("10");
    expect(first).toHaveTextContent("3 entries");
  });

  it("award points posts group_id, points, and reason with an event_id", async () => {
    mockReads();
    const postSpy = vi
      .spyOn(api, "post")
      .mockResolvedValue({ id: "e1", points: 15, group_id: RED_ID });
    renderPage();

    await screen.findByTestId("house-table");
    const form = screen.getByTestId("award-form");

    // Pick "Red House" in the custom listbox.
    await userEvent.click(
      within(form).getByRole("button", { name: /house/i }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /red house/i }),
    );
    await userEvent.type(screen.getByTestId("award-points"), "15");
    await userEvent.type(
      screen.getByTestId("award-reason"),
      "March past winners",
    );
    await userEvent.click(screen.getByTestId("award-submit"));

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const [path, body] = postSpy.mock.calls[0] as [
      string,
      {
        group_id: string;
        points: number;
        reason: string;
        event_id?: string;
      },
    ];
    expect(path).toBe(
      `/api/orgs/${ORG_ID}/seasons/${SEASON_ID}/house-points/`,
    );
    expect(body.group_id).toBe(RED_ID);
    expect(body.points).toBe(15);
    expect(body.reason).toBe("March past winners");
    expect(typeof body.event_id).toBe("string");
    expect(body.event_id?.length).toBeGreaterThan(0);
  });

  it("meet result posts ordered placements, winner first, with an event_id", async () => {
    mockReads();
    const postSpy = vi
      .spyOn(api, "post")
      .mockResolvedValue({ entries: 2, table });
    renderPage();

    await screen.findByTestId("house-table");
    await userEvent.type(screen.getByTestId("meet-event"), "100m boys U14");
    await userEvent.click(screen.getByTestId("meet-relay"));

    // Blue wins, Red second — the click order IS the finishing order.
    await userEvent.click(screen.getByTestId(`place-add-${BLUE_ID}`));
    await userEvent.click(screen.getByTestId(`place-add-${RED_ID}`));

    const placed = screen.getByTestId("placements-list");
    const items = within(placed).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("1st");
    expect(items[0]).toHaveTextContent("Blue House");
    expect(items[1]).toHaveTextContent("2nd");
    expect(items[1]).toHaveTextContent("Red House");

    await userEvent.click(screen.getByTestId("meet-submit"));

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    const [path, body] = postSpy.mock.calls[0] as [
      string,
      {
        event_label: string;
        placements: string[];
        relay: boolean;
        event_id?: string;
      },
    ];
    expect(path).toBe(
      `/api/orgs/${ORG_ID}/seasons/${SEASON_ID}/meet-results/`,
    );
    expect(body.event_label).toBe("100m boys U14");
    expect(body.placements).toEqual([BLUE_ID, RED_ID]);
    expect(body.relay).toBe(true);
    expect(typeof body.event_id).toBe("string");

    // Success surfaces the landed-entries toast.
    await screen.findByText(/2 point entries landed/i);
  });

  it("reorder: move-up swaps a placement toward the front", async () => {
    mockReads();
    renderPage();

    await screen.findByTestId("house-table");
    await userEvent.click(screen.getByTestId(`place-add-${BLUE_ID}`));
    await userEvent.click(screen.getByTestId(`place-add-${RED_ID}`));
    await userEvent.click(
      screen.getByRole("button", { name: /move up red house/i }),
    );

    const items = within(
      screen.getByTestId("placements-list"),
    ).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Red House");
    expect(items[1]).toHaveTextContent("Blue House");
  });

  it("non-manager sees the table but no write panels", async () => {
    useAuthStore.setState({
      user: makeUser(["team_manager"], false),
      bootstrapped: true,
    } as never);
    mockReads();
    renderPage();

    await screen.findByTestId("house-table");
    expect(screen.getByTestId("house-row-0")).toHaveTextContent("Red House");

    expect(screen.queryByTestId("award-form")).not.toBeInTheDocument();
    expect(screen.queryByTestId("meet-form")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-house-form")).not.toBeInTheDocument();
    expect(screen.queryByTestId("new-season")).not.toBeInTheDocument();
  });

  it("day zero: no seasons offers the create-first-season CTA and dialog", async () => {
    vi.spyOn(api, "get").mockImplementation((path: string) => {
      if (path === `/api/orgs/${ORG_ID}/seasons/`) {
        return Promise.resolve({ seasons: [] });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    const postSpy = vi.spyOn(api, "post").mockResolvedValue({
      ...season,
      label: "2027-28",
    });
    renderPage();

    const cta = await screen.findByTestId("create-first-season");
    await userEvent.click(cta);
    await userEvent.type(screen.getByTestId("season-label"), "2027-28");
    await userEvent.click(screen.getByTestId("season-submit"));

    await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
    expect(postSpy).toHaveBeenCalledWith(`/api/orgs/${ORG_ID}/seasons/`, {
      label: "2027-28",
      is_current: true,
    });
  });
});
