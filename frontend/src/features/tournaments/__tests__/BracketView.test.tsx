import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BracketView } from "../BracketView";
import type { MatchRow } from "@/api/tournaments";

function m(over: Partial<MatchRow>, id: string): MatchRow {
  return {
    id,
    stage: "knockout",
    group_label: "",
    round_no: 1,
    match_no: 1,
    status: "scheduled",
    home_team: null,
    away_team: null,
    home_score: null,
    away_score: null,
    scheduled_at: null,
    ...over,
  };
}

describe("BracketView", () => {
  it("renders an empty state with no matches", () => {
    render(<BracketView matches={[]} />);
    expect(screen.getByText(/no fixtures yet/i)).toBeInTheDocument();
  });

  it("lays out rounds as columns with match boxes", () => {
    render(
      <BracketView
        matches={[
          m(
            {
              round_no: 1,
              status: "completed",
              home_team: { id: "a", name: "Alpha", short_name: "ALP" },
              away_team: { id: "b", name: "Beta", short_name: "BET" },
              home_score: 2,
              away_score: 1,
            },
            "m1",
          ),
          m(
            {
              round_no: 2,
              home_team: { id: "a", name: "Alpha", short_name: "ALP" },
              away_team: null,
            },
            "m2",
          ),
        ]}
      />,
    );
    expect(screen.getByText(/round 1/i)).toBeInTheDocument();
    expect(screen.getByText(/round 2/i)).toBeInTheDocument();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });
});
