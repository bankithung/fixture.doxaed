import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FifaBracket, sourceLabel } from "../FifaBracket";
import type { MatchRow } from "@/api/tournaments";

let seq = 0;
function m(over: Partial<MatchRow>, id: string): MatchRow {
  return {
    id, stage: "knockout", group_label: "", round_no: 1, match_no: ++seq,
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
    // The (still-empty) final reads "TBD", not a leaked label.
    expect(screen.getAllByText("TBD").length).toBeGreaterThan(0);
    // Placeholder caption explains the draw will fill in.
    expect(screen.getByText(/pairings fill in as the group stage finishes/i)).toBeInTheDocument();
  });

  it("draws real matchups as cards with round headers + a champion box", () => {
    // 4 teams: two semis feed a final. Each card shows both sides; the round
    // header reads from the field size (Semi-finals, mirrored per half).
    const sf1 = m({ round_no: 1, home_team: team("a", "Alpha"), away_team: team("b", "Beta") }, "m1");
    const sf2 = m({ round_no: 1, home_team: team("c", "Gamma"), away_team: team("d", "Delta") }, "m2");
    const fin = m({ round_no: 2 }, "fin");
    render(<FifaBracket columns={[[1, [sf1, sf2]], [2, [fin]]]} />);

    for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByText("Champion")).toBeInTheDocument();
    expect(screen.getAllByText("Semi-finals")).toHaveLength(2);
    expect(screen.getByText("Final")).toBeInTheDocument();
    expect(screen.queryByText("Quarter-finals")).toBeNull(); // only 4 teams
  });

  it("shows scores + crowns the champion once the final is decided", () => {
    const sf1 = m({ round_no: 1, status: "completed", home_team: team("a", "Alpha"),
      away_team: team("b", "Beta"), home_score: 2, away_score: 1 }, "sf1");
    const sf2 = m({ round_no: 1, status: "completed", home_team: team("c", "Gamma"),
      away_team: team("d", "Delta"), home_score: 0, away_score: 3 }, "sf2");
    const fin = m({ round_no: 2, status: "completed", home_team: team("a", "Alpha"),
      away_team: team("d", "Delta"), home_score: 1, away_score: 0 }, "fin");
    render(<FifaBracket columns={[[1, [sf1, sf2]], [2, [fin]]]} />);

    expect(screen.getByText("Champion")).toBeInTheDocument();
    // Alpha = its semi + the final + the champion line.
    expect(screen.getAllByText("Alpha")).toHaveLength(3);
    // Three completed matches -> three "FT" status strips.
    expect(screen.getAllByText("FT")).toHaveLength(3);
  });

  it("does not crown a winner while the final is still open", () => {
    const sf1 = m({ round_no: 1, status: "completed", home_team: team("a", "Alpha"),
      away_team: team("b", "Beta"), home_score: 2, away_score: 0 }, "sf1");
    const sf2 = m({ round_no: 1, home_team: team("c", "Gamma"), away_team: team("d", "Delta") }, "sf2");
    const fin = m({ round_no: 2 }, "fin");
    render(<FifaBracket columns={[[1, [sf1, sf2]], [2, [fin]]]} />);
    expect(screen.getByText("Champion")).toBeInTheDocument();
    // Alpha only appears in its own semi — never promoted to champion.
    expect(screen.getAllByText("Alpha")).toHaveLength(1);
  });

  it("pulls a 3rd-place playoff out of the winner tree (keeps the Final centred)", () => {
    // The generator emits the 3rd-place match at the SAME round_no as the Final
    // (both stage=knockout, fed by loser_of) — it must NOT collapse the bracket.
    const sf1 = m({ round_no: 1, match_no: 1, home_team: team("a", "Alpha"), away_team: team("b", "Beta") }, "sf1");
    const sf2 = m({ round_no: 1, match_no: 2, home_team: team("c", "Gamma"), away_team: team("d", "Delta") }, "sf2");
    const third = m({ round_no: 2, match_no: 3, group_label: "Cup — 3rd Place",
      home_source: { type: "loser_of", match_id: "sf1" }, away_source: { type: "loser_of", match_id: "sf2" } }, "third");
    const fin = m({ round_no: 2, match_no: 4,
      home_source: { type: "winner_of", match_id: "sf1" }, away_source: { type: "winner_of", match_id: "sf2" } }, "fin");
    render(<FifaBracket columns={[[1, [sf1, sf2]], [2, [third, fin]]]} />);
    // Final still resolves -> champion box + mirrored semis (not the collapsed fallback).
    expect(screen.getByText("Champion")).toBeInTheDocument();
    expect(screen.getByText("Final")).toBeInTheDocument();
    expect(screen.getAllByText("Semi-finals")).toHaveLength(2);
    // The consolation renders separately with a clean ASCII label.
    expect(screen.getByText("3rd Place")).toBeInTheDocument();
  });

  it("scales round names with the field (Quarter-finals -> Semi-finals -> Final)", () => {
    const qf = (i: number) =>
      m({ round_no: 1, home_team: team(`q${i}a`, `Q${i}A`), away_team: team(`q${i}b`, `Q${i}B`) }, `qf${i}`);
    const sf = (i: number) => m({ round_no: 2 }, `sf${i}`);
    const fin = m({ round_no: 3 }, "fin");
    render(
      <FifaBracket
        columns={[
          [1, [qf(1), qf(2), qf(3), qf(4)]],
          [2, [sf(1), sf(2)]],
          [3, [fin]],
        ]}
      />,
    );
    expect(screen.getAllByText("Quarter-finals")).toHaveLength(2);
    expect(screen.getAllByText("Semi-finals")).toHaveLength(2);
    expect(screen.getByText("Final")).toBeInTheDocument();
    expect(screen.getByText("Champion")).toBeInTheDocument();
  });
});
