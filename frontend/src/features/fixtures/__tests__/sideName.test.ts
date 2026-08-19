import { describe, expect, it } from "vitest";
import { sideCrest, sideName } from "../sideName";

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

describe("sideCrest — the badge that travels beside the name", () => {
  const CRESTS = new Map([["tm1", "https://crest.example/tm1.png"]]);

  it("answers the badge of a resolved team", () => {
    expect(sideCrest({ team_id: "tm1" }, CRESTS)).toBe(
      "https://crest.example/tm1.png",
    );
  });

  it("answers \"\" for a team that has no badge", () => {
    expect(sideCrest({ team_id: "tm2" }, CRESTS)).toBe("");
  });

  it("answers \"\" for a side nobody has qualified for yet", () => {
    // A pointer is not a team, so it can never carry a team's crest.
    expect(sideCrest({ source: { type: "winner_of", ref: "p3" } }, CRESTS)).toBe("");
    expect(
      sideCrest({ source: { type: "group_position", group_label: "Group A", position: 1 } }, CRESTS),
    ).toBe("");
    expect(sideCrest({ source: { type: "tbd" } }, CRESTS)).toBe("");
  });

  it("is safe with no crests at all", () => {
    expect(sideCrest({ team_id: "tm1" }, new Map())).toBe("");
  });
});
