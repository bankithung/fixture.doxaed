import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { MatchRow } from "@/api/tournaments";
import { CompetitionResultCard } from "../CompetitionResultCard";

function match(over: Partial<MatchRow>): MatchRow {
  return {
    id: "m1", stage: "group", group_label: "Group A", round_no: 1, match_no: 1,
    status: "scheduled", home_team: { id: "tm1", name: "Alpha", short_name: "A" },
    away_team: { id: "tm2", name: "Bravo", short_name: "B" },
    home_score: null, away_score: null, sport: "football", set_scores: [],
    leaf_key: "football.u15", venue: "Main Ground", scoring: null,
    scheduled_at: null,
    ...over,
  };
}

describe("CompetitionResultCard", () => {
  it("renders the draw read-only, grouped, with scores only when final", () => {
    render(
      <MemoryRouter>
        <CompetitionResultCard
          tournamentId="t1"
          matches={[
            match({ id: "m1", status: "completed", home_score: 2, away_score: 1 }),
            match({ id: "m2", round_no: 2 }),
            match({
              id: "m3", stage: "knockout", group_label: "", round_no: 1,
              home_team: null, away_team: null,
            }),
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("competition-result-card")).toHaveTextContent(
      "1 of 3 played.",
    );
    expect(screen.getByText("Group A")).toBeInTheDocument();
    expect(screen.getByText("Bracket")).toBeInTheDocument();
    expect(screen.getByTestId("result-row-m1")).toHaveTextContent("2 – 1");
    expect(screen.getByTestId("result-row-m2")).toHaveTextContent("vs");
    expect(screen.getByTestId("result-row-m3")).toHaveTextContent("TBD");
    // read-only: no inline score inputs — entry happens in the match console
    expect(screen.queryByRole("textbox")).toBeNull();
    const link = within(screen.getByTestId("result-row-m1")).getByRole("link", {
      name: "Console",
    });
    expect(link).toHaveAttribute("href", "/tournaments/t1/matches/m1");
  });
});
