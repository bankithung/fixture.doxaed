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
    sport: "",
    set_scores: [],
    leaf_key: "",
    venue: "",
    scoring: null,
    scheduled_at: null,
    ...over,
  };
}

describe("BracketView", () => {
  it("renders an empty state with no matches", () => {
    render(<BracketView matches={[]} />);
    expect(screen.getByText(/no fixtures yet/i)).toBeInTheDocument();
  });

  it("renders a knockout band as a FIFA-style bracket with a champion box", () => {
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
    // distance-from-final labels (no hardcoded "Round N") + the champion box
    expect(screen.getByText("Final")).toBeInTheDocument();
    expect(screen.getByText("Semi-finals")).toBeInTheDocument();
    expect(screen.getByText("Champion")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("renders a round-robin group as a standings table", () => {
    render(
      <BracketView
        matches={[
          m(
            {
              group_label: "Group A",
              stage: "group",
              round_no: 1,
              status: "completed",
              home_team: { id: "a", name: "Alpha", short_name: "ALP" },
              away_team: { id: "b", name: "Beta", short_name: "BET" },
              home_score: 3,
              away_score: 0,
            },
            "g1",
          ),
        ]}
      />,
    );
    expect(screen.getByText("Group A")).toBeInTheDocument();
    expect(screen.getByText("Pts")).toBeInTheDocument();
    // Winner (Alpha) sorts first and is marked as advancing.
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });
});
