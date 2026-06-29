import { describe, expect, it } from "vitest";
import { sideName } from "../sideName";

const TEAMS = new Map([["tm1", "Alpha FC"]]);

describe("sideName — group_position placeholders (Gap 4)", () => {
  it("renders a clean 'Group A top 2' chip extracted from the full legacy label", () => {
    expect(
      sideName(
        {
          source: {
            type: "group_position",
            group_label: "Football — U15 — Group A",
            position: 2,
          },
        },
        TEAMS,
      ),
    ).toBe("Group A top 2");
  });

  it("also handles an already-short 'Group A' label", () => {
    expect(
      sideName(
        { source: { type: "group_position", group_label: "Group A", position: 1 } },
        TEAMS,
      ),
    ).toBe("Group A top 1");
  });

  it("renders best-third placeholders as 'Best 3rd #1'", () => {
    expect(
      sideName(
        { source: { type: "group_position", best_third: true, rank: 1 } },
        TEAMS,
      ),
    ).toBe("Best 3rd #1");
  });

  it("never leaks the raw em-dash label", () => {
    const out = sideName(
      {
        source: {
          type: "group_position",
          group_label: "Football — U15 — Group A",
          position: 2,
        },
      },
      TEAMS,
    );
    expect(out).not.toContain("—");
    expect(out).not.toContain("Football");
  });

  it("leaves winner_of / loser_of / team / TBD unchanged", () => {
    expect(sideName({ team_id: "tm1" }, TEAMS)).toBe("Alpha FC");
    expect(sideName({ source: { type: "winner_of", ref: "p3" } }, TEAMS)).toBe(
      "Winner of p3",
    );
    expect(sideName({ source: { type: "loser_of", ref: "p4" } }, TEAMS)).toBe(
      "Loser of p4",
    );
    expect(sideName({ source: { type: "tbd" } }, TEAMS)).toBe("TBD");
  });
});
