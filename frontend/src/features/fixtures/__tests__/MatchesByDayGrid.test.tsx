import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PreviewMatch } from "@/api/tournaments";
import { MatchesByDayGrid } from "../MatchesByDayGrid";
import { sideName } from "../sideName";

const TEAMS = new Map([
  ["tm1", "Alpha FC"],
  ["tm2", "Bravo FC"],
]);

function pm(over: Partial<PreviewMatch>): PreviewMatch {
  return {
    ref: "p1", leaf_key: "football.u15", stage: "group", group_label: "A",
    round_no: 1, home: { team_id: "tm1" }, away: { team_id: "tm2" },
    scheduled_at: "2026-06-20T09:00:00", venue: "Main Ground",
    ...over,
  };
}

describe("sideName", () => {
  it("resolves team ids, source pointers and TBD", () => {
    expect(sideName({ team_id: "tm1" }, TEAMS)).toBe("Alpha FC");
    expect(sideName({ source: { type: "winner_of", ref: "p3" } }, TEAMS)).toBe(
      "Winner of p3",
    );
    expect(sideName({ source: { type: "loser_of", ref: "p4" } }, TEAMS)).toBe(
      "Loser of p4",
    );
    expect(sideName({ source: { type: "tbd" } }, TEAMS)).toBe("TBD");
    expect(sideName({ team_id: "missing" }, TEAMS)).toBe("TBD");
  });
});

describe("MatchesByDayGrid", () => {
  it("groups scheduled matches into day sections with per-venue columns", () => {
    render(
      <MatchesByDayGrid
        teamNames={TEAMS}
        matches={[
          pm({ ref: "p1" }),
          pm({ ref: "p2", venue: "Second Pitch",
            scheduled_at: "2026-06-20T10:00:00" }),
          pm({ ref: "p3", scheduled_at: "2026-06-21T09:00:00" }),
          pm({ ref: "p4", scheduled_at: null, venue: null }), // unscheduled: not in the grid
        ]}
      />,
    );
    const day1 = screen.getByTestId("day-2026-06-20");
    expect(within(day1).getByTestId("chip-p1")).toBeInTheDocument();
    expect(within(day1).getByTestId("chip-p2")).toBeInTheDocument();
    expect(within(day1).getByText("Second Pitch")).toBeInTheDocument();
    const day2 = screen.getByTestId("day-2026-06-21");
    expect(within(day2).getByTestId("chip-p3")).toBeInTheDocument();
    expect(screen.queryByTestId("chip-p4")).toBeNull();
    // tournament-local wall clock rendered verbatim (invariant 14)
    expect(within(day1).getByTestId("chip-p1")).toHaveTextContent("09:00");
  });

  it("renders an empty notice when nothing was scheduled", () => {
    render(<MatchesByDayGrid teamNames={TEAMS} matches={[]} />);
    expect(
      screen.getByText("No matches were scheduled in this preview."),
    ).toBeInTheDocument();
  });
});
