import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScoringControl } from "../ScoringControl";
import { blankSets, cleanScoring, scoringSummary } from "../scoring";

describe("scoring helpers", () => {
  it("summarises sets, goals and the inherited default", () => {
    expect(scoringSummary(null)).toBe("Sport default");
    expect(scoringSummary({ type: "goals" })).toBe("Timed (goals)");
    expect(
      scoringSummary({ type: "sets", best_of: 3, points: 15, win_by: 2, cap: 17 }),
    ).toBe("Best of 3 · 15 pts · cap 17");
  });

  it("blankSets seeds from the inherited baseline", () => {
    expect(blankSets({ type: "sets", best_of: 5, points: 21, win_by: 2, cap: 25 })).toEqual({
      type: "sets", best_of: 5, points: 21, win_by: 2, cap: 25,
    });
    // a goals baseline still yields generic set defaults
    expect(blankSets({ type: "goals" }).best_of).toBe(3);
  });

  it("cleanScoring clamps positives and drops a blank cap", () => {
    // 0 is treated as "blank" → the default (3 sets); negatives clamp to 1.
    expect(
      cleanScoring({ type: "sets", best_of: 0, points: -2, win_by: 0, cap: null }),
    ).toEqual({ type: "sets", best_of: 3, points: 1, win_by: 1, cap: null });
    expect(cleanScoring({ type: "goals", points: 9 } as never)).toEqual({ type: "goals" });
  });
});

describe("ScoringControl", () => {
  it("shows the inherited summary and opens the editor", async () => {
    const onChange = vi.fn();
    render(
      <ScoringControl
        testId="sc"
        value={null}
        inherited={{ type: "sets", best_of: 3, points: 21, win_by: 2, cap: null }}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("sc-summary")).toHaveTextContent("Best of 3 · 21 pts");
    await userEvent.click(screen.getByTestId("sc-toggle"));
    expect(screen.getByTestId("sc-best-of")).toBeInTheDocument();
  });

  it("switching to Timed emits a goals rule; Reset clears the override", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ScoringControl
        testId="sc"
        value={{ type: "sets", best_of: 3, points: 15, win_by: 2, cap: 17 }}
        inherited={{ type: "sets", best_of: 3, points: 21, win_by: 2, cap: null }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByTestId("sc-toggle"));
    await userEvent.click(screen.getByTestId("sc-type-goals"));
    expect(onChange).toHaveBeenCalledWith({ type: "goals" });
    // an explicit override shows a Reset that clears back to the sport default
    rerender(
      <ScoringControl
        testId="sc"
        value={{ type: "goals" }}
        inherited={{ type: "sets", best_of: 3, points: 21, win_by: 2, cap: null }}
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByTestId("sc-reset"));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
