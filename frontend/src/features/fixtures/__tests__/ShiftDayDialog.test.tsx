import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";
import { tournamentsApi, type MatchRow } from "@/api/tournaments";
import { ApiError } from "@/types/api";
import { ShiftDayDialog } from "../ShiftDayDialog";

vi.mock("@/api/tournaments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tournaments")>();
  return {
    ...actual,
    tournamentsApi: {
      ...actual.tournamentsApi,
      shiftDay: vi.fn(),
    },
  };
});

function match(over: Partial<MatchRow>): MatchRow {
  return {
    id: "m1", stage: "group", group_label: "A", round_no: 1, match_no: 1,
    status: "scheduled", home_team: { id: "t1", name: "Alpha", short_name: "A" },
    away_team: { id: "t2", name: "Bravo", short_name: "B" },
    home_score: null, away_score: null, sport: "football", set_scores: [],
    leaf_key: "football.u15", venue: "Main", scoring: null,
    scheduled_at: "2026-06-20T09:00:00+05:30", locked_at: null,
    ...over,
  };
}

const MATCHES = [
  match({ id: "m1" }),
  match({ id: "m2", match_no: 2, scheduled_at: "2026-06-20T11:00:00+05:30" }),
  match({ id: "m3", match_no: 3, scheduled_at: "2026-06-21T09:00:00+05:30" }),
  // not movable / locked / unscheduled — never offered as a source day
  match({ id: "m4", status: "completed", scheduled_at: "2026-06-22T09:00:00+05:30" }),
  match({
    id: "m5", scheduled_at: "2026-06-23T09:00:00+05:30",
    locked_at: "2026-06-12T00:00:00Z",
  }),
  match({
    id: "m6", leaf_key: "football.u17",
    scheduled_at: "2026-06-24T09:00:00+05:30",
  }),
];

const COMPETITIONS = [
  { leafKey: "football.u15", label: "Football · U15" },
  { leafKey: "football.u17", label: "Football · U17" },
];

function mount(onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ShiftDayDialog
          tournamentId="t1"
          matches={MATCHES}
          competitions={COMPETITIONS}
          onClose={onClose}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return onClose;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tournamentsApi.shiftDay).mockResolvedValue({
    moved: [
      { match_id: "m1", old: "a", new: "b", venue: "Main" },
      { match_id: "m2", old: "c", new: "d", venue: "Main" },
    ],
    violations: [],
    to_date: "2026-06-25",
  });
});

async function pickDay(re: RegExp) {
  await userEvent.click(screen.getByRole("button", { name: "Day to move" }));
  await userEvent.click(screen.getByRole("option", { name: re }));
}

describe("ShiftDayDialog", () => {
  it("offers only days holding movable, unlocked matches (with counts)", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Day to move" }));
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toHaveLength(3); // 20th (2), 21st, 24th — not 22nd/23rd
    expect(labels[0]).toMatch(/Jun 20 — 2 matches/);
    expect(labels[1]).toMatch(/Jun 21 — 1 match/);
    expect(labels[2]).toMatch(/Jun 24 — 1 match/);
  });

  it("blank target = first reserve day; success toasts moved-count + day", async () => {
    const onClose = mount();
    await pickDay(/Jun 20/);
    await userEvent.click(screen.getByTestId("shift-submit"));

    await waitFor(() =>
      expect(tournamentsApi.shiftDay).toHaveBeenCalledWith("t1", {
        from_date: "2026-06-20",
        event_id: expect.any(String),
      }),
    );
    expect(
      await screen.findByText(/2 matches moved to .*Jun 25/),
    ).toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
  });

  it("sends explicit to_date and leaf scope when chosen", async () => {
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Competition scope" }),
    );
    await userEvent.click(screen.getByRole("option", { name: "Football · U17" }));
    await pickDay(/Jun 24/);
    await userEvent.type(screen.getByTestId("shift-to"), "2026-06-27");
    await userEvent.click(screen.getByTestId("shift-submit"));

    await waitFor(() =>
      expect(tournamentsApi.shiftDay).toHaveBeenCalledWith("t1", {
        from_date: "2026-06-24",
        to_date: "2026-06-27",
        leaf_key: "football.u17",
        event_id: expect.any(String),
      }),
    );
  });

  it("hard conflicts gate behind Force anyway, replaying the same event_id", async () => {
    vi.mocked(tournamentsApi.shiftDay)
      .mockRejectedValueOnce(
        new ApiError(409, {
          detail: "schedule_conflicts",
          violations: [
            { code: "insufficient_rest", hard: true, team_id: "t1" },
          ],
        }),
      )
      .mockResolvedValueOnce({ moved: [], violations: [], to_date: "2026-06-25" });
    mount();
    await pickDay(/Jun 20/);
    await userEvent.click(screen.getByTestId("shift-submit"));

    expect(
      await screen.findByTestId("repair-violation-insufficient_rest"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("shift-force"));
    await waitFor(() =>
      expect(tournamentsApi.shiftDay).toHaveBeenLastCalledWith(
        "t1",
        expect.objectContaining({ force: true }),
      ),
    );
    const calls = vi.mocked(tournamentsApi.shiftDay).mock.calls;
    expect(calls[1][1].event_id).toBe(calls[0][1].event_id);
  });

  it("explains a missing reserve day inline (stable code, not the raw detail)", async () => {
    vi.mocked(tournamentsApi.shiftDay).mockRejectedValue(
      new ApiError(400, { detail: "reserve_day_unavailable" }),
    );
    mount();
    await pickDay(/Jun 21/);
    await userEvent.click(screen.getByTestId("shift-submit"));

    expect(
      await screen.findByText(/No free reserve day after that date/),
    ).toBeInTheDocument();
  });
});
