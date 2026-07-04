import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FootballLineups } from "../lineups/FootballLineups";

const entry = (id: string, name: string, role: string, pos = "", no: number | null = null) => ({
  player_id: id, name, role, shirt_no: no, positional_role: pos,
});

describe("FootballLineups pitch (owner ask: pitch UI with players)", () => {
  it("draws both XIs as dots on the pitch, keeper bucketed by role", () => {
    render(
      <FootballLineups
        home={{
          teamName: "Alpha", confirmed: true,
          entries: [
            entry("gk1", "Imna Jamir", "starter", "goalkeeper", 1),
            entry("d1", "Ato Yaden", "starter", "defender", 4),
            entry("m1", "Ren Odyuo", "starter", "midfield", 8),
            entry("f1", "Kevi Zhale", "starter", "striker", 9),
            entry("b1", "Sub One", "substitute", "", 14),
          ],
        }}
        away={{
          teamName: "Beta", confirmed: true,
          entries: [entry("x1", "Toshi Ao", "starter", "", 10)],
        }}
      />,
    );
    expect(screen.getByTestId("football-pitch")).toBeInTheDocument();
    const homeHalf = screen.getByTestId("pitch-home-half");
    expect(homeHalf).toHaveTextContent("Jamir");
    // Shirt numbers ride the dots.
    expect(screen.getByTestId("pitch-player-f1")).toHaveTextContent("9");
    expect(screen.getByTestId("pitch-away-half")).toHaveTextContent("Ao");
    // The bench stays a list below the pitch.
    expect(screen.getByText("Sub One")).toBeInTheDocument();
  });

  it("falls back to plain lists when no confirmed starters exist", () => {
    render(
      <FootballLineups
        home={{
          teamName: "Alpha", confirmed: false,
          entries: [entry("r1", "Roster Kid", "", "", null)],
        }}
        away={null}
      />,
    );
    expect(screen.queryByTestId("football-pitch")).not.toBeInTheDocument();
    expect(screen.getByText("Roster Kid")).toBeInTheDocument();
  });
});
