import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type MatchRow } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { CompetitionResultCard } from "../CompetitionResultCard";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      venues: vi.fn(),
      rescheduleMatch: vi.fn(),
      delayMatch: vi.fn(),
      lockMatch: vi.fn(),
      unlockMatch: vi.fn(),
      swapSlots: vi.fn(),
    },
  };
});

function match(over: Partial<MatchRow>): MatchRow {
  return {
    id: "m1", stage: "group", group_label: "Group A", round_no: 1, match_no: 1,
    status: "scheduled", home_team: { id: "tm1", name: "Alpha", short_name: "A" },
    away_team: { id: "tm2", name: "Bravo", short_name: "B" },
    home_score: null, away_score: null, sport: "football", set_scores: [],
    leaf_key: "football.u15", venue: "Main Ground", scoring: null,
    scheduled_at: "2026-06-20T09:00:00+05:30", locked_at: null,
    ...over,
  };
}

const MATCHES = [
  match({ id: "m1" }),
  match({
    id: "m2", match_no: 2, scheduled_at: "2026-06-20T11:00:00+05:30",
    home_team: { id: "tm3", name: "Carol", short_name: "C" },
    away_team: { id: "tm4", name: "Delta", short_name: "D" },
  }),
  match({ id: "m3", match_no: 3, status: "completed", home_score: 1, away_score: 0 }),
];

function mount(matches = MATCHES, canRepair = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <CompetitionResultCard
            tournamentId="t1"
            matches={matches}
            canRepair={canRepair}
          />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.venues).mockResolvedValue({
    venues: [
      { id: "v1", name: "Main Ground", venue_type: "field", windows: [], count: 1 },
      { id: "v2", name: "Side Pitch", venue_type: "field", windows: [], count: 1 },
    ],
  });
  vi.mocked(tournamentsApi.rescheduleMatch).mockResolvedValue({
    match: MATCHES[0],
    violations: [],
  });
  vi.mocked(tournamentsApi.delayMatch).mockResolvedValue({
    moved: [
      { match_id: "m1", old: "a", new: "b", venue: "Main Ground" },
      { match_id: "m2", old: "c", new: "d", venue: "Main Ground" },
    ],
    violations: [],
  });
  vi.mocked(tournamentsApi.lockMatch).mockResolvedValue({ match: MATCHES[0] });
  vi.mocked(tournamentsApi.unlockMatch).mockResolvedValue({ match: MATCHES[0] });
  vi.mocked(tournamentsApi.swapSlots).mockResolvedValue({
    match_a: MATCHES[0],
    match_b: MATCHES[1],
    violations: [],
  });
});

describe("MatchRepairControls", () => {
  it("hides the repair menu for viewers and for finished matches", () => {
    mount(MATCHES, false);
    expect(screen.queryByTestId("repair-menu-m1")).toBeNull();
    mount(MATCHES, true);
    expect(screen.getByTestId("repair-menu-m1")).toBeInTheDocument();
    // completed matches never move — no menu even for editors
    expect(screen.queryByTestId("repair-menu-m3")).toBeNull();
  });

  it("Move sends time + venue with an event_id and toasts on success", async () => {
    mount();
    await userEvent.click(screen.getByTestId("repair-menu-m1"));
    await userEvent.click(screen.getByTestId("repair-move-m1"));

    const when = screen.getByTestId("move-when");
    expect(when).toHaveValue("2026-06-20T09:00"); // prefilled wall clock
    await userEvent.clear(when);
    await userEvent.type(when, "2026-06-21T14:30");
    await userEvent.click(screen.getByRole("button", { name: "Venue" }));
    await userEvent.click(screen.getByRole("option", { name: "Side Pitch" }));
    await userEvent.click(screen.getByTestId("move-submit"));

    await waitFor(() =>
      expect(tournamentsApi.rescheduleMatch).toHaveBeenCalledWith("m1", {
        scheduled_at: "2026-06-21T14:30",
        venue: "Side Pitch",
        event_id: expect.any(String),
      }),
    );
    expect(await screen.findByText("Match moved")).toBeInTheDocument();
  });

  it("Move expands a multi-court venue into per-court options", async () => {
    vi.mocked(tournamentsApi.venues).mockResolvedValue({
      venues: [{ id: "v1", name: "Main Ground", venue_type: "field", windows: [], count: 2 }],
    });
    mount();
    await userEvent.click(screen.getByTestId("repair-menu-m1"));
    await userEvent.click(screen.getByTestId("repair-move-m1"));
    await userEvent.click(screen.getByRole("button", { name: "Venue" }));
    // The 2-court venue offers both courts; pick the second.
    expect(screen.getByRole("option", { name: "Main Ground · T1" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("option", { name: "Main Ground · T2" }));
    await userEvent.click(screen.getByTestId("move-submit"));
    await waitFor(() =>
      expect(tournamentsApi.rescheduleMatch).toHaveBeenCalledWith(
        "m1",
        expect.objectContaining({ venue: "Main Ground · T2" }),
      ),
    );
  });

  it("hard conflicts block the move behind a destructive Move it anyway", async () => {
    vi.mocked(tournamentsApi.rescheduleMatch)
      .mockRejectedValueOnce(
        new ApiError(409, {
          detail: "schedule_conflicts",
          violations: [
            {
              code: "venue_double_booked", hard: true, match_id: "m1",
              other_match_id: "m2", venue: "Main Ground",
              at: "2026-06-20T09:00:00",
            },
          ],
        }),
      )
      .mockResolvedValueOnce({ match: MATCHES[0], violations: [] });
    mount();
    await userEvent.click(screen.getByTestId("repair-menu-m1"));
    await userEvent.click(screen.getByTestId("repair-move-m1"));
    await userEvent.click(screen.getByTestId("move-submit"));

    // violations rendered from the stable code; submit flips to Move it anyway
    expect(
      await screen.findByTestId("repair-violation-venue_double_booked"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Two matches would share this court at the same time"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("move-submit")).toBeNull();

    await userEvent.click(screen.getByTestId("move-force"));
    await waitFor(() =>
      expect(tournamentsApi.rescheduleMatch).toHaveBeenLastCalledWith(
        "m1",
        expect.objectContaining({ force: true }),
      ),
    );
    // both attempts replay the SAME event_id (the 409 persisted nothing)
    const calls = vi.mocked(tournamentsApi.rescheduleMatch).mock.calls;
    expect(calls[1][1].event_id).toBe(calls[0][1].event_id);
  });

  it("Delay quick-picks + cascade toggle; result toast counts moved matches", async () => {
    mount();
    await userEvent.click(screen.getByTestId("repair-menu-m1"));
    await userEvent.click(screen.getByTestId("repair-delay-m1"));

    expect(screen.getByTestId("delay-cascade")).toBeChecked(); // default on
    await userEvent.click(screen.getByTestId("delay-quick-60"));
    await userEvent.click(screen.getByTestId("delay-submit"));

    await waitFor(() =>
      expect(tournamentsApi.delayMatch).toHaveBeenCalledWith("m1", {
        minutes: 60,
        cascade: true,
        event_id: expect.any(String),
      }),
    );
    expect(await screen.findByText("2 matches moved")).toBeInTheDocument();
  });

  it("Delay accepts custom minutes and an off cascade", async () => {
    mount();
    await userEvent.click(screen.getByTestId("repair-menu-m1"));
    await userEvent.click(screen.getByTestId("repair-delay-m1"));

    const custom = screen.getByTestId("delay-minutes");
    await userEvent.clear(custom);
    await userEvent.type(custom, "45");
    await userEvent.click(screen.getByTestId("delay-cascade"));
    await userEvent.click(screen.getByTestId("delay-submit"));

    await waitFor(() =>
      expect(tournamentsApi.delayMatch).toHaveBeenCalledWith("m1", {
        minutes: 45,
        cascade: false,
        event_id: expect.any(String),
      }),
    );
  });

  it("Lock pins the slot; a locked row shows the padlock badge and unlocks", async () => {
    mount();
    await userEvent.click(screen.getByTestId("repair-menu-m1"));
    await userEvent.click(screen.getByTestId("repair-lock-m1"));
    await waitFor(() =>
      expect(tournamentsApi.lockMatch).toHaveBeenCalledWith("m1"),
    );

    // locked match: badge on the row, menu offers Unlock, Delay disabled
    mount([match({ id: "m9", locked_at: "2026-06-12T00:00:00Z" })]);
    expect(screen.getByTestId("locked-m9")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("repair-menu-m9"));
    expect(screen.getByTestId("repair-delay-m9")).toBeDisabled();
    await userEvent.click(screen.getByTestId("repair-lock-m9"));
    await waitFor(() =>
      expect(tournamentsApi.unlockMatch).toHaveBeenCalledWith("m9"),
    );
  });

  it("Swap offers only other movable scheduled matches of the competition", async () => {
    mount();
    await userEvent.click(screen.getByTestId("repair-menu-m1"));
    await userEvent.click(screen.getByTestId("repair-swap-m1"));

    await userEvent.click(screen.getByRole("button", { name: "Swap with" }));
    // m3 is completed → not offered; m1 is self → not offered
    expect(screen.getByRole("option", { name: /Carol vs Delta/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha vs Bravo/ })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: /Carol vs Delta/ }));
    await userEvent.click(screen.getByTestId("swap-submit"));

    await waitFor(() =>
      expect(tournamentsApi.swapSlots).toHaveBeenCalledWith("t1", {
        match_a: "m1",
        match_b: "m2",
        event_id: expect.any(String),
      }),
    );
    expect(await screen.findByText("Slots swapped")).toBeInTheDocument();
  });
});
