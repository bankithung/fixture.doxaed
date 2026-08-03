import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type ControlRoomMatch } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { courtLabel } from "@/lib/courts";
import { AssignDrawer } from "../AssignDrawer";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      members: vi.fn(),
      assignOfficial: vi.fn(),
      removeOfficial: vi.fn(),
      assignScorer: vi.fn(),
      venues: vi.fn(),
      rescheduleMatch: vi.fn(),
    },
  };
});

const MATCH = {
  id: "m1",
  stage: "group",
  group_label: "Group A",
  round_no: 1,
  match_no: 1,
  status: "scheduled",
  home_team: { id: "th", name: "Alpha", short_name: "ALP" },
  away_team: { id: "ta", name: "Bravo", short_name: "BRA" },
  home_score: null,
  away_score: null,
  sport: "",
  set_scores: [],
  leaf_key: "football.u15",
  venue: "Main",
  scoring: null,
  scheduled_at: "2026-06-20T03:30:00Z",
  locked_at: null,
  leaf_label: "Football U15",
  scorer: null,
  officials: [
    { id: "o1", user_id: "u9", name: "Ref Roy", role: "referee", status: "assigned" },
  ],
} as ControlRoomMatch;

function mount(match: ControlRoomMatch = MATCH) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AssignDrawer tournamentId="t1" match={match} onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client, invalidate };
}

/** A client-side timeout/abort: no response arrived, but the server may have
 * committed the write anyway (production bug, 2026-08). */
function timeoutError(): Error {
  return Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
}

/** Pick "Alice" in the add-an-official person combobox. */
async function pickAlice(): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: /person/i }));
  await userEvent.click(await screen.findByRole("option", { name: /alice/i }));
}

function officialEventId(call: number): string {
  return vi.mocked(tournamentsApi.assignOfficial).mock.calls[call]![1].event_id;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.members).mockResolvedValue([
    {
      id: "mem1",
      user_id: "u1",
      email: "alice@x.io",
      full_name: "Alice",
      role: "referee",
      status: "active",
      assigned_at: "2026-06-01T00:00:00Z",
    },
  ]);
  vi.mocked(tournamentsApi.assignOfficial).mockResolvedValue({
    officials: MATCH.officials,
    warning: null,
  });
  vi.mocked(tournamentsApi.removeOfficial).mockResolvedValue({ officials: [] });
  vi.mocked(tournamentsApi.venues).mockResolvedValue({
    venues: [
      { id: "v1", name: "Main", venue_type: "", windows: [], count: 2 },
      { id: "v2", name: "Hall", venue_type: "", windows: [], count: 1 },
    ],
  });
  vi.mocked(tournamentsApi.rescheduleMatch).mockResolvedValue({
    match: MATCH,
    violations: [],
  });
});

describe("AssignDrawer", () => {
  it("lists current officials and assigns a new one", async () => {
    mount();
    // Existing official shows.
    expect(within(screen.getByTestId("official-o1")).getByText("Ref Roy")).toBeInTheDocument();

    // Pick a person (role defaults to referee) and add.
    await userEvent.click(await screen.findByRole("button", { name: /person/i }));
    await userEvent.click(await screen.findByRole("option", { name: /alice/i }));
    await userEvent.click(screen.getByTestId("add-official"));

    await waitFor(() =>
      expect(tournamentsApi.assignOfficial).toHaveBeenCalledWith(
        "m1",
        expect.objectContaining({ user_id: "u1", role: "referee" }),
      ),
    );
  });

  it("removes an official", async () => {
    mount();
    await userEvent.click(
      within(screen.getByTestId("official-o1")).getByRole("button", {
        name: /remove/i,
      }),
    );
    await waitFor(() =>
      expect(tournamentsApi.removeOfficial).toHaveBeenCalledWith("m1", "o1"),
    );
  });

  it("assigns the scorer seat with an idempotency key", async () => {
    vi.mocked(tournamentsApi.assignScorer).mockResolvedValue(MATCH);
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /^scorer$/i }));
    await userEvent.click(await screen.findByRole("option", { name: /alice/i }));
    await waitFor(() =>
      expect(tournamentsApi.assignScorer).toHaveBeenCalledWith(
        "m1",
        "u1",
        expect.any(String),
      ),
    );
    // Non-empty: the server keys the replay off it (invariant 3).
    expect(
      vi.mocked(tournamentsApi.assignScorer).mock.calls[0]![2],
    ).toBeTruthy();
  });

  it("reuses the scorer event id when the same seat change is retried", async () => {
    vi.mocked(tournamentsApi.assignScorer).mockRejectedValue(
      new ApiError(500, { detail: "server_error" }),
    );
    mount();
    const open = async () =>
      userEvent.click(await screen.findByRole("button", { name: /^scorer$/i }));

    await open();
    await userEvent.click(await screen.findByRole("option", { name: /alice/i }));
    await waitFor(() =>
      expect(tournamentsApi.assignScorer).toHaveBeenCalledTimes(1),
    );
    await open();
    await userEvent.click(await screen.findByRole("option", { name: /alice/i }));
    await waitFor(() =>
      expect(tournamentsApi.assignScorer).toHaveBeenCalledTimes(2),
    );

    const calls = vi.mocked(tournamentsApi.assignScorer).mock.calls;
    expect(calls[1]![2]).toBe(calls[0]![2]);
  });

  it("assigns a specific court via the reschedule path", async () => {
    mount();
    // The 2-court "Main" venue expands to two courts; pick the second.
    await userEvent.click(await screen.findByRole("button", { name: /^court$/i }));
    await userEvent.click(
      await screen.findByRole("option", { name: courtLabel("Main", 2) }),
    );
    await waitFor(() =>
      expect(tournamentsApi.rescheduleMatch).toHaveBeenCalledWith(
        "m1",
        expect.objectContaining({ venue: courtLabel("Main", 2) }),
      ),
    );
    // First attempt is unforced.
    expect(tournamentsApi.rescheduleMatch).toHaveBeenCalledWith(
      "m1",
      expect.not.objectContaining({ force: true }),
    );
  });

  it("surfaces a court clash and forces past it with the same event id", async () => {
    const conflict = new ApiError(409, {
      detail: "schedule_conflicts",
      violations: [
        { code: "court_capacity_exceeded", hard: true, venue: "Main", capacity: 2 },
      ],
    });
    vi.mocked(tournamentsApi.rescheduleMatch)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ match: MATCH, violations: [] });

    mount();
    await userEvent.click(await screen.findByRole("button", { name: /^court$/i }));
    await userEvent.click(
      await screen.findByRole("option", { name: courtLabel("Main", 2) }),
    );

    // The clash renders with a localized title and a force affordance.
    expect(await screen.findByTestId("court-force")).toBeInTheDocument();
    expect(
      screen.getByTestId("repair-violation-court_capacity_exceeded"),
    ).toBeInTheDocument();

    const firstEventId = vi.mocked(tournamentsApi.rescheduleMatch).mock.calls[0][1]
      .event_id;
    await userEvent.click(screen.getByTestId("court-force"));
    await waitFor(() =>
      expect(tournamentsApi.rescheduleMatch).toHaveBeenCalledWith(
        "m1",
        expect.objectContaining({
          venue: courtLabel("Main", 2),
          force: true,
          event_id: firstEventId,
        }),
      ),
    );
  });

  it("keeps the court event id when the same court is retried after a timeout", async () => {
    vi.mocked(tournamentsApi.rescheduleMatch).mockRejectedValue(timeoutError());
    const { invalidate } = mount();

    const pickSecondCourt = async () => {
      await userEvent.click(await screen.findByRole("button", { name: /^court$/i }));
      await userEvent.click(
        await screen.findByRole("option", { name: courtLabel("Main", 2) }),
      );
    };
    await pickSecondCourt();
    await waitFor(() =>
      expect(tournamentsApi.rescheduleMatch).toHaveBeenCalledTimes(1),
    );

    // Timeout is not a failure: the honest message, and a refresh.
    expect(await screen.findByText(/Still assigning/i)).toBeInTheDocument();
    expect(screen.queryByText(/Could not assign the court/i)).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["t-control-room", "t1"],
    });

    await pickSecondCourt();
    await waitFor(() =>
      expect(tournamentsApi.rescheduleMatch).toHaveBeenCalledTimes(2),
    );
    const calls = vi.mocked(tournamentsApi.rescheduleMatch).mock.calls;
    expect(calls[1]![1].event_id).toBe(calls[0]![1].event_id);
  });

  it("retries the same official with the same event id, and mints a new one when the intent changes", async () => {
    vi.mocked(tournamentsApi.assignOfficial).mockRejectedValue(
      new ApiError(500, { detail: "server_error" }),
    );
    mount();
    await pickAlice();

    await userEvent.click(screen.getByTestId("add-official"));
    await waitFor(() =>
      expect(tournamentsApi.assignOfficial).toHaveBeenCalledTimes(1),
    );

    // Same person + role, pressed again → replayable.
    await userEvent.click(screen.getByTestId("add-official"));
    await waitFor(() =>
      expect(tournamentsApi.assignOfficial).toHaveBeenCalledTimes(2),
    );
    expect(officialEventId(1)).toBe(officialEventId(0));

    // Different role → a different write.
    await userEvent.click(screen.getByRole("button", { name: /^role$/i }));
    await userEvent.click(
      await screen.findByRole("option", { name: /assistant referee/i }),
    );
    await userEvent.click(screen.getByTestId("add-official"));
    await waitFor(() =>
      expect(tournamentsApi.assignOfficial).toHaveBeenCalledTimes(3),
    );
    expect(officialEventId(2)).not.toBe(officialEventId(0));
  });

  it("reports a timed-out official assignment as still running, and refreshes", async () => {
    vi.mocked(tournamentsApi.assignOfficial).mockRejectedValue(timeoutError());
    const { invalidate } = mount();
    await pickAlice();
    invalidate.mockClear();

    await userEvent.click(screen.getByTestId("add-official"));

    expect(await screen.findByText(/Still assigning/i)).toBeInTheDocument();
    expect(screen.getByText(/Refreshing to show the result/i)).toBeInTheDocument();
    expect(screen.queryByText(/Could not assign the official/i)).toBeNull();
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: ["t-control-room", "t1"],
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["t-members", "t1"] });
  });

  it("still shows a hard error when the server actually refuses", async () => {
    vi.mocked(tournamentsApi.assignOfficial).mockRejectedValue(
      new ApiError(403, { detail: "not_permitted" }),
    );
    mount();
    await pickAlice();
    await userEvent.click(screen.getByTestId("add-official"));

    expect(
      await screen.findByText(/Could not assign the official/i),
    ).toBeInTheDocument();
    expect(screen.getByText("not_permitted")).toBeInTheDocument();
    expect(screen.queryByText(/Still assigning/i)).toBeNull();
  });
});
