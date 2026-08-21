import { describe, expect, it } from "vitest";
import {
  bracketSizes,
  defaultMeets,
  defaultSheet,
  groupCountFor,
  meetsProblem,
  sheetProblems,
  slotLabel,
  slotOptions,
} from "../bracketSheet";

describe("groupCountFor", () => {
  it("derives the group count from the bracket instead of asking for it", () => {
    // The owner's own event: 4 matches, top 2 of each group, 2 best losers.
    // 8 seats - 2 best losers = 6 = 2 x 3 groups.
    expect(groupCountFor(4, 2, 2)).toBe(3);
    expect(groupCountFor(4, 2, 0)).toBe(4);
    expect(groupCountFor(2, 1, 0)).toBe(4);
  });

  it("refuses a size the qualifiers cannot fill exactly", () => {
    // 8 seats - 1 best loser = 7, which no whole number of groups of 2 fills.
    expect(groupCountFor(4, 2, 1)).toBeNull();
    expect(groupCountFor(0, 2, 0)).toBeNull();
  });
});

describe("slotOptions", () => {
  it("lists every qualifying slot once, groups then best losers", () => {
    expect(slotOptions(3, 2, 2)).toEqual([
      "A1", "A2", "B1", "B2", "C1", "C2", "L1", "L2",
    ]);
  });
});

describe("slotLabel", () => {
  it("reads as words, not as notation", () => {
    expect(slotLabel("A1")).toBe("Group A winner");
    expect(slotLabel("B2")).toBe("Group B runner-up");
    expect(slotLabel("C3")).toBe("Group C place 3");
    expect(slotLabel("L2")).toBe("Best Non-Qualifier 2");
  });
});

describe("defaultSheet", () => {
  it("starts from a legal sheet, so switching modes is never an error state", () => {
    const sheet = defaultSheet(4, 2, 2);
    expect(sheet).toHaveLength(4);
    expect(sheetProblems(sheet, slotOptions(3, 2, 2))).toEqual([]);
  });

  it("is empty when the size cannot be filled at all", () => {
    expect(defaultSheet(4, 2, 1)).toEqual([]);
  });
});

describe("sheetProblems", () => {
  const options = slotOptions(3, 2, 2);

  it("passes the sheet the owner asked for", () => {
    expect(
      sheetProblems([["A1", "L1"], ["A2", "C1"], ["B1", "L2"], ["B2", "C2"]], options),
    ).toEqual([]);
  });

  it("names who is seated twice and who never plays", () => {
    const problems = sheetProblems(
      [["A1", "L1"], ["A1", "C1"], ["B1", "L2"], ["B2", "C2"]], options,
    );
    expect(problems.join(" ")).toContain("A1");
    expect(problems.join(" ")).toContain("A2");
  });

  it("catches a half-filled row before it is saved", () => {
    expect(sheetProblems([["A1", ""]], options).join(" ")).toContain(
      "Every match needs two teams.",
    );
  });
});

describe("meets", () => {
  it("defaults to the plain tree", () => {
    expect(defaultMeets(4)).toEqual([[1, 2], [3, 4]]);
  });

  it("accepts the owner's crossing and rejects a match named twice", () => {
    expect(meetsProblem([[1, 3], [2, 4]], 4)).toBeNull();
    expect(meetsProblem([[1, 3], [1, 4]], 4)).not.toBeNull();
    expect(meetsProblem([[1, 3]], 4)).not.toBeNull();
  });
});

describe("bracketSizes", () => {
  it("offers only sizes a knockout can halve", () => {
    expect(bracketSizes(16)).toEqual([1, 2, 4, 8, 16]);
  });
});
