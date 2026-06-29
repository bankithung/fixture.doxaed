import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FifaBracket, sourceLabel } from "../FifaBracket";
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

describe("sourceLabel", () => {
  it("labels a group_position pointer and ignores winner_of", () => {
    expect(sourceLabel({ type: "group_position", group_label: "Group A", position: 1 }))
      .toBe("Group A top 1");
    expect(sourceLabel({ type: "winner_of", match_id: "x" })).toBeNull();
    expect(sourceLabel(null)).toBeNull();
  });

  it("labels a best_third placeholder via the shared helper", () => {
    expect(sourceLabel({ type: "group_position", best_third: true, rank: 1 }))
      .toBe("Best 3rd #1");
  });

  it("strips the full em-dash legacy label down to 'Group A top 2'", () => {
    expect(
      sourceLabel({
        type: "group_position",
        group_label: "Football — U15 — Group A",
        position: 2,
      }),
    ).toBe("Group A top 2");
  });
});

describe("FifaBracket", () => {
  it("renders an empty state with no columns", () => {
    render(<FifaBracket columns={[]} />);
    expect(screen.getByText(/no bracket yet/i)).toBeInTheDocument();
  });

  it("shows group_position placeholders for an unresolved (eager) slot", () => {
    const semi = m({
      round_no: 1,
      home_source: { type: "group_position", group_label: "Group A", position: 1 },
      away_source: { type: "group_position", group_label: "Group B", position: 2 },
    }, "s1");
    const fin = m({ round_no: 2 }, "f1");
    render(<FifaBracket columns={[[1, [semi]], [2, [fin]]]} />);
    expect(screen.getByText("Group A top 1")).toBeInTheDocument();
    expect(screen.getByText("Group B top 2")).toBeInTheDocument();
  });

  it("draws every entrant as an edge card and a centre champion (rough sketch)", () => {
    // The sketch reads ENTRANTS, not matchups: 4 teams across the round-1
    // matches become 4 edge cards converging to a champion + trophy.
    const m1 = m({ round_no: 1, home_team: team("a", "Alpha"), away_team: team("b", "Beta") }, "m1");
    const m2 = m({ round_no: 1, home_team: team("c", "Gamma"), away_team: team("d", "Delta") }, "m2");
    const fin = m({ round_no: 2 }, "fin");
    render(<FifaBracket columns={[[1, [m1, m2]], [2, [fin]]]} />);

    for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByText("Champion")).toBeInTheDocument();
    // FIFA round headers (mirrored on both halves) — structure, not a forecast.
    expect(screen.getAllByText("Semi-finals")).toHaveLength(2);
    expect(screen.getByText("Final")).toBeInTheDocument();
    expect(screen.queryByText("Quarter-finals")).toBeNull(); // only 4 entrants
  });

  it("does not invent a winner (champion stays a placeholder even with results)", () => {
    const sf1 = m({ round_no: 1, status: "completed", home_team: team("a", "Alpha"),
      away_team: team("b", "Beta"), home_score: 2, away_score: 0 }, "sf1");
    const fin = m({ round_no: 2 }, "fin");
    render(<FifaBracket columns={[[1, [sf1]], [2, [fin]]]} />);
    expect(screen.getByText("Champion")).toBeInTheDocument();
    // "Alpha" appears once, as its entrant card — never promoted to champion.
    expect(screen.getAllByText("Alpha")).toHaveLength(1);
  });

  it("scales the sketch with the entrant count (more entrants, same shape)", () => {
    // 6 group winners -> an 8-slot sketch (2 byes), all six rendered.
    const cols: [number, MatchRow[]][] = [[1, [
      m({ round_no: 1,
        home_source: { type: "group_position", group_label: "Group A", position: 1 },
        away_source: { type: "group_position", group_label: "Group B", position: 1 } }, "k1"),
      m({ round_no: 1,
        home_source: { type: "group_position", group_label: "Group C", position: 1 },
        away_source: { type: "group_position", group_label: "Group A", position: 2 } }, "k2"),
      m({ round_no: 1,
        home_source: { type: "group_position", group_label: "Group B", position: 2 },
        away_source: { type: "group_position", group_label: "Group C", position: 2 } }, "k3"),
    ]]];
    render(<FifaBracket columns={cols} />);
    for (const label of ["Group A top 1", "Group B top 1", "Group C top 1",
      "Group A top 2", "Group B top 2", "Group C top 2"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // 6 entrants -> 8-slot bracket: Quarter-finals -> Semi-finals -> Final.
    expect(screen.getAllByText("Quarter-finals")).toHaveLength(2);
    expect(screen.getAllByText("Semi-finals")).toHaveLength(2);
    expect(screen.getByText("Final")).toBeInTheDocument();
    expect(screen.getByText("Champion")).toBeInTheDocument();
  });
});
