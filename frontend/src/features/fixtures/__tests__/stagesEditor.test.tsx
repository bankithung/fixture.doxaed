import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { StagesEditor } from "../StagesEditor";
import {
  blankStage,
  validateStages,
  type Stage,
} from "../stagesModel";

describe("stagesModel", () => {
  it("flags a knockout that isn't last and an over-advance", () => {
    const groups = { ...blankStage("round_robin", true), id: "g", group_size: 4 };
    const ko = { ...blankStage("knockout", false), id: "k" };
    expect(validateStages([groups, ko])).toEqual({}); // groups → knockout is fine
    // knockout before another stage → error on the knockout
    expect(Object.keys(validateStages([ko, groups]))).toContain("k");
    // advance 4 out of a group of 4 → error
    const ko2: Stage = { ...ko, from: { advance_per_group: 4, advance_best_thirds: 0, seeding: "cross" } };
    expect(Object.keys(validateStages([groups, ko2]))).toContain("k");
  });
});

function Harness(): React.ReactElement {
  const [stages, setStages] = useState<Stage[]>([]);
  return (
    <>
      <div data-testid="count">{stages.length}</div>
      <StagesEditor testId="st" stages={stages} onChange={setStages} />
    </>
  );
}

describe("StagesEditor", () => {
  it("adds a group stage then a knockout, with a qualification connector", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("st-add")); // first → round_robin
    expect(screen.getByTestId("count")).toHaveTextContent("1");
    expect(screen.getByTestId("st-card-0-group-size")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("st-add")); // second → knockout
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    // the connector ("Top N of each group advance") appears between them
    expect(screen.getByTestId("st-connector-1")).toBeInTheDocument();
    expect(screen.getByTestId("st-connector-1-advance")).toHaveValue(2);

    // adding past a terminal knockout is blocked
    expect(screen.getByTestId("st-add")).toBeDisabled();
  });

  it("sets the group's min-matches-per-team", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByTestId("st-add"));
    const mm = screen.getByTestId("st-card-0-min-matches");
    await userEvent.type(mm, "3");
    expect(mm).toHaveValue(3);
  });
});
