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
              round_no: 1,
              home_team: { id: "c", name: "Gamma", short_name: "GAM" },
              away_team: { id: "d", name: "Delta", short_name: "DEL" },
            },
            "m1b",
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
    // FIFA-style distance-from-final column labels (no hardcoded "Round N"):
    // four entrants draw a Semi-finals round (mirrored on each half) feeding
    // the Final + the champion box. The sketch reads entrant count, so the
    // label appears once per half.
    expect(screen.getByText("Final")).toBeInTheDocument();
    expect(screen.getAllByText("Semi-finals").length).toBeGreaterThan(0);
    expect(screen.getByText("Champion")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("keeps two categories' 'Group A' in separate bands (Gap 5b)", () => {
    render(
      <BracketView
        matches={[
          m(
            {
              leaf_key: "football.u15",
              group_label: "Group A",
              stage: "group",
              round_no: 1,
              status: "completed",
              home_team: { id: "a", name: "Alpha", short_name: "ALP" },
              away_team: { id: "b", name: "Beta", short_name: "BET" },
              home_score: 1,
              away_score: 0,
            },
            "x1",
          ),
          m(
            {
              leaf_key: "football.u17",
              group_label: "Group A",
              stage: "group",
              round_no: 1,
              status: "completed",
              home_team: { id: "c", name: "Gamma", short_name: "GAM" },
              away_team: { id: "d", name: "Delta", short_name: "DEL" },
              home_score: 2,
              away_score: 1,
            },
            "x2",
          ),
        ]}
      />,
    );
    // Two separate "Group A" headings (one per leaf), NOT one merged band.
    expect(screen.getAllByText("Group A")).toHaveLength(2);
    // Each band keeps its own teams.
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
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
