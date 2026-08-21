import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BracketSheetEditor } from "../BracketSheetEditor";
import { defaultSheet } from "../bracketSheet";

/** The editor is controlled, so the test owns the state it edits. */
function Harness({
  bestLosers = 2,
  initial = defaultSheet(4, 2, 2),
}: {
  bestLosers?: number;
  initial?: string[][];
}): React.ReactElement {
  const [pairings, setPairings] = useState<string[][]>(initial);
  const [meets, setMeets] = useState<number[][] | undefined>(undefined);
  return (
    <BracketSheetEditor
      advancePerGroup={2}
      bestLosers={bestLosers}
      pairings={pairings}
      meets={meets}
      testId="sheet"
      onChange={(patch) => {
        if (patch.pairings) setPairings(patch.pairings);
        if ("meets" in patch) setMeets(patch.meets === null ? undefined : patch.meets);
      }}
    />
  );
}

const pick = (testId: string, optionName: string): void => {
  fireEvent.click(within(screen.getByTestId(testId)).getByRole("button"));
  fireEvent.click(screen.getByRole("option", { name: optionName }));
};

describe("BracketSheetEditor", () => {
  it("opens on a legal sheet and says how many groups it implies", () => {
    render(<Harness />);
    expect(screen.queryByTestId("sheet-problems")).toBeNull();
    expect(screen.getByText("3 groups")).toBeInTheDocument();
  });

  it("lets the organizer seat a best loser against a group winner", () => {
    render(<Harness initial={[["A1", "C2"], ["A2", "C1"], ["B1", "L2"], ["B2", "L1"]]} />);
    pick("sheet-slot-0-1", "Best Non-Qualifier 1");
    // A1 v L1 is now written; the sheet flags L1's old seat as empty-handed.
    pick("sheet-slot-3-1", "Group C runner-up");
    expect(screen.queryByTestId("sheet-problems")).toBeNull();
  });

  it("names the qualifier left with no match", () => {
    render(<Harness />);
    // Seat Group A's winner twice: whoever held that seat is now homeless,
    // and the sheet says which one rather than only that something is wrong.
    const displaced = screen.getByTestId("sheet-slot-1-0").textContent ?? "";
    pick("sheet-slot-1-0", "Group A winner");
    const problems = screen.getByTestId("sheet-problems").textContent ?? "";
    expect(problems).toContain("Seated twice: A1");
    expect(displaced).toContain("Group B winner");
    expect(problems).toContain("Never plays: B1");
  });

  it("refuses a bracket size the qualifiers cannot fill", () => {
    render(<Harness bestLosers={1} />);
    expect(
      screen.getByText("That many matches cannot be filled by the teams advancing."),
    ).toBeInTheDocument();
  });

  it("keeps the plain tree until the organizer chooses the crossings", () => {
    render(<Harness />);
    expect(screen.getByText("M1 plays M2, M3 plays M4, and so on.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("sheet-meets-toggle"));
    pick("sheet-meet-0-1", "Winner of M3");
    pick("sheet-meet-1-0", "Winner of M2");
    // 1 v 3 and 2 v 4: every match named once, so nothing is flagged.
    expect(screen.queryByTestId("sheet-problems")).toBeNull();
  });
});
