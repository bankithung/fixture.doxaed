import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetupJourneyHeader } from "../SetupJourneyHeader";

describe("SetupJourneyHeader", () => {
  it("renders the three steps with the current-step next line", () => {
    render(<SetupJourneyHeader step={2} />);
    expect(screen.getByText("When & where")).toBeInTheDocument();
    expect(screen.getByText("How each competition plays")).toBeInTheDocument();
    expect(screen.getByText("Preview & publish")).toBeInTheDocument();
    expect(screen.getByTestId("journey-next")).toHaveTextContent(
      "Next: choose how each competition plays.",
    );
    // step 1 done (check, no number), step 2 current, step 3 upcoming
    expect(screen.getByTestId("journey-step-1")).not.toHaveTextContent("1");
    expect(screen.getByTestId("journey-step-2")).toHaveTextContent("2");
    expect(screen.getByTestId("journey-step-3")).toHaveTextContent("3");
  });

  it("step 1 says set dates and venues; done celebrates", () => {
    const { rerender } = render(<SetupJourneyHeader step={1} />);
    expect(screen.getByTestId("journey-next")).toHaveTextContent(
      "Next: set your tournament dates and venues.",
    );
    rerender(<SetupJourneyHeader step="done" />);
    expect(screen.getByTestId("journey-next")).toHaveTextContent(
      "All set. Your schedule is published.",
    );
  });

  it("highlights steps 2 and 3 together in the mixed state", () => {
    render(<SetupJourneyHeader step={3} />);
    // step 1 done; 2 and 3 both render their numbers (current ring)
    expect(screen.getByTestId("journey-step-2")).toHaveTextContent("2");
    expect(screen.getByTestId("journey-step-3")).toHaveTextContent("3");
    expect(screen.getByTestId("journey-next")).toHaveTextContent(
      "Next: preview the schedule and publish it.",
    );
  });

  it("completed and current steps deep-link back; upcoming steps do not", async () => {
    const onStepClick = vi.fn();
    render(<SetupJourneyHeader step={2} onStepClick={onStepClick} />);
    expect(screen.getByTestId("journey-step-3")).toBeDisabled();
    await userEvent.click(screen.getByTestId("journey-step-1"));
    expect(onStepClick).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByTestId("journey-step-2"));
    expect(onStepClick).toHaveBeenCalledWith(2);
  });

  it("renders the single current-step label for mobile", () => {
    render(<SetupJourneyHeader step={2} />);
    expect(
      screen.getByText("Step 2 of 3: How each competition plays"),
    ).toBeInTheDocument();
  });
});
