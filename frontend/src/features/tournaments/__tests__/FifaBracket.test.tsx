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

  it("shows group_position placeholders + TBD, with the group caption", () => {
    const sf1 = m({ round_no: 1,
      home_source: { type: "group_position", group_label: "Group A", position: 1 },
      away_source: { type: "group_position", group_label: "Group B", position: 2 } }, "s1");
    const sf2 = m({ round_no: 1,
      home_source: { type: "group_position", group_label: "Group C", position: 1 },
      away_source: { type: "group_position", group_label: "Group D", position: 2 } }, "s2");
    const fin = m({ round_no: 2 }, "f1");
    render(<FifaBracket columns={[[1, [sf1, sf2]], [2, [fin]]]} />);
    expect(screen.getByText("Group A top 1")).toBeInTheDocument();
    expect(screen.getByText("Group B top 2")).toBeInTheDocument();
    // The (still-empty) final reads "TBD".
    expect(screen.getAllByText("TBD").length).toBeGreaterThan(0);
    expect(screen.getByText(/pairings fill in as the group stage finishes/i)).toBeInTheDocument();
  });

  it("draws real matchups; each round header appears once (single-direction)", () => {
    const qf = (a: string, b: string) =>
      m({ round_no: 1, home_team: team(a, a), away_team: team(b, b) }, `${a}${b}`);
    render(
      <FifaBracket
        columns={[
          [1, [qf("Alpha", "Beta"), qf("Gamma", "Delta"), qf("Eps", "Zeta"), qf("Eta", "Theta")]],
          [2, [m({ round_no: 2 }, "sf1"), m({ round_no: 2 }, "sf2")]],
          [3, [m({ round_no: 3 }, "fin")]],
        ]}
      />,
    );
    for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // Single-direction: NOT mirrored — one header per round, no champion box.
    expect(screen.getAllByText("Quarter-finals")).toHaveLength(1);
    expect(screen.getAllByText("Semi-finals")).toHaveLength(1);
    expect(screen.getAllByText("Final")).toHaveLength(1);
    expect(screen.queryByText("Champion")).toBeNull();
  });

  it("shows scores + marks the winning side", () => {
    const sf1 = m({ round_no: 1, status: "completed", home_team: team("a", "Alpha"),
      away_team: team("b", "Beta"), home_score: 2, away_score: 1 }, "sf1");
    const sf2 = m({ round_no: 1, status: "completed", home_team: team("c", "Gamma"),
      away_team: team("d", "Delta"), home_score: 0, away_score: 3 }, "sf2");
    const fin = m({ round_no: 2, status: "completed", home_team: team("a", "Alpha"),
      away_team: team("d", "Delta"), home_score: 1, away_score: 0 }, "fin");
    render(<FifaBracket columns={[[1, [sf1, sf2]], [2, [fin]]]} />);
    // Three completed matches -> three "FT" badges.
    expect(screen.getAllByText("FT")).toHaveLength(3);
    // Alpha wins its semi and the final (appears in both cards).
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
  });

  it("lays out a play-in / bye bracket by feeder pointers, not by round size", () => {
    // A play-in feeds the round of 8: round match-counts are [1,2,1,1] — the old
    // "each round halves" layout mislabelled + overlapped these. The tree layout
    // names columns by distance-to-final instead.
    const p1 = m({ round_no: 1, home_team: team("a", "Alpha"), away_team: team("b", "Beta"),
      home_source: { type: "team", team_id: "a" }, away_source: { type: "team", team_id: "b" } }, "p1");
    const q1 = m({ round_no: 2, away_team: team("c", "Gamma"),
      home_source: { type: "winner_of", ref: "p1" }, away_source: { type: "team", team_id: "c" } }, "q1");
    const q2 = m({ round_no: 2, home_team: team("d", "Delta"), away_team: team("e", "Epsilon"),
      home_source: { type: "team", team_id: "d" }, away_source: { type: "team", team_id: "e" } }, "q2");
    const s1 = m({ round_no: 3,
      home_source: { type: "winner_of", ref: "q1" }, away_source: { type: "winner_of", ref: "q2" } }, "s1");
    const f1 = m({ round_no: 4, away_team: team("f", "Zeta"),
      home_source: { type: "winner_of", ref: "s1" }, away_source: { type: "team", team_id: "f" } }, "f1");
    render(<FifaBracket columns={[[1, [p1]], [2, [q1, q2]], [3, [s1]], [4, [f1]]]} />);
    // Depth-based headers, each exactly once and correctly ordered by DEPTH.
    expect(screen.getByText("Round of 16")).toBeInTheDocument();
    expect(screen.getAllByText("Quarter-finals")).toHaveLength(1);
    expect(screen.getAllByText("Semi-finals")).toHaveLength(1);
    expect(screen.getAllByText("Final")).toHaveLength(1);
    // The play-in teams render (fixed first-round matchup).
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    // Cards are numbered; unresolved slots point at the feeder match, never a
    // guessed winner. The play-in is M1 (leftmost column), so q1's open side
    // reads "Winner of M1".
    expect(screen.getByText("M1")).toBeInTheDocument();
    expect(screen.getByText("Winner of M1")).toBeInTheDocument();
  });

  it("pulls a 3rd-place playoff out of the winner tree and labels it below", () => {
    const sf1 = m({ round_no: 1, home_team: team("a", "Alpha"), away_team: team("b", "Beta") }, "sf1");
    const sf2 = m({ round_no: 1, home_team: team("c", "Gamma"), away_team: team("d", "Delta") }, "sf2");
    const third = m({ round_no: 2, group_label: "Cup — 3rd Place",
      home_source: { type: "loser_of", match_id: "sf1" }, away_source: { type: "loser_of", match_id: "sf2" } }, "third");
    const fin = m({ round_no: 2,
      home_source: { type: "winner_of", match_id: "sf1" }, away_source: { type: "winner_of", match_id: "sf2" } }, "fin");
    render(<FifaBracket columns={[[1, [sf1, sf2]], [2, [third, fin]]]} />);
    // The Final still resolves as a single-match last round (not collapsed).
    expect(screen.getAllByText("Final")).toHaveLength(1);
    expect(screen.getAllByText("Semi-finals")).toHaveLength(1);
    // Consolation drawn separately with a clean ASCII label.
    expect(screen.getByText("3rd Place")).toBeInTheDocument();
  });
});

describe("FifaBracket byes", () => {
  it("shows a Bye card for a team that enters after the first round", () => {
    // 5 entrants: one play-in (D1 vs E1), then A1 joins the winner in the
    // semi while B1 and C1 pair directly: A1, B1, C1 all skipped the play-in.
    const playin = m({ round_no: 1,
      home_source: { type: "group_position", group_label: "Group D", position: 1 },
      away_source: { type: "group_position", group_label: "Group E", position: 1 } }, "m1");
    const sf1 = m({ round_no: 2,
      home_source: { type: "group_position", group_label: "Group A", position: 1 },
      away_source: { type: "winner_of", match_id: "m1" } }, "m2");
    const sf2 = m({ round_no: 2,
      home_source: { type: "group_position", group_label: "Group B", position: 1 },
      away_source: { type: "group_position", group_label: "Group C", position: 1 } }, "m3");
    const fin = m({ round_no: 3,
      home_source: { type: "winner_of", match_id: "m2" },
      away_source: { type: "winner_of", match_id: "m3" } }, "m4");
    render(<FifaBracket columns={[[1, [playin]], [2, [sf1, sf2]], [3, [fin]]]} />);
    const byes = screen.getAllByTestId("bracket-bye");
    expect(byes).toHaveLength(3);
    const text = byes.map((b) => b.textContent).join(" ");
    expect(text).toContain("Group A top 1");
    expect(text).toContain("Group B top 1");
    expect(text).toContain("Group C top 1");
    expect(text).toContain("Bye");
    expect(
      screen.getAllByText("No opponent this round, advances automatically").length,
    ).toBe(3);
  });

  it("shows a named Bye card when a real team skips round 1", () => {
    const r1 = m({ round_no: 1,
      home_team: team("t3", "Gamma FC"), away_team: team("t4", "Delta FC") }, "m1");
    const sf = m({ round_no: 2,
      home_team: team("t1", "Alpha FC"),
      away_source: { type: "winner_of", match_id: "m1" } }, "m2");
    render(<FifaBracket columns={[[1, [r1]], [2, [sf]]]} />);
    const byes = screen.getAllByTestId("bracket-bye");
    expect(byes).toHaveLength(1);
    expect(byes[0]!.textContent).toContain("Alpha FC");
    expect(byes[0]!.textContent).toContain("Bye");
  });

  it("renders no Bye cards in a full bracket", () => {
    const sf1 = m({ round_no: 1,
      home_team: team("t1", "A"), away_team: team("t2", "B") }, "m1");
    const sf2 = m({ round_no: 1,
      home_team: team("t3", "C"), away_team: team("t4", "D") }, "m2");
    const fin = m({ round_no: 2,
      home_source: { type: "winner_of", match_id: "m1" },
      away_source: { type: "winner_of", match_id: "m2" } }, "m3");
    render(<FifaBracket columns={[[1, [sf1, sf2]], [2, [fin]]]} />);
    expect(screen.queryAllByTestId("bracket-bye")).toHaveLength(0);
  });
});
