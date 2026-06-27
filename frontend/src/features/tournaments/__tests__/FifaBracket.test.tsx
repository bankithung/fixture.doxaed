import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FifaBracket } from "../FifaBracket";
import type { MatchRow } from "@/api/tournaments";

function m(over: Partial<MatchRow>, id: string): MatchRow {
  return {
    id, stage: "knockout", group_label: "", round_no: 1, match_no: 1,
    status: "scheduled", home_team: null, away_team: null, home_score: null,
    away_score: null, sport: "", set_scores: [], leaf_key: "", venue: "",
    scoring: null, scheduled_at: null, ...over,
  };
}

const team = (id: string, name: string) => ({ id, name, short_name: name.slice(0, 3) });

describe("FifaBracket", () => {
  it("renders an empty state with no columns", () => {
    render(<FifaBracket columns={[]} />);
    expect(screen.getByText(/no bracket yet/i)).toBeInTheDocument();
  });

  it("mirrors a 4-team bracket into two halves with a centre champion", () => {
    // 2 semi-finals (round 1) → final (round 2), final won by Alpha
    const sf1 = m({ round_no: 1, status: "completed", home_team: team("a", "Alpha"),
      away_team: team("b", "Beta"), home_score: 2, away_score: 0 }, "sf1");
    const sf2 = m({ round_no: 1, status: "completed", home_team: team("c", "Gamma"),
      away_team: team("d", "Delta"), home_score: 1, away_score: 0 }, "sf2");
    const fin = m({ round_no: 2, status: "completed", home_team: team("a", "Alpha"),
      away_team: team("c", "Gamma"), home_score: 3, away_score: 1 }, "fin");
    render(<FifaBracket columns={[[1, [sf1, sf2]], [2, [fin]]]} />);

    // "Semi-finals" header on each mirrored half
    expect(screen.getAllByText("Semi-finals").length).toBe(2);
    expect(screen.getByText("Final")).toBeInTheDocument();
    // both semi-finals render (one per mirrored half)
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Delta")).toBeInTheDocument();
    // the final's winner fills the champion box
    expect(screen.getByText("Champion")).toBeInTheDocument();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
  });
});
