import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    expect(first).toHaveTextContent("admin@example.com");
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
      limit: 50,
    });
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
        limit: 50,
      }),
    );
  });

  it("loads more by raising the limit when a full page came back", async () => {
    vi.mocked(tournamentsApi.scheduleChanges).mockResolvedValue({
      results: Array.from({ length: 50 }, (_, i) =>
        entry({ match_id: `m${i}`, batch_id: `b${i}` }),
      ),
    });
    mount();
    expect(await screen.findByTestId("changes-load-more")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("changes-load-more"));
    await waitFor(() =>
      expect(tournamentsApi.scheduleChanges).toHaveBeenLastCalledWith("t1", {
        limit: 100,
      }),
    );
  });

  it("shows an empty state when nothing changed yet", async () => {
    vi.mocked(tournamentsApi.scheduleChanges).mockResolvedValue({ results: [] });
    mount();
    expect(
      await screen.findByText(/No schedule changes yet/),
    ).toBeInTheDocument();
  });
});
