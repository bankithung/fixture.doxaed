import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TiebreakerControl } from "../TiebreakerControl";
import {
  availableCriteria,
  defaultTiebreakers,
  moveItem,
  tbLabel,
} from "../tiebreakers";

describe("tiebreaker helpers", () => {
  it("offers sport-aware defaults and criteria", () => {
    expect(defaultTiebreakers({ type: "sets", best_of: 3, points: 11 })).toEqual([
      "points", "head_to_head", "set_difference", "point_difference", "points_for", "coin_toss",
    ]);
    expect(defaultTiebreakers({ type: "goals" })).toContain("goal_difference");
    expect(availableCriteria({ type: "goals" })).not.toContain("set_difference");
    expect(availableCriteria({ type: "sets", best_of: 3, points: 11 })).toContain("point_difference");
  });

  it("labels and moves items", () => {
    expect(tbLabel("coin_toss")).toBe("Coin toss (referee draw)");
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]); // no-op at edge
  });
});

const SET: { type: "sets"; best_of: number; points: number } = {
  type: "sets", best_of: 3, points: 11,
};

describe("TiebreakerControl", () => {
  it("shows the recommended order and reorders on demand", async () => {
    const onChange = vi.fn();
    render(<TiebreakerControl testId="tb" value={null} scoring={SET} onChange={onChange} />);
    expect(screen.getByTestId("tb-summary")).toHaveTextContent("Head-to-head");
    await userEvent.click(screen.getByTestId("tb-toggle"));
    await userEvent.click(screen.getByTestId("tb-down-head_to_head"));
    expect(onChange).toHaveBeenCalledWith([
      "points", "set_difference", "head_to_head", "point_difference", "points_for", "coin_toss",
    ]);
  });

  it("removes a criterion and resets an override", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TiebreakerControl
        testId="tb"
        value={["points", "head_to_head", "point_difference", "coin_toss"]}
        scoring={SET}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByTestId("tb-toggle"));
    await userEvent.click(screen.getByTestId("tb-remove-point_difference"));
    expect(onChange).toHaveBeenCalledWith(["points", "head_to_head", "coin_toss"]);
    // an override exposes Reset → clears back to the recommended order
    rerender(
      <TiebreakerControl testId="tb" value={["points", "coin_toss"]} scoring={SET} onChange={onChange} />,
    );
    await userEvent.click(screen.getByTestId("tb-reset"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
