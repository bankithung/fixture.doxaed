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

  it("collapses a publish flood into one Scheduled burst with an expander", async () => {
    // 5 first-time placements (old = unscheduled) by one actor in one spree.
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
    });
    mount();
    // First placements read as "Scheduled", not "Re-scheduled".
    const chip = await screen.findByText("Scheduled");
    // The flood collapses into ONE burst item headed by its count.
    expect(chip.closest("li")).toHaveTextContent("5 matches");
    expect(screen.queryByText("Re-scheduled")).not.toBeInTheDocument();
    // Preview shows 3; the expander reveals the rest.
    expect(screen.getByTestId("change-b0-m0")).toBeInTheDocument();
    expect(screen.queryByTestId("change-b4-m4")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all 5" }));
    expect(screen.getByTestId("change-b4-m4")).toBeInTheDocument();
    // No user-facing arrows anywhere in the feed.
    expect(document.body.textContent).not.toMatch(/[\u2192]/);
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
