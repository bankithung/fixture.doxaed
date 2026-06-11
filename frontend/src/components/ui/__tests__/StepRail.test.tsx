import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepRail } from "../StepRail";

const STEPS = [
  { key: "a", label: "Calendar" },
  { key: "b", label: "Venues" },
  { key: "c", label: "Review" },
];

describe("StepRail", () => {
  it("renders every step label and numbers upcoming steps", () => {
    render(<StepRail steps={STEPS} current={1} />);
    expect(screen.getByText("Calendar")).toBeInTheDocument();
    expect(screen.getByText("Venues")).toBeInTheDocument();
    expect(screen.getByText("Review")).toBeInTheDocument();
    // current + upcoming show their 1-based number; done steps a check icon
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("1")).not.toBeInTheDocument();
  });

  it("complete marks every step done", () => {
    render(<StepRail steps={STEPS} current={0} complete />);
    expect(screen.queryByText("1")).not.toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });
});
