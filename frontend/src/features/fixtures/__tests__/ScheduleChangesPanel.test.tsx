import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  tournamentsApi,
  type ScheduleChangeEntry,
} from "@/api/tournaments";
import { ScheduleChangesPanel } from "../ScheduleChangesPanel";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      scheduleChanges: vi.fn(),
    },
  };
});

function entry(over: Partial<ScheduleChangeEntry>): ScheduleChangeEntry {
  return {
    match_id: "m1",
    match_label: "Alpha vs Bravo",
    leaf_key: "football.u15",
    changed_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    actor: { id: "u1", email: "admin@example.com" },
    kind: "rescheduled",
    old: { scheduled_at: "2026-06-20T09:00:00+05:30", venue: "Main" },
    new: { scheduled_at: "2026-06-21T10:00:00+05:30", venue: "Side" },
    reason: "",
    batch_id: "b1",
    ...over,
  };
}

const COMPETITIONS = [
  { leafKey: "football.u15", label: "Football · U15" },
  { leafKey: "football.u17", label: "Football · U17" },
];

/** The full Change history page: a table, one row per change, no collapsing. */
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ScheduleChangesPanel tournamentId="t1" competitions={COMPETITIONS} />
    </QueryClientProvider>,
  );
}

/** The Today board's tab: a short tail that collapses bulk actions. */
function mountTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ScheduleChangesPanel
          tournamentId="t1"
          competitions={COMPETITIONS}
          embedded
          viewAllTo="/tournaments/t1/changes"
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.scheduleChanges).mockResolvedValue({
    results: [
      entry({}),
      entry({
        match_id: "m2", match_label: "Carol vs Delta", kind: "locked",
        old: null, new: null, batch_id: "b2",
        changed_at: new Date(Date.now() - 3 * 86400_000).toISOString(),
        reason: "Finals stay on centre court",
      }),
    ],
  });
});

describe("ScheduleChangesPanel", () => {
  it("renders the feed: kind chip, old → new slots, actor and relative time", async () => {
    mount();
    const first = await screen.findByTestId("change-b1-m1");
    expect(first).toHaveTextContent("Moved");
    expect(first).toHaveTextContent("Alpha vs Bravo");
    expect(first).toHaveTextContent("admin");
    expect(first).toHaveTextContent("2h ago");
    expect(first).toHaveTextContent("Main");
    expect(first).toHaveTextContent("Side");

    // lock entries: chip + reason, but no old→new line (slot did not move)
    const second = screen.getByTestId("change-b2-m2");
    expect(second).toHaveTextContent("Locked");
    expect(second).toHaveTextContent("3d ago");
    expect(second).toHaveTextContent("Finals stay on centre court");
    expect(second).not.toHaveTextContent("unscheduled");

    expect(tournamentsApi.scheduleChanges).toHaveBeenCalledWith("t1", {
      limit: 20,
    });
  });

  const flood = () =>
    vi.mocked(tournamentsApi.scheduleChanges).mockResolvedValue({
      results: Array.from({ length: 5 }, (_, i) =>
        entry({
          match_id: `m${i}`,
          batch_id: `b${i}`,
          match_label: `Match ${i}`,
          kind: "engine_rerun",
          old: null,
        }),
      ),
      total: 5,
    });

  it("the Today tab lists every change of its tail, collapsing nothing", async () => {
    // 5 first-time placements (old = unscheduled) by one actor in one spree.
    flood();
    mountTab();

    // First placements read as "Scheduled", not "Re-scheduled".
    await screen.findByTestId("change-b0-m0");
    expect(screen.getAllByText("Scheduled").length).toBe(5);
    expect(screen.queryByText("Re-scheduled")).not.toBeInTheDocument();

    // All five are on screen; no burst header, no expander to click.
    for (let i = 0; i < 5; i += 1) {
      expect(screen.getByTestId(`change-b${i}-m${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(screen.queryByText("5 matches")).toBeNull();

    // No user-facing arrows anywhere in the feed.
    expect(document.body.textContent).not.toMatch(/[\u2192]/);
  });

  it("the full page never collapses: every change is its own table row", async () => {
    flood();
    mount();

    // All five rows are on screen at once, no expander to click.
    await screen.findByTestId("change-b0-m0");
    for (let i = 0; i < 5; i += 1) {
      expect(screen.getByTestId(`change-b${i}-m${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();

    // It is a real table: one row per change, under column headers.
    expect(
      screen.getByRole("columnheader", { name: "Match" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("change-b0-m0").tagName).toBe("TR");
    expect(screen.getAllByRole("row").length).toBeGreaterThanOrEqual(5);
  });

  it("filters by competition leaf", async () => {
    mount();
    await screen.findByTestId("change-b1-m1");
    await userEvent.click(
      screen.getByRole("button", { name: "Filter by competition" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Football · U17" }));
    await waitFor(() =>
      expect(tournamentsApi.scheduleChanges).toHaveBeenLastCalledWith("t1", {
        leafKey: "football.u17",
        limit: 20,
      }),
    );
  });

  it("pages the full feed 20 at a time with Prev/Next", async () => {
    vi.mocked(tournamentsApi.scheduleChanges).mockResolvedValue({
      results: Array.from({ length: 20 }, (_, i) =>
        entry({ match_id: `m${i}`, batch_id: `b${i}` }),
      ),
      total: 45,
    });
    mount();

    // Page 1 of 3: Prev is dead, Next walks forward by an offset of 20.
    expect(await screen.findByTestId("changes-page-status")).toHaveTextContent(
      "1 to 20 of 45",
    );
    expect(screen.getByTestId("changes-prev")).toBeDisabled();

    await userEvent.click(screen.getByTestId("changes-next"));
    await waitFor(() =>
      expect(tournamentsApi.scheduleChanges).toHaveBeenLastCalledWith("t1", {
        limit: 20,
        offset: 20,
      }),
    );
    expect(screen.getByTestId("changes-prev")).not.toBeDisabled();

    // The last page stops: 45 entries is three pages, no fourth.
    await userEvent.click(screen.getByTestId("changes-next"));
    await waitFor(() =>
      expect(tournamentsApi.scheduleChanges).toHaveBeenLastCalledWith("t1", {
        limit: 20,
        offset: 40,
      }),
    );
    expect(screen.getByTestId("changes-next")).toBeDisabled();
  });

  it("the embedded tab shows the latest 15 and links out to the full page", async () => {
    mountTab();

    expect(await screen.findByTestId("changes-view-all")).toHaveAttribute(
      "href",
      "/tournaments/t1/changes",
    );
    expect(tournamentsApi.scheduleChanges).toHaveBeenCalledWith("t1", {
      limit: 15,
    });
    // No inline pager in the tab — "View all" is the only way deeper.
    expect(screen.queryByTestId("changes-next")).toBeNull();
  });

  it("shows an empty state when nothing changed yet", async () => {
    vi.mocked(tournamentsApi.scheduleChanges).mockResolvedValue({ results: [] });
    mount();
    expect(
      await screen.findByText(/No changes yet. Any match you move or delay will show up here./),
    ).toBeInTheDocument();
  });
});
