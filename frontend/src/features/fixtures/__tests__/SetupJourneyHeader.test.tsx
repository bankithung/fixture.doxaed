import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetupJourneyHeader } from "../SetupJourneyHeader";

describe("SetupJourneyHeader", () => {
  it("renders the four steps with Clashes & sessions as the optional step 2", () => {
    // readiness step 2 = "no draw yet" → required pointer is "How each plays" (3)
    render(<SetupJourneyHeader step={2} />);
    expect(screen.getByText("When & where")).toBeInTheDocument();
    expect(screen.getByText("Clashes & sessions")).toBeInTheDocument();
    expect(screen.getByText("How each competition plays")).toBeInTheDocument();
    expect(screen.getByText("Preview & publish")).toBeInTheDocument();
    expect(screen.getByText("(optional)")).toBeInTheDocument();
    expect(screen.getByTestId("journey-next")).toHaveTextContent(
      "Next: set any clashes (optional), then choose how each competition plays.",
    );
    // step 1 done (check, no number); 2 optional; 3 current; 4 upcoming
    expect(screen.getByTestId("journey-step-1")).not.toHaveTextContent("1");
    expect(screen.getByTestId("journey-step-2")).toHaveTextContent("2");
    expect(screen.getByTestId("journey-step-3")).toHaveTextContent("3");
    expect(screen.getByTestId("journey-step-4")).toHaveTextContent("4");
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

  it("highlights steps 3 and 4 together in the mixed state", () => {
    render(<SetupJourneyHeader step={3} />);
    expect(screen.getByTestId("journey-step-3")).toHaveTextContent("3");
    expect(screen.getByTestId("journey-step-4")).toHaveTextContent("4");
    expect(screen.getByTestId("journey-next")).toHaveTextContent(
      "Next: preview the schedule and publish it.",
    );
  });

  it("the optional clashes step is not clickable until the gate is passed", () => {
    const onStepClick = vi.fn();
    const { rerender } = render(
      <SetupJourneyHeader step={1} onStepClick={onStepClick} />,
    );
    // gate not done yet → clashes (2) and later steps are upcoming/disabled
    expect(screen.getByTestId("journey-step-2")).toBeDisabled();
    rerender(<SetupJourneyHeader step={2} onStepClick={onStepClick} />);
    expect(screen.getByTestId("journey-step-2")).not.toBeDisabled();
  });

  it("completed, current and optional steps deep-link; upcoming steps do not", async () => {
    const onStepClick = vi.fn();
    render(<SetupJourneyHeader step={2} onStepClick={onStepClick} />);
    expect(screen.getByTestId("journey-step-4")).toBeDisabled();
    await userEvent.click(screen.getByTestId("journey-step-1"));
    expect(onStepClick).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByTestId("journey-step-2"));
    expect(onStepClick).toHaveBeenCalledWith(2);
    await userEvent.click(screen.getByTestId("journey-step-3"));
    expect(onStepClick).toHaveBeenCalledWith(3);
  });

  it("page-nav mode: completed steps tick, the active page is current, every step navigates", async () => {
    const onStepClick = vi.fn();
    // On the formats page (activeStep 3); steps 1 & 2 are actually complete.
    render(
      <SetupJourneyHeader
        step={2}
        activeStep={3}
        doneSteps={{ 1: true, 2: true }}
        onStepClick={onStepClick}
      />,
    );
    // completed steps render a check (no number); current/upcoming show numbers
    expect(screen.getByTestId("journey-step-1")).not.toHaveTextContent("1");
    expect(screen.getByTestId("journey-step-2")).not.toHaveTextContent("2");
    expect(screen.getByTestId("journey-step-3")).toHaveTextContent("3");
    expect(screen.getByTestId("journey-step-4")).toHaveTextContent("4");
    // these are PAGES — even an upcoming step navigates (no gating)
    expect(screen.getByTestId("journey-step-4")).not.toBeDisabled();
    await userEvent.click(screen.getByTestId("journey-step-4"));
    expect(onStepClick).toHaveBeenCalledWith(4);
  });

  it("an optional step 2 that isn't configured shows as optional, not ticked", () => {
    // formats page again, but no clash rules set → step 2 is not done.
    render(
      <SetupJourneyHeader step={2} activeStep={3} doneSteps={{ 1: true }} />,
    );
    // step 2 still shows its number (optional, awaiting config), step 1 ticks
    expect(screen.getByTestId("journey-step-1")).not.toHaveTextContent("1");
    expect(screen.getByTestId("journey-step-2")).toHaveTextContent("2");
  });

  it("renders the single current-step label for mobile", () => {
    render(<SetupJourneyHeader step={2} />);
    expect(
      screen.getByText("Step 3 of 4: How each competition plays"),
    ).toBeInTheDocument();
  });
});
